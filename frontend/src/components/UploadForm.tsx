import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createMeeting } from "../api/meetings";

interface ParticipantDraft {
  id: string;
  name: string;
}

// These IDs are React keys only; backend assigns persistent participant UUIDs.
// A counter also works on plain HTTP LAN origins where randomUUID is unavailable.
let nextParticipantId = 0;

function createParticipant(): ParticipantDraft {
  return {
    id: `participant-${++nextParticipantId}`,
    name: "",
  };
}

export function UploadForm() {
  const navigate = useNavigate();
  const isMockMode = import.meta.env.VITE_USE_MOCK === "true";
  const [title, setTitle] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [participants, setParticipants] = useState<ParticipantDraft[]>(() => [
    createParticipant(),
  ]);
  const configuredLimit = Number(import.meta.env.VITE_MAX_UPLOAD_MB || 200);
  const maxUploadMb = Number.isFinite(configuredLimit) && configuredLimit > 0 ? configuredLimit : 200;
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  function updateParticipant(id: string, name: string) {
    setParticipants((current) =>
      current.map((participant) =>
        participant.id === id ? { ...participant, name } : participant,
      ),
    );
  }

  function removeParticipant(id: string) {
    setParticipants((current) =>
      current.filter((participant) => participant.id !== id),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) { setError("Выберите аудиофайл."); return; }
    if (!/\.(wav|mp3|m4a)$/i.test(file.name)) {
      setError("Выберите запись в формате WAV, MP3 или M4A."); return;
    }
    if (file.size === 0 || file.size > maxUploadMb * 1024 * 1024) {
      setError(`Файл должен быть непустым и не больше ${maxUploadMb} МБ.`); return;
    }
    if (!title.trim() || participants.some(({ name }) => !name.trim())) {
      setError("Заполните название и имена участников."); return;
    }
    const startedDate = new Date(startedAt);
    if (Number.isNaN(startedDate.getTime())) {
      setError("Укажите дату и время совещания."); return;
    }
    setSubmitting(true);
    setError("");
    try {
      if (isMockMode) {
        navigate("/meetings/demo", { state: { audioUrl: URL.createObjectURL(file) } }); return;
      }
      const result = await createMeeting({
        title: title.trim(),
        started_at: startedDate.toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        participants: participants.map(({ name }) => ({ name: name.trim() })),
        file,
      });
      navigate(`/meetings/${encodeURIComponent(result.id)}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить запись.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="upload-form">
      <label>
        Название совещания
        <input
          type="text"
          value={title}
          maxLength={255}
          onChange={(event) => setTitle(event.target.value)}
          required
        />
      </label>

      <label>
        Дата и время
        <input
          type="datetime-local"
          value={startedAt}
          onChange={(event) => setStartedAt(event.target.value)}
          required
        />
      </label>

      <fieldset>
        <legend>Участники</legend>

        {participants.map((participant, index) => (
          <div key={participant.id}>
            <label>
              Участник {index + 1}
              <input
                type="text"
                value={participant.name}
                maxLength={255}
                onChange={(event) =>
                  updateParticipant(participant.id, event.target.value)
                }
                required
              />
            </label>

            {participants.length > 1 && (
              <button
                type="button"
                onClick={() => removeParticipant(participant.id)}
              >
                Удалить
              </button>
            )}
          </div>
        ))}

        <button
          type="button"
          disabled={participants.length >= 200}
          onClick={() =>
            setParticipants((current) => [...current, createParticipant()])
          }
        >
          Добавить участника
        </button>
      </fieldset>

      <label>
        Запись совещания
        <input
          type="file"
          accept=".wav,.mp3,.m4a,audio/wav,audio/mpeg,audio/mp4"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          required
        />
      </label>

      <p className="muted">WAV, MP3 или M4A, до {maxUploadMb} МБ.</p>

      {error && <p role="alert" className="form-error">{error}</p>}
      <button type="submit" className="primary-button" disabled={submitting}>{submitting ? "Загружаем…" : "Обработать совещание"}</button>
    </form>
  );
}
