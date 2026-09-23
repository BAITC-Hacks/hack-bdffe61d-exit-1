# Hackalem AI Service

## Подключение к бэкенду на другом ноутбуке

Пошаговая инструкция находится в `CONNECT_TWO_LAPTOPS.md` в корне архива.
Бэкенд обращается к `http://IP_НОУТБУКА_С_ИИ:8000/internal/process`.
В Docker порт уже опубликован. Для запуска без Docker из этой папки используйте:

```powershell
python -m uvicorn app.main:app --env-file .env --host 0.0.0.0 --port 8000
```

`--env-file .env` нужен при запуске через Python: `Settings.from_env()` читает
переменные окружения и самостоятельно не загружает `.env`.
Если файла `.env` ещё нет, создайте его из `.env.example`.
Для работающего реального ИИ сохраните свои текущие настройки и модели.

Изолированный HTTP-сервис автопротоколирования совещаний. Аудио и текст не передаются во внешние
API: ASR, диаризация и LLM запускаются локально. По умолчанию включен `mock`-режим, чтобы backend
мог сразу зафиксировать контракт и начать интеграцию без GPU и многогигабайтных весов.

## Архитектура

```text
multipart audio + meta
        |
        v
валидация контейнера и MeetingMeta
        |
        v
faster-whisper -> pyannote 3.1 -> merge по overlap -> Ollama/Qwen
        |                                                   |
        +-----------------> speaker labels                  v
                                            правила ru/kk для сроков
                                                        |
                                                        v
                                      ProcessResponse + PDF/DOCX
```

- `faster-whisper large-v3` выбран как устойчивый multilingual ASR для русской, казахской и
  смешанной речи. Он работает через CTranslate2 и обычно быстрее reference Whisper.
- `pyannote/speaker-diarization-3.1` дает локальную диаризацию; соответствие голоса участнику
  заполняется только при явном self-ID в начале записи. В остальных случаях возвращается
  `participant_id: null`, но `SPEAKER_XX` сохраняется.
- `Qwen2.5 7B Instruct` через Ollama — компактный локальный вариант с хорошим RU/KK и structured
  output. Ответ валидируется Pydantic; при ошибке выполняется до двух повторов.
- Сроки сначала извлекаются LLM без выдумывания абсолютной даты, затем детерминированно
  преобразуются относительно `meeting_date` (`сегодня`, `к пятнице`, `до конца недели`, `ертең`,
  `3 күннен кейін` и явные даты).

## Быстрый запуск mock-контракта

```bash
cd ai-service
docker compose up --build
```

Swagger: `http://localhost:8000/docs`, healthcheck: `GET http://localhost:8000/health`.

Без Docker (Python 3.10–3.12):

```bash
python -m venv .venv
# Linux/macOS: source .venv/bin/activate
# Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

## Запрос к `/internal/process`

```bash
curl -X POST http://localhost:8000/internal/process \
  -F 'audio=@samples/sample.wav;type=audio/wav' \
  -F 'meta={"meeting_id":"mtg_20260923_1400","meeting_date":"2026-09-23","timezone":"Asia/Almaty","participants":[{"id":"p1","name":"Даурен Ахметов"},{"id":"p2","name":"Айгерим Сериковна"}]}'
```

Сгенерировать технический WAV для проверки upload-контракта: `python scripts/generate_sample.py`.
Для реального сквозного прогона на Windows можно создать 57-секундный RU/KK-сэмпл с двумя
акустически различимыми голосами и явными поручениями:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/generate_e2e_sample.ps1
```

Результат сохраняется в `samples/meeting-ru-kk.wav`; скрипт использует локальный Windows TTS и
`ffmpeg`, не обращаясь к внешнему речевому API.

Пример ответа (сокращен):

