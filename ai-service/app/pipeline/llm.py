from __future__ import annotations

import json

import httpx
from pydantic import ValidationError

from app.config import Settings
from app.errors import ServiceError
from app.schemas import LLMExtraction, MeetingMeta, TranscriptSegment

SYSTEM_PROMPT = """Ты анализируешь протокол совещания на русском, казахском или смешанном языке.
Верни только JSON по переданной схеме. Не придумывай поручения, ответственных или сроки.
Каждое поручение должно быть конкретным действием, а evidence_segment_ids — содержать id
сегментов, прямо подтверждающих поручение. assignee_participant_id бери только из списка
участников. Сохраняй исходную формулировку срока в due_text_raw; абсолютную дату не вычисляй.
Если участник назван ответственным или к нему напрямую обращено поручение, обязательно заполни
его assignee_participant_id идентификатором из списка participants. Если в подтверждающем сегменте
есть срок (например, «завтра», «ертең», «к пятнице», «жұмаға дейін»), due_text_raw не может
быть null.
Если данных нет, используй null или пустой список."""


class OllamaExtractor:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def ensure_model_available(self) -> None:
        """Fail fast when Ollama is unreachable or the configured model is absent."""
        try:
            response = httpx.get(f"{self.settings.ollama_url}/api/tags", timeout=10)
            response.raise_for_status()
            available = {
                model.get("name") or model.get("model")
                for model in response.json().get("models", [])
            }
        except (httpx.HTTPError, KeyError, TypeError, ValueError) as exc:
            raise ServiceError(
                "OLLAMA_UNAVAILABLE",
                f"cannot query Ollama at '{self.settings.ollama_url}': {exc}",
                status_code=503,
            ) from exc

        if self.settings.llm_model not in available:
            listed = ", ".join(sorted(name for name in available if name)) or "none"
            raise ServiceError(
                "LLM_MODEL_UNAVAILABLE",
                f"Ollama model '{self.settings.llm_model}' is not installed; available: {listed}",
                status_code=503,
            )

    def extract(self, segments: list[TranscriptSegment], meta: MeetingMeta) -> LLMExtraction:
        segment_ids = {segment.id for segment in segments}
        speaker_labels = {segment.speaker for segment in segments}
        participant_ids = {participant.id for participant in meta.participants}
        payload = {
            "meeting_date": meta.meeting_date.isoformat(),
            "timezone": meta.timezone,
            "participants": [participant.model_dump() for participant in meta.participants],
            "transcript": [segment.model_dump() for segment in segments],
        }
        correction = ""
        last_error = ""
        for attempt in range(self.settings.llm_retries + 1):
            user_prompt = (
                "Извлеки краткое саммари и поручения из входных данных:\n"
                + json.dumps(payload, ensure_ascii=False)
                + correction
            )
            try:
                response = httpx.post(
                    f"{self.settings.ollama_url}/api/chat",
                    json={
                        "model": self.settings.llm_model,
                        "stream": False,
                        "keep_alive": 0,
                        "format": LLMExtraction.model_json_schema(),
                        "options": {"temperature": 0},
                        "messages": [
                            {"role": "system", "content": SYSTEM_PROMPT},
                            {"role": "user", "content": user_prompt},
                        ],
                    },
                    timeout=180,
                )
                response.raise_for_status()
                content = response.json()["message"]["content"]
                extracted = LLMExtraction.model_validate_json(content)
                self._validate_references(extracted, segment_ids, speaker_labels, participant_ids)
                return extracted
            except (httpx.HTTPError, KeyError, ValueError, ValidationError) as exc:
                last_error = str(exc)
                correction = (
                    "\nПредыдущий ответ не прошел валидацию. Исправь JSON. Ошибка: "
                    + last_error[:800]
                )
                if attempt >= self.settings.llm_retries:
                    break
        raise ServiceError(
            "LLM_EXTRACTION_FAILED",
            f"local LLM did not return valid structured output: {last_error}",
            status_code=502,
        )

    @staticmethod
    def _validate_references(
        extracted: LLMExtraction,
        segment_ids: set[int],
        speaker_labels: set[str],
        participant_ids: set[str],
    ) -> None:
        for item in extracted.action_items:
            if item.assignee_participant_id not in participant_ids | {None}:
                raise ValueError(f"unknown participant id: {item.assignee_participant_id}")
            if item.assignee_speaker_label not in speaker_labels | {None}:
                raise ValueError(f"unknown speaker label: {item.assignee_speaker_label}")
            unknown_segments = set(item.evidence_segment_ids) - segment_ids
            if unknown_segments:
                raise ValueError(f"unknown evidence segment ids: {sorted(unknown_segments)}")
