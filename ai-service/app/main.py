from __future__ import annotations

import json
import logging
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import Depends, FastAPI, File, Form, Header, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError
from starlette.concurrency import run_in_threadpool

from app.audio import validate_audio
from app.config import Settings
from app.errors import ServiceError
from app.exporters import export_docx, export_pdf
from app.pipeline.service import MeetingPipeline
from app.schemas import MeetingMeta, ProcessResponse

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("ai_service")


def create_app(settings: Settings | None = None) -> FastAPI:
    resolved_settings = settings or Settings.from_env()
    pipeline = MeetingPipeline(resolved_settings)

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        if resolved_settings.mode == "real":
            try:
                await run_in_threadpool(pipeline.extractor.ensure_model_available)
            except ServiceError as exc:
                logger.critical("startup_check_failed code=%s message=%s", exc.code, exc.message)
                raise
            logger.info(
                "startup_check_completed component=ollama model=%s",
                resolved_settings.llm_model,
            )
        yield

    app = FastAPI(
        title="Hackalem Meeting AI Service",
        version="0.1.0",
        description="Offline ASR, speaker diarization and meeting action-item extraction.",
        lifespan=lifespan,
    )
    app.state.settings = resolved_settings
    app.state.pipeline = pipeline

    @app.exception_handler(ServiceError)
    async def service_error_handler(_: Request, exc: ServiceError) -> JSONResponse:
        logger.warning("service_error code=%s message=%s", exc.code, exc.message)
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": {"code": exc.code, "message": exc.message, "context": exc.context}},
        )

    @app.exception_handler(RequestValidationError)
    async def request_validation_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
        errors = [
            {
                "location": list(error.get("loc", ())),
                "message": error.get("msg", "invalid value"),
                "type": error.get("type", "validation_error"),
            }
            for error in exc.errors()
        ]
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": "request validation failed",
                    "context": {"errors": errors},
                }
            },
        )

    def authorize(
        x_internal_token: Annotated[str | None, Header(alias="X-Internal-Token")] = None,
    ) -> None:
        expected = resolved_settings.internal_token
        if expected and x_internal_token != expected:
            raise ServiceError("UNAUTHORIZED", "invalid internal service token", status_code=401)

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok", "mode": resolved_settings.mode}

    @app.post(
        "/internal/process",
        response_model=ProcessResponse,
        dependencies=[Depends(authorize)],
    )
    async def process_meeting(
        audio: Annotated[UploadFile, File(description="WAV, MP3 or M4A meeting audio")],
        meta: Annotated[str, Form(description="MeetingMeta JSON string")],
    ) -> ProcessResponse:
        parsed_meta = _parse_meta(meta)
        max_bytes = resolved_settings.max_audio_mb * 1024 * 1024
        audio_bytes = await audio.read(max_bytes + 1)
        await audio.close()
        suffix = validate_audio(audio.filename, audio_bytes, max_bytes)
        with tempfile.TemporaryDirectory(prefix="meeting-ai-") as temporary_directory:
            audio_path = Path(temporary_directory) / f"input{suffix}"
            audio_path.write_bytes(audio_bytes)
            return await run_in_threadpool(pipeline.process, audio_path, parsed_meta)

    @app.post(
        "/internal/export/{document_format}",
        dependencies=[Depends(authorize)],
        responses={
            200: {
                "content": {
                    "application/pdf": {},
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {},
                }
            }
        },
    )
    async def export_protocol(
        document_format: Literal["pdf", "docx"], protocol: ProcessResponse
    ) -> Response:
        if document_format == "pdf":
            content = await run_in_threadpool(export_pdf, protocol)
            media_type = "application/pdf"
        else:
            content = await run_in_threadpool(export_docx, protocol)
            media_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        filename = quote(f"protocol-{protocol.meeting_id}.{document_format}")
        return Response(
            content=content,
            media_type=media_type,
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{filename}"},
        )

    return app


def _parse_meta(raw: str) -> MeetingMeta:
    try:
        return MeetingMeta.model_validate_json(raw)
    except (ValidationError, json.JSONDecodeError) as exc:
        if isinstance(exc, ValidationError):
            details = [
                {"location": list(item["loc"]), "message": item["msg"], "type": item["type"]}
                for item in exc.errors()
            ]
        else:
            details = [{"message": str(exc)}]
        raise ServiceError(
            "INVALID_META",
            "meta must be valid JSON matching the MeetingMeta schema",
            status_code=422,
            context={"errors": details},
        ) from exc


app = create_app()