```json
{
  "meeting_id": "mtg_20260923_1400",
  "status": "ok",
  "language_detected": "mixed-ru-kk",
  "duration_ms": 15000,
  "segments": [
    {"id": 0, "start_ms": 0, "end_ms": 5400, "speaker": "SPEAKER_00", "text": "..."}
  ],
  "speakers": {
    "SPEAKER_00": {"participant_id": "p1", "confidence": 0.99}
  },
  "summary": "Команда согласовала подготовку презентации.",
  "action_items": [
    {
      "id": 0,
      "text": "Подготовить финальную презентацию",
      "assignee_participant_id": "p1",
      "assignee_speaker_label": "SPEAKER_00",
      "due_date": "2026-09-25",
      "due_text_raw": "к пятнице",
      "evidence_segment_ids": [0]
    }
  ],
  "processing_meta": {
    "asr_model": "mock-asr",
    "diarization_model": "mock-diarization",
    "processed_at": "2026-09-23T14:00:00+05:00",
    "model_version": "hackalem-ai-0.1.0"
  }
}
```

Пустой/поврежденный файл, неверное расширение и невалидный `meta` дают понятный HTTP 422:
`{"error":{"code":"CORRUPTED_AUDIO","message":"...","context":{}}}`. Лимит размера дает 413.

## PDF и DOCX

Весь JSON ответа передается телом запроса:

```bash
curl -X POST http://localhost:8000/internal/export/pdf \
  -H 'Content-Type: application/json' --data-binary @result.json -o protocol.pdf
curl -X POST http://localhost:8000/internal/export/docx \
  -H 'Content-Type: application/json' --data-binary @result.json -o protocol.docx
```

Документы содержат саммари, таблицу поручений и читаемый транскрипт. PDF использует локальный
DejaVu Sans/Arial, поэтому кириллица встраивается без внешних ресурсов.

## Подготовка моделей и полностью offline-запуск

Скачивание выполняется однократно на машине с интернетом. Для gated-моделей pyannote сначала
примите условия репозиториев `pyannote/speaker-diarization-3.1` и `pyannote/segmentation-3.0` в
Hugging Face и создайте read token. Ни token, ни аудио сервису во время инференса не нужны.

```bash
pip install -r requirements-ml.txt
HF_TOKEN=hf_xxx python scripts/download_models.py --model-dir models
docker compose --profile download up hf-model-init ollama-model-init
```

Последняя команда — Docker-вариант подготовки и заменяет две предыдущие команды, если перед ней
задать `HF_TOKEN` в окружении. Оба init-контейнера завершаются после заполнения bind mount
`./models` и volume `ollama-models`.

После успешной подготовки перенесите каталог `models/` и Docker volume `ollama-models` в закрытый
контур. Создайте `.env` из `.env.example` и измените:

```dotenv
AI_MODE=real
HF_HUB_OFFLINE=1
TRANSFORMERS_OFFLINE=1
```

Запуск CPU: `docker compose up --build`. Запуск с NVIDIA Container Toolkit:

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up --build
```

Для vLLM вместо Ollama можно поднять OpenAI-compatible локальный сервер, но текущий адаптер ожидает
Ollama `/api/chat`; его замена изолирована в `app/pipeline/llm.py`.

> Важно: не запускайте download-profile внутри закрытого контура. Переменные offline по умолчанию
> равны `1`, поэтому inference не обращается в Hugging Face Hub.

## Конфигурация

Основные переменные перечислены в `.env.example`. `AI_MODE=mock|real`; `ASR_DEVICE=cpu|cuda|auto`;
для CPU обычно задают `ASR_COMPUTE_TYPE=int8`, для NVIDIA — `float16`. Необязательный
`INTERNAL_TOKEN` включает проверку заголовка `X-Internal-Token`. Файлы ограничены `MAX_AUDIO_MB`.

Каждая стадия пишет `elapsed_ms` в stdout: `asr`, `diarization`, `speaker_identification`, `llm` и
`deadline_resolution`. Это позволяет показать скорость на демо без отдельной системы метрик.

## Как переключиться между mock и реальным режимом

Режим задаётся одной переменной `AI_MODE`; допустимы только значения `mock` и `real`. При другом
значении сервис завершится с явной ошибкой конфигурации.

```dotenv
# Быстрый контракт без загрузки ML-моделей
AI_MODE=mock

