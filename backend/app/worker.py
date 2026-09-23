import argparse
import logging
import time
from dataclasses import dataclass
from datetime import date
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal
from .models import ActionItem, Job, Meeting, Participant, Segment, Speaker
from .models.base import utc_now
from .services.ai_processor import MeetingProcessingResult, ProcessingParticipant, process_meeting
from .services.remote_ai import AIServiceError

logger = logging.getLogger(__name__)

POLL_INTERVAL_SECONDS = 1.0
MAX_ERROR_LENGTH = 255


@dataclass(frozen=True)
class ClaimedJob:
    job_id: UUID
    meeting_id: UUID
    audio_path: str | None
    meeting_date: date
    timezone: str
    participants: tuple[ProcessingParticipant, ...]


class WorkerStateError(RuntimeError):
    """Raised when a claimed job can no longer be completed safely."""


def claim_next_job() -> ClaimedJob | None:
    """Atomically claim the oldest queued job and release its lock on return."""

    with SessionLocal() as session:
        with session.begin():
            statement = (
                select(Job)
                .where(Job.status == "queued")
                .order_by(Job.created_at, Job.id)
                .limit(1)
                .with_for_update(skip_locked=True)
            )
            job = session.scalar(statement)
            if job is None:
                return None

            meeting = session.get(Meeting, job.meeting_id)
            if meeting is None:
                raise WorkerStateError("Claimed job has no meeting")

            participants = tuple(
                ProcessingParticipant(id=participant.id, name=participant.name)
                for participant in session.scalars(
                    select(Participant)
                    .where(Participant.meeting_id == meeting.id)
                    .order_by(Participant.created_at, Participant.id)
                ).all()
            )

            now = utc_now()
            job.status = "running"
            job.attempts += 1
            job.started_at = now
            job.finished_at = None
            job.error = None

            meeting.status = "running"
            meeting.error = None

            claimed_job = ClaimedJob(
                job_id=job.id,
                meeting_id=meeting.id,
                audio_path=meeting.audio_path,
                meeting_date=meeting.started_at.astimezone(ZoneInfo(meeting.timezone)).date(),
                timezone=meeting.timezone,
                participants=participants,
            )

        return claimed_job


def _load_running_job(session: Session, claimed_job: ClaimedJob) -> Job:
    statement = (
        select(Job)
        .where(Job.id == claimed_job.job_id, Job.status == "running")
        .with_for_update()
    )
    job = session.scalar(statement)
    if job is None or job.meeting_id != claimed_job.meeting_id:
        raise WorkerStateError("Job is no longer in the claimed running state")
    return job


def save_completed_result(
    claimed_job: ClaimedJob,
    result: MeetingProcessingResult,
) -> None:
    """Persist the complete processor result and final statuses atomically."""

    with SessionLocal() as session:
        with session.begin():
            job = _load_running_job(session, claimed_job)
            meeting = session.get(Meeting, claimed_job.meeting_id, with_for_update=True)
            if meeting is None or meeting.status != "running":
                raise WorkerStateError("Meeting is no longer in the running state")

            speakers_by_label: dict[str, Speaker] = {}
            for speaker_result in result.speakers:
                speaker = Speaker(
                    meeting_id=meeting.id,
                    label=speaker_result.label,
                    participant_id=speaker_result.participant_id,
                )
                session.add(speaker)
                speakers_by_label[speaker_result.label] = speaker
            session.flush()

            segments_by_index: dict[int, Segment] = {}
            for segment_result in result.segments:
                segment = Segment(
                    meeting_id=meeting.id,
                    speaker_id=speakers_by_label[segment_result.speaker_label].id,
                    segment_index=segment_result.segment_index,
                    start_ms=segment_result.start_ms,
                    end_ms=segment_result.end_ms,
                    text=segment_result.text,
                )
                session.add(segment)
                segments_by_index[segment_result.segment_index] = segment
            session.flush()

            for action_item_result in result.action_items:
                action_item = ActionItem(
                    meeting_id=meeting.id,
                    text=action_item_result.text,
                    assignee_id=action_item_result.assignee_id,
                    due_date=action_item_result.due_date,
                    deadline_text=action_item_result.deadline_text,
                    needs_review=action_item_result.needs_review,
                    review_reason=action_item_result.review_reason,
                    source_segments=[
                        segments_by_index[index]
                        for index in action_item_result.source_segment_indexes
                    ],
                )
                session.add(action_item)

            now = utc_now()
            meeting.summary = result.summary
            meeting.status = "completed"
            meeting.error = None

            job.status = "completed"
            job.finished_at = now
            job.error = None


def _safe_error(exc: Exception) -> str:
    if isinstance(exc, AIServiceError):
        return str(exc)[:MAX_ERROR_LENGTH]
    message = f"Worker processing failed ({type(exc).__name__})"
    return message[:MAX_ERROR_LENGTH]


def mark_failed(claimed_job: ClaimedJob, error: str) -> None:
    """Mark a still-running job and meeting failed in a fresh transaction."""

    with SessionLocal() as session:
        with session.begin():
            job = session.scalar(
                select(Job)
                .where(Job.id == claimed_job.job_id)
                .with_for_update()
            )
            if job is None or job.status != "running":
                logger.warning(
                    "Could not mark job %s failed because it is not running",
                    claimed_job.job_id,
                )
                return

            meeting = session.get(Meeting, claimed_job.meeting_id, with_for_update=True)
            now = utc_now()
            job.status = "failed"
            job.finished_at = now
            job.error = error

            if meeting is not None:
                meeting.status = "failed"
                meeting.error = error


def process_next_job() -> bool:
    """Claim and process one job, returning False when the queue is empty."""

    claimed_job = claim_next_job()
    if claimed_job is None:
        return False

    try:
        result = process_meeting(
            meeting_id=claimed_job.meeting_id,
            audio_path=claimed_job.audio_path,
            meeting_date=claimed_job.meeting_date,
            timezone=claimed_job.timezone,
            participants=claimed_job.participants,
        )
        save_completed_result(claimed_job, result)
    except Exception as exc:
        logger.exception("Worker failed while processing job %s", claimed_job.job_id)
        try:
            mark_failed(claimed_job, _safe_error(exc))
        except Exception:
            logger.exception("Worker could not persist failure for job %s", claimed_job.job_id)

    return True


def run_worker(*, once: bool = False) -> None:
    logger.info("HackAlem worker started")
    while True:
        try:
            processed = process_next_job()
        except Exception:
            logger.exception("Worker iteration failed before processing completed")
            processed = False

        if once:
            return
        if not processed:
            time.sleep(POLL_INTERVAL_SECONDS)


def main() -> None:
    parser = argparse.ArgumentParser(description="Process queued HackAlem meetings")
    parser.add_argument(
        "--once",
        action="store_true",
        help="Run one polling iteration and exit",
    )
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    run_worker(once=args.once)


if __name__ == "__main__":
    main()
