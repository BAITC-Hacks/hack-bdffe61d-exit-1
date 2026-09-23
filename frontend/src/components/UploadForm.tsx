import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { createMeeting } from "../api/meetings";

interface ParticipantDraft {
  id: string;
  name: string;
}

function createParticipant(): ParticipantDraft {
  return {
    id: crypto.randomUUID(),
    name: "",
  };
}

export function UploadForm() {
  const navigate = useNavigate();
  const isMockMode = import.meta.env.VITE_USE_MOCK === "true";
  const [title, setTitle] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [participants, setParticipants] = useState<ParticipantDraft[]>([
    createParticipant(),
  ]);
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
    setSubmitting(true);
    setError("");
    try {
      const audioUrl = URL.createObjectURL(file);
      if (isMockMode) { navigate("/meetings/demo", { state: { audioUrl } }); return; }
      try {
        const result = await createMeeting({
          title: title.trim(),
          started_at: new Date(startedAt).toISOString(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          participants: participants.map(({ name }) => ({ name: name.trim() })),
          file,
        });
        navigate(`/meetings/${encodeURIComponent(result.id)}`, { state: { audioUrl } });
      } catch (cause) { URL.revokeObjectURL(audioUrl); throw cause; }
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
          accept="audio/*"
          onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          required
        />
      </label>

      {error && <p role="alert" className="form-error">{error}</p>}
      <button type="submit" className="primary-button" disabled={submitting}>{submitting ? "Загружаем…" : "Обработать совещание"}</button>
    </form>
  );
}
