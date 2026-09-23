from __future__ import annotations

from pathlib import Path

from app.errors import ServiceError

ALLOWED_EXTENSIONS = {".wav", ".mp3", ".m4a"}


def validate_audio(filename: str | None, data: bytes, max_bytes: int) -> str:
    if not filename:
        raise ServiceError("AUDIO_FILENAME_MISSING", "audio filename is required")
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_EXTENSIONS:
        raise ServiceError(
            "UNSUPPORTED_AUDIO_FORMAT",
            "supported audio formats are wav, mp3 and m4a",
            context={"filename": filename},
        )
    if not data:
        raise ServiceError("EMPTY_AUDIO", "uploaded audio file is empty")
    if len(data) > max_bytes:
        raise ServiceError(
            "AUDIO_TOO_LARGE",
            f"audio exceeds the configured limit of {max_bytes // (1024 * 1024)} MB",
            status_code=413,
        )
    valid_magic = {
        ".wav": len(data) >= 12 and data[:4] in {b"RIFF", b"RF64"} and data[8:12] == b"WAVE",
        ".mp3": data[:3] == b"ID3"
        or (len(data) >= 2 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0),
        ".m4a": len(data) >= 12 and data[4:8] == b"ftyp",
    }[suffix]
    if not valid_magic:
        raise ServiceError(
            "CORRUPTED_AUDIO",
            f"file content does not match the {suffix[1:]} container",
        )
    return suffix
