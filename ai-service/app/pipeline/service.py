from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from app.config import Settings
from app.pipeline.asr import FasterWhisperASR
from app.pipeline.dates import resolve_due_date
from app.pipeline.diarization import PyannoteDiarizer
from app.pipeline.llm import OllamaExtractor
from app.pipeline.merge import merge_asr_with_speakers
from app.pipeline.mock import mock_response
from app.pipeline.speakers import identify_speakers
from app.schemas import ActionItem, MeetingMeta, ProcessingMeta, ProcessResponse
from app.timing import timed_stage


class MeetingPipeline:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.asr = FasterWhisperASR(settings)
        self.diarizer = PyannoteDiarizer(settings)
        self.extractor = OllamaExtractor(settings)

    def process(self, audio_path: Path, meta: MeetingMeta) -> ProcessResponse:
        if self.settings.mode == "mock":
            with timed_stage("mock", meta.meeting_id):
                return mock_response(meta, self.settings)

        try:
            with timed_stage("asr", meta.meeting_id):
                asr_result = self.asr.transcribe(audio_path)
        finally:
            if self.settings.low_memory_mode:
                self.asr.unload()
        try:
            with timed_stage("diarization", meta.meeting_id):
                turns = self.diarizer.diarize(audio_path)
                segments = merge_asr_with_speakers(asr_result.segments, turns)
        finally:
            if self.settings.low_memory_mode:
                self.diarizer.unload()
        with timed_stage("speaker_identification", meta.meeting_id):
            speakers = identify_speakers(segments, meta)
        with timed_stage("llm", meta.meeting_id):
            extraction = self.extractor.extract(segments, meta)
        with timed_stage("deadline_resolution", meta.meeting_id):
            action_items = [
                ActionItem(
                    id=index,
                    text=item.text,
                    assignee_participant_id=(
                        item.assignee_participant_id
                        or _participant_mentioned(item.text, meta)
                        or _participant_for_speaker(item.assignee_speaker_label, speakers)
                    ),
                    assignee_speaker_label=item.assignee_speaker_label,
                    due_date=resolve_due_date(item.due_text_raw, meta.meeting_date),
                    due_text_raw=item.due_text_raw,
                    evidence_segment_ids=item.evidence_segment_ids,
                )
                for index, item in enumerate(extraction.action_items)
            ]
        return ProcessResponse(
            meeting_id=meta.meeting_id,
            status="ok",
            language_detected=_language_label(asr_result.language, segments),
            duration_ms=asr_result.duration_ms,
            segments=segments,
            speakers=speakers,
            summary=extraction.summary,
            action_items=action_items,
            processing_meta=ProcessingMeta(
                asr_model=self.settings.asr_model,
                diarization_model=self.settings.diarization_model,
                processed_at=datetime.now(ZoneInfo(meta.timezone)),
                model_version=self.settings.model_version,
            ),
        )


def _language_label(asr_language: str, segments) -> str:
    text = " ".join(segment.text for segment in segments)
    has_kazakh_letters = bool(re.search(r"[әіңғүұқөһ]", text, re.IGNORECASE))
    if has_kazakh_letters and asr_language in {"ru", "kk"}:
        return "mixed-ru-kk"
    return asr_language or "unknown"


def _participant_for_speaker(speaker_label: str | None, speakers) -> str | None:
    if speaker_label is None or speaker_label not in speakers:
        return None
    return speakers[speaker_label].participant_id


def _participant_mentioned(text: str, meta: MeetingMeta) -> str | None:
    """Conservatively resolve a named assignee when the LLM leaves the id empty."""
    normalized = " ".join(text.casefold().replace("ё", "е").split())
    matches: list[str] = []
    for participant in meta.participants:
        name = " ".join(participant.name.casefold().replace("ё", "е").split())
        first_name = name.split()[0]
        if name in normalized or (
            len(first_name) > 2 and re.search(rf"\b{re.escape(first_name)}\b", normalized)
        ):
            matches.append(participant.id)
    return matches[0] if len(set(matches)) == 1 else None
