import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useParams } from "react-router-dom";
import { confirmMeeting, exportMeetingDocx, getMeeting, getMeetingAudio, updateActionItem, updateSpeaker } from "../api/meetings";
import { AudioPlayer, type AudioPlayerHandle } from "../components/AudioPlayer";
import { ProcessingStatus } from "../components/ProcessingStatus";
import { Summary } from "../components/Summary";
import { TasksTable } from "../components/TasksTable";
import { Transcript } from "../components/Transcript";
import demoMeeting from "../mocks/meeting.json";
import type { ActionItem, Meeting, SpeakerMapping, TranscriptSegment } from "../types/meeting";
import { downloadBlob, formatDate } from "../utils/format";

type NavigationState = { audioUrl?: string } | null;

export function MeetingPage() {
  const { id = "" } = useParams();
  const isDemo = id === "demo";
  const location = useLocation();
  const audioFromUpload = (location.state as NavigationState)?.audioUrl;
  const [meeting, setMeeting] = useState<Meeting | null>(isDemo ? structuredClone(demoMeeting) as Meeting : null);
  const [loading, setLoading] = useState(!isDemo);
  const [pageError, setPageError] = useState("");
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<"confirm" | "export" | null>(null);
  const [backendAudioUrl, setBackendAudioUrl] = useState<string>();
  const audioRef = useRef<AudioPlayerHandle>(null);

  useEffect(() => {
    if (isDemo) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const result = await getMeeting(id, controller.signal);
        if (controller.signal.aborted) return;
        setMeeting(result);
        setLoading(false);
        setPageError("");
        if (result.status === "queued" || result.status === "running") timer = setTimeout(poll, 2000);
      } catch (cause) {
        if (controller.signal.aborted) return;
        setPageError(cause instanceof Error ? `${cause.message} Повторим запрос через 2 секунды.` : "Не удалось загрузить совещание. Повторим запрос через 2 секунды.");
        timer = setTimeout(poll, 2000);
      }
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [id, isDemo]);

  useEffect(() => {
    if (isDemo || meeting?.status !== "completed" || audioFromUpload || meeting.audio_url) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    async function loadAudio() {
      try {
        const blob = await getMeetingAudio(id, controller.signal);
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setBackendAudioUrl(objectUrl);
      } catch {
        // The protocol remains usable if its audio file is unavailable.
      }
    }
    void loadAudio();
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, isDemo, meeting?.status, meeting?.audio_url, audioFromUpload]);

  const audioSrc = audioFromUpload || meeting?.audio_url || backendAudioUrl;

  function sourceSegment(item: ActionItem): TranscriptSegment | undefined {
    return item.source_segment_ids.map((segmentId) => meeting?.segments.find((segment) => segment.id === segmentId)).find(Boolean);
  }

  function showSegment(segment: TranscriptSegment) {
    setHighlightedId(segment.id);
    requestAnimationFrame(() => {
      const element = document.getElementById(`segment-${segment.id}`);
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
      element?.focus({ preventScroll: true });
    });
  }

  function showSource(item: ActionItem) {
    const segment = sourceSegment(item);
    if (segment) showSegment(segment);
    else setPageError("Исходная реплика не найдена в транскрипте.");
  }

  async function playSegment(segment: TranscriptSegment) {
    showSegment(segment);
    try { await audioRef.current?.playSegment(segment); }
    catch { setPageError("Не удалось воспроизвести запись. Проверьте аудиофайл."); }
  }

  async function saveItem(item: ActionItem) {
    if (!meeting) return;
    const updated = isDemo
      ? { ...item, needs_review: !item.assignee_id || !item.due_date, review_reason: item.assignee_id && item.due_date ? null : item.review_reason }
      : await updateActionItem(id, item);
    setMeeting((current) => current && ({ ...current, confirmed_at: null, action_items: current.action_items.map((entry) => entry.id === item.id ? updated : entry) }));
  }

  async function changeSpeaker(speaker: SpeakerMapping, participantId: string) {
    if (!meeting) return;
    const updated = { ...speaker, participant_id: participantId || null };
    setMeeting((current) => current && ({ ...current, speakers: current.speakers.map((entry) => entry.label === speaker.label ? updated : entry) }));
    if (isDemo) return;
    try { await updateSpeaker(id, updated); setPageError(""); }
    catch (cause) {
      setMeeting((current) => current && ({ ...current, speakers: current.speakers.map((entry) => entry.label === speaker.label ? speaker : entry) }));
      setPageError(cause instanceof Error ? cause.message : "Не удалось сохранить говорящего.");
    }
  }

  async function confirm() {
    if (!meeting || meeting.confirmed_at) return;
    setBusy("confirm");
    setPageError("");
    try {
      if (isDemo) setMeeting({ ...meeting, confirmed_at: new Date().toISOString() });
      else setMeeting(await confirmMeeting(id));
    } catch (cause) { setPageError(cause instanceof Error ? cause.message : "Не удалось подтвердить протокол."); }
    finally { setBusy(null); }
  }

  async function download() {
    if (!meeting?.confirmed_at) return;
    setBusy("export");
    setPageError("");
    try {
      let blob: Blob;
      if (isDemo) {
        const { Document, Packer, Paragraph, HeadingLevel } = await import("docx");
        const lines = [
          new Paragraph({ text: meeting.title, heading: HeadingLevel.TITLE }),
          new Paragraph({ text: `Дата: ${formatDate(meeting.started_at, true, meeting.timezone)}` }),
          new Paragraph({ text: "Участники", heading: HeadingLevel.HEADING_1 }),
          ...meeting.participants.map((person) => new Paragraph({ text: person.name, bullet: { level: 0 } })),
          new Paragraph({ text: "Краткое содержание", heading: HeadingLevel.HEADING_1 }),
          new Paragraph({ text: meeting.summary || "Краткое содержание не указано." }),
          new Paragraph({ text: "Поручения", heading: HeadingLevel.HEADING_1 }),
          ...meeting.action_items.map((item) => new Paragraph({ text: `${item.text} — ${meeting.participants.find((person) => person.id === item.assignee_id)?.name || "Требует уточнения"}; срок: ${formatDate(item.due_date)}`, bullet: { level: 0 } })),
        ];
        blob = await Packer.toBlob(new Document({ sections: [{ children: lines }] }));
      } else blob = await exportMeetingDocx(id);
      downloadBlob(blob, `protocol-${id}.docx`);
    } catch (cause) { setPageError(cause instanceof Error ? cause.message : "Не удалось скачать DOCX."); }
    finally { setBusy(null); }
  }

  return (
    <main className="page-shell meeting-page">
      <nav className="top-nav" aria-label="Основная навигация"><Link className="brand" to="/">AlemProtocol</Link><Link to="/">Новое совещание</Link></nav>
      {isDemo && <p className="demo-badge" role="status">DEMO / MOCK MODE</p>}
      {loading && <div className="panel loading-panel" role="status">Загружаем протокол…</div>}
      {pageError && <div className="error-banner" role="alert">{pageError}</div>}
      {!loading && !meeting && <section className="panel"><h1>Совещание не найдено</h1><p>Проверьте ссылку или вернитесь к загрузке записи.</p><Link to="/">На главную</Link></section>}
      {meeting && <>
        <header className="meeting-header">
          <div><p className="eyebrow">Протокол совещания</p><h1>{meeting.title}</h1><p className="meeting-date">{formatDate(meeting.started_at, true, meeting.timezone)}</p></div>
          <div className="header-status"><span className={`document-badge ${meeting.confirmed_at ? "is-confirmed" : ""}`}>{meeting.confirmed_at ? "Подтверждён" : "Черновик"}</span><ProcessingStatus status={meeting.status} error={meeting.error} /></div>
        </header>
        {meeting.status === "completed" && <>
          <div className="meeting-actions"><button type="button" className="primary-button" onClick={confirm} disabled={!!meeting.confirmed_at || busy !== null}>{busy === "confirm" ? "Подтверждаем…" : meeting.confirmed_at ? "Протокол подтверждён" : "Подтвердить протокол"}</button>
            <button type="button" onClick={download} disabled={!meeting.confirmed_at || busy !== null} title={!meeting.confirmed_at ? "Сначала подтвердите протокол" : undefined}>{busy === "export" ? "Готовим DOCX…" : "Скачать DOCX"}</button></div>
          <div className="overview-grid"><Summary text={meeting.summary} />
            <section className="panel" aria-labelledby="participants-heading"><div className="section-heading"><p className="eyebrow">Команда</p><h2 id="participants-heading">Участники</h2></div>
              {meeting.participants.length === 0 ? <p className="empty-state">Участники не указаны.</p> : <ul className="participant-list">{meeting.participants.map((person) => <li key={person.id}>{person.name}</li>)}</ul>}
              {meeting.speakers.length > 0 && <div className="speaker-mappings"><h3>Кто говорит в записи</h3>{meeting.speakers.map((speaker) => <label key={speaker.label}>{speaker.label}<select value={speaker.participant_id || ""} onChange={(event) => void changeSpeaker(speaker, event.target.value)} disabled={!!meeting.confirmed_at}><option value="">Не определён</option>{meeting.participants.map((person) => <option value={person.id} key={person.id}>{person.name}</option>)}</select></label>)}</div>}
            </section></div>
          <TasksTable items={meeting.action_items} participants={meeting.participants} editable={!meeting.confirmed_at} hasAudio={!!audioSrc} onSave={saveItem} onShowSource={showSource} onPlaySource={(item) => { const segment = sourceSegment(item); if (segment) void playSegment(segment); }} />
          <AudioPlayer ref={audioRef} src={audioSrc} />
          <Transcript meeting={meeting} highlightedId={highlightedId} hasAudio={!!audioSrc} onPlay={(segment) => void playSegment(segment)} />
        </>}
      </>}
    </main>
  );
}
