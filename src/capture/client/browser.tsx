/**
 * The browser-only half of the phone page: IndexedDB, the microphone, the
 * screen wake lock and the passkey prompts. Kept apart from the testable
 * modules (`api.ts`, `uploader.ts`, `format.ts`) because none of this exists
 * in Node; each piece is a thin wrapper over one platform API.
 */

import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { PendingRecording, PieceStore, StoredPiece } from "./uploader";
import { MemoryPieceStore } from "./uploader";
import { PIECE_MS } from "../shared/wire";
import { pickMime } from "./format";

// --- passkeys --------------------------------------------------------------------

export async function createPasskey(options: Record<string, unknown>): Promise<unknown> {
  return startRegistration({ optionsJSON: options as never });
}

export async function usePasskey(options: Record<string, unknown>): Promise<unknown> {
  return startAuthentication({ optionsJSON: options as never });
}

/** A friendly message for a passkey prompt that failed or was dismissed. */
export function passkeyError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "AbortError") return "The passkey prompt was closed. Try again when you’re ready.";
  if (name === "InvalidStateError") return "This device already has a passkey for Weave Capture.";
  return error instanceof Error ? error.message : "The passkey didn’t work. Try again.";
}

// --- piece store -------------------------------------------------------------------

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

class IdbPieceStore implements PieceStore {
  constructor(private readonly db: IDBDatabase) {}

  private store(name: "pieces" | "recordings", mode: IDBTransactionMode): IDBObjectStore {
    return this.db.transaction(name, mode).objectStore(name);
  }
  async putPiece(piece: StoredPiece): Promise<void> {
    await request(this.store("pieces", "readwrite").put(piece));
  }
  async pieces(recording: string): Promise<StoredPiece[]> {
    const range = IDBKeyRange.bound([recording, 0], [recording, Number.MAX_SAFE_INTEGER]);
    return (await request(this.store("pieces", "readonly").getAll(range))) as StoredPiece[];
  }
  async removePiece(recording: string, index: number): Promise<void> {
    await request(this.store("pieces", "readwrite").delete([recording, index]));
  }
  async recordings(): Promise<PendingRecording[]> {
    return (await request(this.store("recordings", "readonly").getAll())) as PendingRecording[];
  }
  async putRecording(recording: PendingRecording): Promise<void> {
    await request(this.store("recordings", "readwrite").put(recording));
  }
  async removeRecording(id: string): Promise<void> {
    await request(this.store("recordings", "readwrite").delete(id));
  }
}

/** IndexedDB when the browser allows it, otherwise memory (audio then lives only while the page is open). */
export async function openPieceStore(): Promise<{ store: PieceStore; durable: boolean }> {
  try {
    const open = indexedDB.open("weave-capture", 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore("pieces", { keyPath: ["recording", "index"] });
      open.result.createObjectStore("recordings", { keyPath: "id" });
    };
    const db = await request(open);
    await navigator.storage?.persist?.().catch(() => false);
    return { store: new IdbPieceStore(db), durable: true };
  } catch {
    return { store: new MemoryPieceStore(), durable: false };
  }
}

// --- recorder ------------------------------------------------------------------------

export interface RecorderEvents {
  /** A piece was cut and stored. */
  onPiece(recording: PendingRecording): void;
  /** The browser stopped recording on its own (screen locked, mic taken). */
  onInterrupted(): void;
}

/**
 * Records the microphone in pieces of {@link PIECE_MS}. Each piece is written
 * to the store before anything else happens to it.
 */
export class Recorder {
  private media: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private wakeLock: WakeLockSentinel | null = null;
  private recording: PendingRecording | null = null;
  private startedAt = 0;
  private stopping: Promise<PendingRecording> | null = null;
  private resolveStop: ((recording: PendingRecording) => void) | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: PieceStore,
    private readonly events: RecorderEvents,
  ) {}

  get active(): boolean {
    return this.media !== null;
  }

  elapsed(): number {
    return this.media ? Date.now() - this.startedAt : 0;
  }

  static mime(): string {
    return typeof MediaRecorder === "undefined" ? "" : pickMime((mime) => MediaRecorder.isTypeSupported(mime));
  }

  async start(id: string, title: string, mime: string): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const media = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 32_000 } : { audioBitsPerSecond: 32_000 });
    this.recording = { id, title, pieces: 0, duration: 0, stopped: false };
    this.startedAt = Date.now();
    await this.store.putRecording(this.recording);
    media.ondataavailable = (event) => {
      const recording = this.recording;
      if (!recording || event.data.size === 0) return;
      const index = recording.pieces++;
      recording.duration = (Date.now() - this.startedAt) / 1000;
      this.writes = this.writes
        .then(() => this.store.putPiece({ recording: recording.id, index, bytes: event.data }))
        .then(() => this.store.putRecording(recording))
        .then(() => this.events.onPiece({ ...recording }));
    };
    media.onstop = () => {
      const recording = this.recording;
      this.media = null;
      this.release();
      if (!recording) return;
      recording.stopped = true;
      recording.duration = (Date.now() - this.startedAt) / 1000;
      this.writes = this.writes.then(() => this.store.putRecording(recording));
      void this.writes.then(() => {
        if (this.resolveStop) this.resolveStop({ ...recording });
        else this.events.onInterrupted();
        this.resolveStop = null;
        this.stopping = null;
        this.recording = null;
      });
    };
    media.start(PIECE_MS);
    this.media = media;
    await this.lockScreen();
    document.addEventListener("visibilitychange", this.relock);
  }

  /** Stop, store the last piece, and resolve with the finished recording. */
  stop(): Promise<PendingRecording> {
    if (this.stopping) return this.stopping;
    this.stopping = new Promise((resolve) => {
      this.resolveStop = resolve;
    });
    this.media?.stop();
    return this.stopping;
  }

  private relock = (): void => {
    if (document.visibilityState === "visible" && this.media) void this.lockScreen();
  };

  private async lockScreen(): Promise<void> {
    try {
      this.wakeLock = (await navigator.wakeLock?.request("screen")) ?? null;
    } catch {
      this.wakeLock = null;
    }
  }

  private release(): void {
    document.removeEventListener("visibilitychange", this.relock);
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    void this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
