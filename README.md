# AlemProtocol

> Сервис, который превращает запись совещания в структурированный протокол: распознаёт речь,
> разделяет участников, формирует краткое содержание и выделяет поручения со сроками.

![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-0.115-009688?logo=fastapi&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10–3.12-3776AB?logo=python&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)

AlemProtocol создан для автоматизации протоколирования русскоязычных и казахскоязычных
совещаний. Обработка может выполняться полностью локально: аудиозапись и текст не передаются во
внешние AI API.

## Возможности

- загрузка записей в WAV, MP3 и M4A;
- распознавание русской, казахской и смешанной речи через `faster-whisper`;
- диаризация и разделение реплик по спикерам через `pyannote.audio`;
- генерация саммари и списка поручений локальной моделью Qwen через Ollama;
- определение исполнителей и преобразование сроков из естественного языка в даты;
- привязка поручений к фрагментам транскрипта и исходной аудиозаписи;
- редактирование и подтверждение готового протокола;
- экспорт результата в DOCX и PDF;
- mock-режим для демонстрации интерфейса без GPU и ML-моделей.

## Архитектура

```text
┌──────────────────────┐       ┌──────────────────────┐
│ React + TypeScript   │ HTTP  │ Backend API          │
│ загрузка и протокол  ├──────►│ встречи и документы  │
└──────────────────────┘       └──────────┬───────────┘
                                         │ internal HTTP
                                         ▼
                              ┌────────────────────────┐
                              │ FastAPI AI service     │
                              │ Whisper → pyannote     │
                              │ → Qwen → PDF / DOCX    │
                              └────────────────────────┘
```

Frontend и AI-сервис находятся в ветке `main`. Backend разрабатывается в ветке
[`backend`](https://github.com/BAITC-Hacks/hack-bdffe61d-exit-1/tree/backend/backend), а совместная
сборка frontend и backend — в ветке
[`integration`](https://github.com/BAITC-Hacks/hack-bdffe61d-exit-1/tree/integration).

## Быстрый запуск интерфейса

Для демонстрации backend не нужен: frontend по умолчанию использует тестовые данные.

Требования: Node.js 20.19+ или 22.12+ и npm.

```bash
git clone https://github.com/BAITC-Hacks/hack-bdffe61d-exit-1.git
cd hack-bdffe61d-exit-1/frontend
npm ci
npm run dev
```

Откройте [http://localhost:5173](http://localhost:5173) и выберите «Открыть демо» или загрузите
аудиофайл. В mock-режиме данные берутся из `frontend/src/mocks/meeting.json`, а выбранная запись
остаётся только в памяти браузера.

## Запуск AI-сервиса

По умолчанию сервис стартует в mock-режиме и не требует моделей или GPU.

### С Python

Требования: Python 3.10–3.12.

```bash
cd ai-service
python -m venv .venv
```

Активируйте окружение:

```bash
# Linux/macOS
source .venv/bin/activate

# Windows PowerShell
.venv\Scripts\Activate.ps1
```

Установите зависимости и запустите сервис:

```bash
pip install -r requirements.txt
cp .env.example .env  # Windows: Copy-Item .env.example .env
python -m uvicorn app.main:app --env-file .env --host 0.0.0.0 --port 8000
```

После запуска доступны:

- Swagger UI: [http://localhost:8000/docs](http://localhost:8000/docs);
- проверка состояния: `GET http://localhost:8000/health`;
- обработка записи: `POST http://localhost:8000/internal/process`.

### С Docker Compose

```bash
cd ai-service
cp .env.example .env  # Windows: Copy-Item .env.example .env
docker compose up --build
```

Подготовка моделей, GPU-запуск и полностью offline-конфигурация подробно описаны в
[`ai-service/README.md`](ai-service/README.md).

## Подключение frontend к backend

Создайте `frontend/.env` на основе примера и отключите mock-режим:

```dotenv
VITE_USE_MOCK=false
VITE_API_BASE_URL=http://localhost:8000
```

После изменения переменных перезапустите Vite. Полный HTTP-контракт frontend описан в
[`frontend/README.md`](frontend/README.md).

Если AI-сервис и backend запущены на разных компьютерах, используйте инструкцию
[`CONNECT_TWO_LAPTOPS.md`](CONNECT_TWO_LAPTOPS.md). Значение `INTERNAL_TOKEN` должно совпадать на
обеих машинах.

## Основные переменные окружения

| Переменная | Значение по умолчанию | Назначение |
| --- | --- | --- |
| `VITE_USE_MOCK` | `true` | Использовать демонстрационные данные во frontend |
| `VITE_API_BASE_URL` | `http://localhost:8000` | Базовый URL backend API |
| `AI_MODE` | `mock` | Режим AI-сервиса: `mock` или `real` |
| `AI_PORT` | `8000` | Порт AI-сервиса в Docker |
| `ASR_DEVICE` | `auto` | Устройство для ASR: `auto`, `cpu` или `cuda` |
| `LOW_MEMORY_MODE` | `0` | Выгружать ML-модели между стадиями обработки |
| `MAX_AUDIO_MB` | `500` | Максимальный размер аудиофайла |
| `INTERNAL_TOKEN` | пусто | Защита внутренних эндпоинтов заголовком `X-Internal-Token` |

Все параметры AI-сервиса перечислены в
[`ai-service/.env.example`](ai-service/.env.example), параметры frontend — в
[`frontend/.env.example`](frontend/.env.example).

## Структура репозитория

```text
.
├── frontend/                  # React-приложение
│   ├── src/api/               # клиент backend API
│   ├── src/components/        # компоненты интерфейса
│   ├── src/pages/             # страницы загрузки и протокола
│   └── tests/                 # браузерный smoke-тест
├── ai-service/                # изолированный FastAPI AI-сервис
│   ├── app/pipeline/          # ASR, диаризация, LLM и обработка сроков
│   ├── scripts/               # загрузка моделей и генерация тестового аудио
│   └── tests/                 # unit и API-тесты
└── CONNECT_TWO_LAPTOPS.md     # схема запуска на двух компьютерах
```

## Проверка проекта

Frontend:

```bash
cd frontend
npm ci
npm run lint
npm run build
npm run smoke
```

Smoke-тест использует установленный Microsoft Edge в headless-режиме.

AI-сервис:

```bash
cd ai-service
pip install -r requirements-dev.txt
pytest
ruff check app tests scripts
```

Тесты AI-сервиса работают без ML-весов и проверяют API-контракт, обработку ошибок, определение
сроков, объединение таймкодов и экспорт документов.

## Безопасность и приватность

- `.env`, локальные модели, виртуальные окружения, аудиозаписи и артефакты обработки исключены из
  Git;
- в рабочем окружении задайте непустой `INTERNAL_TOKEN` и не публикуйте внутренний AI-эндпоинт в
  интернете;
- для закрытого контура используйте offline-режим Hugging Face и заранее подготовленные модели;
- реальные записи совещаний не следует добавлять в репозиторий даже при тестировании.

---

Проект разработан командой **Exit 1** для хакатона BAITC Hacks.
