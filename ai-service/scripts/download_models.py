from __future__ import annotations

import argparse
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Pre-cache all Hugging Face model weights")
    parser.add_argument("--model-dir", type=Path, default=Path("models"))
    parser.add_argument("--hf-token", default=os.getenv("HF_TOKEN"))
    parser.add_argument("--asr-model", default="Systran/faster-whisper-large-v3")
    args = parser.parse_args()
    if not args.hf_token:
        parser.error("--hf-token or HF_TOKEN is required for the gated pyannote model")

    cache_dir = args.model_dir.resolve() / "huggingface" / "hub"
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(cache_dir.parent)
    os.environ["PYANNOTE_CACHE"] = str(cache_dir)

    from huggingface_hub import snapshot_download

    print(f"Caching ASR model {args.asr_model} in {cache_dir}")
    snapshot_download(repo_id=args.asr_model, cache_dir=cache_dir, token=args.hf_token)

    print("Caching pyannote pipeline and its dependent segmentation/embedding models")
    for repo_id in (
        "pyannote/speaker-diarization-3.1",
        "pyannote/segmentation-3.0",
        "pyannote/wespeaker-voxceleb-resnet34-LM",
    ):
        print(f"Caching {repo_id}")
        snapshot_download(repo_id=repo_id, cache_dir=cache_dir, token=args.hf_token)

    from pyannote.audio import Pipeline

    pipeline = Pipeline.from_pretrained(
        "pyannote/speaker-diarization-3.1",
        use_auth_token=args.hf_token,
        cache_dir=cache_dir,
    )
    if pipeline is None:
        raise RuntimeError(
            "pyannote model download failed. Verify that the HF token has access to both "
            "pyannote/speaker-diarization-3.1 and pyannote/segmentation-3.0."
        )
    print("Model cache is ready. Set HF_HUB_OFFLINE=1 for inference.")


if __name__ == "__main__":
    main()
