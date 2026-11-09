/**
 * Wire types shared by the capture server and the phone page. Pure types and
 * helpers only: both tiers import this file.
 */

/** Where a meeting is on its way into the vault. */
export type MeetingStatus = "recording" | "queued" | "transcribing" | "failed" | "new" | "read";

/** One tab in the app: a recording in flight, or a transcript in the vault. */
export interface MeetingSummary {
  /** Recording id while in flight; vault slug once transcribed. */
  id: string;
  kind: "recording" | "transcript";
  title: string;
  /** ISO time recording started. */
  recorded: string;
  /** Seconds. */
  duration: number;
  status: MeetingStatus;
  error?: string;
}

export interface TranscriptPayload extends MeetingSummary {
  kind: "transcript";
  /** The note body: one `[hh:mm:ss] text` line per segment. */
  body: string;
}

export interface SessionState {
  /** True once the first passkey exists; `/setup` is closed after that. */
  setUp: boolean;
  signedIn: boolean;
  /** Signed in with a recovery code: only adding a passkey is allowed. */
  recovery: boolean;
  name: string | null;
}

export interface PasskeyInfo {
  id: string;
  name: string;
  created: string;
  lastUsed: string | null;
}

/** Hard cap on one uploaded audio piece. The phone sends a piece every 10 s. */
export const MAX_PIECE_BYTES = 16 * 1024 * 1024;
/** How often the phone cuts a piece, in milliseconds. */
export const PIECE_MS = 10_000;
