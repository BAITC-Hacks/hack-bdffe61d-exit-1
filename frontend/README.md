# AlemProtocol frontend

React, TypeScript и Vite интерфейс для загрузки записи совещания и просмотра протокола.

## Запуск

```powershell
npm.cmd install
npm.cmd run dev
```

В `.env` по умолчанию включён `VITE_USE_MOCK=true`. Загрузка файла открывает `/meetings/demo`; результат берётся из `src/mocks/meeting.json`. Загруженный в форме файл доступен в аудиоплеере до перезагрузки вкладки. Прямой переход на `/meetings/demo` тоже работает, но без аудиофайла. В демо правки и подтверждение хранятся в состоянии React, а DOCX создаётся в браузере.

Для подключения backend установите `VITE_USE_MOCK=false` и укажите `VITE_API_BASE_URL`, затем перезапустите Vite. Маршрут `/meetings/:id` загружает результат и повторяет `GET` каждые 2 секунды до `completed` или `failed`.

## Backend-контракт

| Метод | Путь | Действие |
| --- | --- | --- |
| `POST` | `/meetings` | multipart: `file`, `title`, `started_at` (ISO), `timezone`, `participants_json` (JSON-массив); ответ `{ id, status }` |
| `GET` | `/meetings` | список совещаний (`MeetingListResponse`) |
| `GET` | `/meetings/{id}` | объект `Meeting` из `src/types/meeting.ts` |
| `PATCH` | `/meetings/{id}/tasks/{task_id}` | JSON: `text: string`, `assignee_id: string \| null`, `due_date: string \| null` |
| `PATCH` | `/meetings/{id}/speakers` | JSON: `{ "mappings": [{ "speaker": string, "participant_id": string \| null }] }` |
| `POST` | `/meetings/{id}/confirm` | подтверждение протокола; после запроса frontend повторно получает `GET /meetings/{id}` |
| `GET` | `/meetings/{id}/audio` | аудиофайл (`Blob`) |
| `GET` | `/meetings/{id}/export?format=docx` | DOCX-файл |

Все пути собираются от `VITE_API_BASE_URL`. При разных origin backend должен разрешать CORS для адреса Vite. Для завершённого реального совещания интерфейс использует загруженный пользователем файл или `audio_url` из ответа. Если их нет, он получает аудио через `GET /meetings/{id}/audio` и освобождает временный object URL при уходе со страницы. Ошибка загрузки аудио не мешает просмотру протокола.

## Проверка

```powershell
npm.cmd run build
npm.cmd run lint
npm.cmd run smoke
```

`smoke` запускает установленный Microsoft Edge в headless-режиме. Он проверяет demo-сценарий, мобильную ширину 375 px, фокус клавиатуры и ответы API через локальную подмену запросов. Для теста `POST` запустите второй Vite-сервер с `VITE_USE_MOCK=false` и передайте его адрес в `REAL_TEST_URL`.
