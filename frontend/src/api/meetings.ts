import type { ActionItem, CreateMeetingResponse, Meeting, MeetingListResponse, SpeakerMapping } from "../types/meeting";

const baseUrl = (import.meta.env.VITE_API_BASE_URL || "/api").replace(/\/$/, "");

async function fetchChecked(path: string, init?: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, init);
  } catch (cause) {
    if (init?.signal?.aborted) throw cause;
    throw new Error("Не удалось связаться с сервером. Проверьте подключение и повторите попытку.");
  }
  if (!response.ok) {
    let detail = "";
    try {
      const body = await response.json();
      detail = typeof body.detail === "string" ? body.detail : "";
    } catch { /* The server may return an empty error body. */ }
    throw new Error(detail || `Ошибка сервера (${response.status}). Попробуйте ещё раз.`);
  }
  return response;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetchChecked(path, init);
  const body = await response.text();
  return (body ? JSON.parse(body) : undefined) as T;
}

function jsonPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export interface NewMeeting {
  title: string;
  started_at: string;
  timezone: string;
  participants: { name: string }[];
  file: File;
}

export function createMeeting(input: NewMeeting): Promise<CreateMeetingResponse> {
  const form = new FormData();
  form.append("title", input.title);
  form.append("started_at", input.started_at);
  form.append("timezone", input.timezone);
  form.append("participants_json", JSON.stringify(input.participants));
  form.append("file", input.file);
  return request<CreateMeetingResponse>("/meetings", { method: "POST", body: form });
}

export function listMeetings(signal?: AbortSignal): Promise<MeetingListResponse> {
  return request<MeetingListResponse>("/meetings", { signal });
}

export function getMeeting(id: string, signal?: AbortSignal): Promise<Meeting> {
  return request<Meeting>(`/meetings/${encodeURIComponent(id)}`, { signal });
}

export function updateActionItem(meetingId: string, item: ActionItem): Promise<ActionItem> {
  return jsonPatch<ActionItem>(
    `/meetings/${encodeURIComponent(meetingId)}/tasks/${encodeURIComponent(item.id)}`,
    { text: item.text, assignee_id: item.assignee_id, due_date: item.due_date },
  );
}

export function updateSpeaker(meetingId: string, speaker: SpeakerMapping): Promise<unknown> {
  return jsonPatch<unknown>(
    `/meetings/${encodeURIComponent(meetingId)}/speakers`,
    { mappings: [{ speaker: speaker.label, participant_id: speaker.participant_id }] },
  );
}

export async function confirmMeeting(id: string): Promise<Meeting> {
  await request<unknown>(`/meetings/${encodeURIComponent(id)}/confirm`, { method: "POST" });
  return getMeeting(id);
}

export async function getMeetingAudio(id: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetchChecked(`/meetings/${encodeURIComponent(id)}/audio`, { signal });
  return response.blob();
}

export async function exportMeetingDocx(id: string): Promise<Blob> {
  const response = await fetchChecked(`/meetings/${encodeURIComponent(id)}/export?format=docx`);
  return response.blob();
}
