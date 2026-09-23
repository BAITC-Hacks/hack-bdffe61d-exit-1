"""HTTP transport and adapter for the separately deployed Hackalem AI service."""

import json
from datetime import date
from pathlib import Path
from typing import Any, Literal
from uuid import UUID

import httpx
from pydantic import BaseModel, Field, ValidationError

from ..config import settings

AI_AUDIO_TYPES = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}


class AIServiceError(RuntimeError):
    """A safe, actionable error that can be shown in the meeting status."""


class RemoteSpeaker(BaseModel):
    participant_id: UUID | None = None


class RemoteSegment(BaseModel):
    id: int = Field(ge=0)
    speaker: str
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    text: str


class RemoteAction(BaseModel):
    text: str = Field(min_length=1)
    assignee_participant_id: UUID | None = None
    assignee_speaker_label: str | None = None
    due_date: date | None = None
    due_text_raw: str | None = None
    evidence_segment_ids: list[int] = Field(default_factory=list)


class RemoteResponse(BaseModel):
    meeting_id: UUID
    status: Literal["ok"]
    summary: str
    speakers: dict[str, RemoteSpeaker]
    segments: list[RemoteSegment]
    action_items: list[RemoteAction]


def adapt_response(payload: Any, *, meeting_id: str) -> dict[str, Any]:
    result = RemoteResponse.model_validate(payload)
    if result.meeting_id != UUID(meeting_id):
        raise AIServiceError("ИИ вернул результат другого совещания.")

    actions = []
    for action in result.action_items:
        if (
            action.assignee_speaker_label is not None
            and action.assignee_speaker_label not in result.speakers
        ):
            raise AIServiceError("ИИ вернул поручение с неизвестным спикером.")
        assignee_id = action.assignee_participant_id
        if assignee_id is None and action.assignee_speaker_label is not None:
            assignee_id = result.speakers[action.assignee_speaker_label].participant_id
        reasons = []
        if assignee_id is None:
            reasons.append("Не определён ответственный")
        if action.due_date is None:
            reasons.append("Срок требует проверки" if action.due_text_raw else "Срок не указан")
        if not action.evidence_segment_ids:
            reasons.append("Нет ссылки на фрагмент записи")
        actions.append({
            "text": action.text,
            "assignee_id": assignee_id,
            "due_date": action.due_date,
            "deadline_text": action.due_text_raw,
            "needs_review": bool(reasons),
            "review_reason": "; ".join(reasons) or None,
            "source_segment_indexes": action.evidence_segment_ids,
        })

    return {
        "summary": result.summary,
        "speakers": [
            {"label": label, "participant_id": speaker.participant_id}
            for label, speaker in result.speakers.items()
        ],
        "segments": [
            {
                "segment_index": segment.id,
                "speaker_label": segment.speaker,
                "start_ms": segment.start_ms,
                "end_ms": segment.end_ms,
                "text": segment.text,
            }
            for segment in result.segments
        ],
        "action_items": actions,
    }


def request_processing(*, audio_path: str | None, meta: dict[str, Any]) -> dict[str, Any]:
    if not audio_path or not Path(audio_path).is_file():
        raise AIServiceError("Аудиофайл недоступен worker. Проверьте STORAGE_DIR и файл.")
    path = Path(audio_path)
    media_type = AI_AUDIO_TYPES.get(path.suffix.lower())
    if media_type is None:
        raise AIServiceError("ИИ принимает WAV, MP3 и M4A. Загрузите запись в одном из этих форматов.")

    headers = {}
    if settings.ai_internal_token and settings.ai_internal_token.get_secret_value():
        headers["X-Internal-Token"] = settings.ai_internal_token.get_secret_value()
    url = str(settings.ai_base_url).rstrip("/") + "/internal/process"
    timeout = httpx.Timeout(settings.ai_timeout_seconds, connect=10.0)
    try:
        # Send bytes, not a local path: the AI laptop has no access to backend storage.
        # Ignore OS proxy variables for this private service-to-service connection.
        with path.open("rb") as audio, httpx.Client(timeout=timeout, trust_env=False) as client:
            response = client.post(
                url,
                headers=headers,
                files={"audio": (path.name, audio, media_type)},
                data={"meta": json.dumps(meta, ensure_ascii=False)},
            )
        response.raise_for_status()
    except httpx.TimeoutException as exc:
        raise AIServiceError("ИИ не ответил вовремя. Проверьте сервис и AI_TIMEOUT_SECONDS.") from exc
    except httpx.HTTPStatusError as exc:
        code = exc.response.status_code
        messages = {
            401: "ИИ отклонил токен. Сверьте AI_INTERNAL_TOKEN и INTERNAL_TOKEN.",
            404: "Не найден /internal/process. Проверьте AI_BASE_URL и порт ИИ.",
            413: "Аудио превышает MAX_AUDIO_MB на стороне ИИ.",
            422: "ИИ отклонил аудио или метаданные. Проверьте файл и логи ИИ.",
        }
        raise AIServiceError(messages.get(code, f"Ошибка ИИ HTTP {code}. Проверьте логи ИИ.")) from exc
    except httpx.RequestError as exc:
        raise AIServiceError("Нет связи с ИИ. Проверьте AI_BASE_URL, сеть, порт и запуск сервиса.") from exc

    try:
        return adapt_response(response.json(), meeting_id=meta["meeting_id"])
    except (ValueError, ValidationError) as exc:
        raise AIServiceError("ИИ вернул некорректный JSON или несовместимый формат ответа.") from exc
