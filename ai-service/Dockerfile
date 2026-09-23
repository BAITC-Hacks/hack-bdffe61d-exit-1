FROM python:3.11.11-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models/huggingface \
    XDG_CACHE_HOME=/models/cache

RUN apt-get update \
    && apt-get install --no-install-recommends -y ffmpeg libsndfile1 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /service
COPY requirements.txt requirements-ml.txt ./
RUN pip install --upgrade pip==25.0.1 && pip install -r requirements-ml.txt

ENV PYANNOTE_CACHE=/models/huggingface/hub

COPY app ./app
COPY scripts ./scripts
RUN useradd --create-home --uid 10001 appuser && mkdir -p /models && chown -R appuser:appuser /models /service
USER appuser

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
