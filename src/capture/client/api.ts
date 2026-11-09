/**
 * Typed calls to the capture server. `fetch` is injected, and this file names
 * no DOM types, so it runs and is tested in Node like `src/web/client/api.ts`.
 * Every call resolves to a {@link Result}; a dropped connection is an ordinary
 * outcome on a phone, not an exception.
 */

import type { MeetingSummary, PasskeyInfo, SessionState, TranscriptPayload } from "../shared/wire";

export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown; credentials: "same-origin" },
) => Promise<HttpResponse>;

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string; data?: Record<string, unknown> };

const OFFLINE = "Can’t reach your Mac right now.";

export class CaptureApi {
  constructor(private readonly fetcher: FetchLike) {}

  private async call<T>(method: string, path: string, body?: unknown, raw = false): Promise<Result<T>> {
    let response: HttpResponse;
    try {
      response = await this.fetcher(path, {
        method,
        credentials: "same-origin",
        ...(body === undefined ? {} : raw ? { body, headers: { "content-type": "application/octet-stream" } } : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
    } catch {
      return { ok: false, status: 0, error: OFFLINE };
    }
    let data: unknown = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (response.ok) return { ok: true, data: data as T };
    const record = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const error = typeof record.error === "string" ? record.error : response.status >= 500 || response.status === 0 ? OFFLINE : `Request failed (${response.status}).`;
    return { ok: false, status: response.status, error, data: record };
  }

  session() {
    return this.call<SessionState>("GET", "/api/session");
  }
  setupOptions(name: string) {
    return this.call<Record<string, unknown>>("POST", "/api/auth/setup/options", { name });
  }
  setupVerify(response: unknown) {
    return this.call<{ codes: string[] }>("POST", "/api/auth/setup/verify", { response });
  }
  loginOptions() {
    return this.call<Record<string, unknown>>("POST", "/api/auth/login/options", {});
  }
  loginVerify(response: unknown) {
    return this.call<{ ok: true }>("POST", "/api/auth/login/verify", { response });
  }
  recover(code: string) {
    return this.call<{ ok: true }>("POST", "/api/auth/recover", { code });
  }
  logout() {
    return this.call<{ ok: true }>("POST", "/api/auth/logout", {});
  }
  passkeyOptions() {
    return this.call<Record<string, unknown>>("POST", "/api/passkeys/options", {});
  }
  passkeyVerify(response: unknown) {
    return this.call<{ ok: true }>("POST", "/api/passkeys/verify", { response });
  }
  passkeys() {
    return this.call<{ passkeys: PasskeyInfo[]; recoveryCodesLeft: number }>("GET", "/api/passkeys");
  }
  removePasskey(id: string) {
    return this.call<{ ok: true }>("DELETE", `/api/passkeys/${encodeURIComponent(id)}`);
  }
  newRecoveryCodes() {
    return this.call<{ codes: string[] }>("POST", "/api/recovery-codes", {});
  }
  meetings() {
    return this.call<{ meetings: MeetingSummary[] }>("GET", "/api/meetings");
  }
  transcript(slug: string) {
    return this.call<TranscriptPayload>("GET", `/api/transcript?slug=${encodeURIComponent(slug)}`);
  }
  setTranscriptStatus(slug: string, status: "new" | "read") {
    return this.call<{ ok: true }>("POST", "/api/transcript/status", { slug, status });
  }
  renameTranscript(slug: string, title: string) {
    return this.call<{ slug: string }>("POST", "/api/transcript/title", { slug, title });
  }
  createRecording(input: { title?: string; recorded: string; mime: string }) {
    return this.call<{ id: string; title: string }>("POST", "/api/recordings", input);
  }
  putPiece(id: string, index: number, bytes: unknown) {
    return this.call<{ ok: true }>("PUT", `/api/recordings/${id}/pieces/${index}`, bytes, true);
  }
  finish(id: string, pieces: number, duration: number) {
    return this.call<{ ok: true; status: string }>("POST", `/api/recordings/${id}/finish`, { pieces, duration });
  }
  retry(id: string) {
    return this.call<{ ok: true }>("POST", `/api/recordings/${id}/retry`, {});
  }
  renameRecording(id: string, title: string) {
    return this.call<{ ok: true }>("POST", `/api/recordings/${id}/title`, { title });
  }
  discard(id: string) {
    return this.call<{ ok: true }>("DELETE", `/api/recordings/${id}`);
  }
}
