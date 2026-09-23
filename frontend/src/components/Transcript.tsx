import type { Meeting, TranscriptSegment } from "../types/meeting";
import { formatTime } from "../utils/format";

interface Props {
  meeting: Meeting;
  highlightedId: string | null;
  hasAudio: boolean;
  onPlay: (segment: TranscriptSegment) => void;
}

export function Transcript({ meeting, highlightedId, hasAudio, onPlay }: Props) {
  function speakerName(label: string | null): string {
    if (!label) return "Не определён";
    const mapping = meeting.speakers.find((speaker) => speaker.label === label);
    return meeting.participants.find((person) => person.id === mapping?.participant_id)?.name || label;
  }

  return (
    <section className="panel" aria-labelledby="transcript-heading">
      <div className="section-heading"><p className="eyebrow">Первоисточник</p><h2 id="transcript-heading">Транскрипт</h2></div>
      {meeting.segments.length === 0 ? <p className="empty-state">Транскрипт пока пуст.</p> :
        <ol className="transcript-list">
          {meeting.segments.map((segment) => (
            <li key={segment.id} id={`segment-${segment.id}`} tabIndex={-1}
              className={`transcript-segment${highlightedId === segment.id ? " is-highlighted" : ""}`}>
              <div className="segment-meta">
                <span className="segment-time">{formatTime(segment.start_ms)}</span>
                <strong>{speakerName(segment.speaker)}</strong>
              </div>
              <p>{segment.text}</p>
              {hasAudio && <button className="text-button" type="button" onClick={() => onPlay(segment)}
                aria-label={`Прослушать реплику ${speakerName(segment.speaker)} с ${formatTime(segment.start_ms)}`}>
                Прослушать реплику
              </button>}
            </li>
          ))}
        </ol>}
    </section>
  );
}
