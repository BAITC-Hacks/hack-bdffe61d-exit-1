export type MeetingStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed";

export interface Participant {
  id: string;
  name: string;
}

export interface SpeakerMapping {
  label: string;
  participant_id: string | null;
}

export interface TranscriptSegment {
  id: string;
  speaker: string | null;
  start_ms: number;
  end_ms: number;
  text: string;
}

export interface ActionItem {
  id: string;
  text: string;
  assignee_id: string | null;
  due_date: string | null;
  needs_review: boolean;
  review_reason: string | null;
  source_segment_ids: string[];
}

export interface Meeting {
  id: string;
  title: string;
  started_at: string;
  timezone: string;
  status: MeetingStatus;
  error: string | null;
  confirmed_at: string | null;
  summary: string | null;
  participants: Participant[];
  speakers: SpeakerMapping[];
  segments: TranscriptSegment[];
  action_items: ActionItem[];
  audio_url?: string | null;
}

export interface MeetingListItem {
  id: string;
  title: string;
  started_at: string;
  status: MeetingStatus;
  confirmed_at: string | null;
}

export interface MeetingListResponse {
  items: MeetingListItem[];
}

export interface CreateMeetingResponse {
  id: string;
  status: MeetingStatus;
}