# Полный локальный pipeline: faster-whisper -> pyannote -> Ollama
AI_MODE=real
```

После изменения `.env` пересоздайте контейнер и проверьте фактический режим:

```bash
docker compose up --build -d
curl http://localhost:8000/health
# {"status":"ok","mode":"real"}
```

В `real`-режиме startup-проверка обращается к Ollama `/api/tags`. Если `LLM_MODEL` отсутствует или
Ollama недоступен, контейнер пишет `LLM_MODEL_UNAVAILABLE`/`OLLAMA_UNAVAILABLE` до приёма запросов,
вместо позднего таймаута на стадии LLM. Проверить веса вручную можно командами:

```bash
docker exec ai-service-ollama-1 ollama list
docker compose --profile download run --build --rm hf-model-init
```

На машине с 8 GiB памяти включите `LOW_MEMORY_MODE=1`: Whisper и pyannote будут выгружаться после
своих стадий перед запуском Qwen, а native CPU allocations будут возвращены ОС. Это необходимо,
чтобы Qwen 7B поместился после pyannote. Цена режима — повторная загрузка весов на каждом запросе;
на GPU-сервере с достаточной памятью оставьте `LOW_MEMORY_MODE=0`.

## Известные ограничения

- `pyannote/speaker-diarization-3.1` и `pyannote/segmentation-3.0` являются gated-моделями. Нужно
  принять условия обоих репозиториев для владельца `HF_TOKEN`; подготовщик теперь завершается с
  ошибкой, если модель не выдана, и не сообщает ложное `cache ready`.
- На CPU cold start заметно медленнее длительности записи. Полный реальный прогон 57-секундного
  synthetic WAV на машине с лимитом Docker 7,6 GiB занял 257,3 с: ASR — 80,4 с, диаризация —
  42,0 с, speaker identification — 0,3 мс, Qwen 7B — 134,5 с, резолвинг сроков — 1,8 мс.
  Для демо запускайте запрос заранее либо используйте NVIDIA Container Toolkit.
- Windows synthetic TTS говорит по-казахски с русским акцентом. Такой сэмпл удобен для smoke-теста
  RU/KK-контракта, но не заменяет оценку WER/DER на записи носителей языка. В проверенном прогоне
  Whisper корректно распознал русские поручения, но казахские фразы частично транслитерировал и
  вернул язык `ru`; перед демо желательно проверить короткую запись носителей языка.
- Диаризация на synthetic TTS выдала два speaker label, но большинство реплик отнесла к
  `SPEAKER_00`; качество разделения нужно оценивать на записи двух реальных голосов.
- Текущий Linux wheel PyTorch включает CUDA-компоненты даже для CPU-запуска, поэтому Docker-образ
  получается крупным (около 10,6 GB). Это не влияет на inference, но CPU-only wheel уменьшит время
  первой сборки и размер образа.
- Привязка `SPEAKER_XX` к участнику консервативна: она выполняется по явному self-ID в начале
  записи. Без представления голос останется с честным `participant_id: null`.
- Детерминированный резолвер сроков покрывает частые формулировки RU/KK, но неоднозначные или
  редкие выражения оставляет с `due_date: null`, сохраняя исходный `due_text_raw`.

## Тесты

```bash
pip install -r requirements-dev.txt
pytest
ruff check app tests scripts
```

Тесты работают без ML-весов и проверяют multipart-контракт, ясные ошибки, резолвинг ru/kk сроков,
merge таймкодов, PDF и DOCX. Synthetic WAV — только транспортный тест; метрики WER/DER нужно считать
на согласованной локальной выборке реальных совещаний.
