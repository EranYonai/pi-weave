/** Display helpers for the phone page. Pure, so they run in Node tests. */

import type { MeetingStatus, MeetingSummary, TranscriptPayload } from "../shared/wire";

/** `00:23:41` for a number of milliseconds. */
export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/** `42 min`, `1 h 05 min`, or `40 s`. */
export function minutes(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} s`;
  const m = Math.round(total / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

const DAY = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `Today 09:00`, `Yesterday 16:30`, `Fri 11:00`, or `3 Oct 11:00`, in local time. */
export function when(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const at = date.getTime();
  if (at >= startOfToday) return `Today ${time}`;
  if (at >= startOfToday - DAY) return `Yesterday ${time}`;
  if (at >= startOfToday - 6 * DAY) return `${WEEKDAYS[date.getDay()]} ${time}`;
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${time}`;
}

export function statusLabel(status: MeetingStatus): string {
  switch (status) {
    case "recording":
      return "uploading";
    case "queued":
      return "waiting";
    case "transcribing":
      return "transcribing";
    case "failed":
      return "failed";
    case "new":
      return "new";
    case "read":
      return "read";
  }
}

export function meetingLine(meeting: MeetingSummary, now?: Date): string {
  const parts = [when(meeting.recorded, now)];
  if (meeting.duration > 0) parts.push(minutes(meeting.duration));
  return parts.filter(Boolean).join(" · ");
}

/** The transcript as Markdown, ready to paste into any chat or harness. */
export function transcriptMarkdown(transcript: TranscriptPayload): string {
  const head = [`# ${transcript.title}`, "", `Recorded ${transcript.recorded.slice(0, 16).replace("T", " ")} UTC, ${minutes(transcript.duration)}.`];
  return `${head.join("\n")}\n\n${transcript.body.trim()}\n`;
}

/** The first MIME type in `preferred` the recorder supports, or "" for the browser default. */
export function pickMime(supported: (mime: string) => boolean): string {
  const preferred = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm"];
  return preferred.find((mime) => supported(mime)) ?? "";
}
