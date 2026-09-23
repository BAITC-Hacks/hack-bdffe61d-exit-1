from __future__ import annotations

from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Participant(StrictModel):
    id: str = Field(min_length=1, max_length=128)
    name: str = Field(min_length=1, max_length=256)


class MeetingMeta(StrictModel):
    meeting_id: str = Field(min_length=1, max_length=256)
    meeting_date: date
    timezone: str
    participants: list[Participant] = Field(default_factory=list, max_length=200)

    @field_validator("timezone")
    @classmethod
    def timezone_exists(cls, value: str) -> str:
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError(f"unknown IANA timezone: {value}") from exc
        return value

    @model_validator(mode="after")
    def participant_ids_are_unique(self) -> MeetingMeta:
        ids = [participant.id for participant in self.participants]
        if len(ids) != len(set(ids)):
            raise ValueError("participant ids must be unique")
        return self


class TranscriptSegment(StrictModel):
    id: int = Field(ge=0)
    start_ms: int = Field(ge=0)
    end_ms: int = Field(ge=0)
    speaker: str = Field(pattern=r"^SPEAKER_\d{2,}$")
    text: str

    @model_validator(mode="after")
    def end_is_after_start(self) -> TranscriptSegment:
        if self.end_ms < self.start_ms:
            raise ValueError("end_ms must be greater than or equal to start_ms")
        return self


class SpeakerMatch(StrictModel):
    participant_id: str | None = None
    confidence: float | None = Field(default=None, ge=0, le=1)


class ActionItem(StrictModel):
    id: int = Field(ge=0)
    text: str = Field(min_length=1)
    assignee_participant_id: str | None = None
    assignee_speaker_label: str | None = None
    due_date: date | None = None
    due_text_raw: str | None = None
    evidence_segment_ids: list[int] = Field(default_factory=list)


class ProcessingMeta(StrictModel):
    asr_model: str
    diarization_model: str
    processed_at: datetime
    model_version: str


class ProcessResponse(StrictModel):
    meeting_id: str
    status: Literal["ok", "error"]
    language_detected: str
    duration_ms: int = Field(ge=0)
    segments: list[TranscriptSegment]
    speakers: dict[str, SpeakerMatch]
    summary: str
    action_items: list[ActionItem]
    processing_meta: ProcessingMeta


class ExtractedActionItem(StrictModel):
    text: str = Field(min_length=1)
    assignee_participant_id: str | None = None
    assignee_speaker_label: str | None = None
    due_text_raw: str | None = None
    evidence_segment_ids: list[int] = Field(default_factory=list)


class LLMExtraction(StrictModel):
    summary: str
    action_items: list[ExtractedActionItem] = Field(default_factory=list)
