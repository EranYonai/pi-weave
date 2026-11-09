/**
 * Getting audio from the phone to the Mac without losing any.
 *
 * Every piece the recorder cuts goes into a {@link PieceStore} (IndexedDB in
 * the browser) before anything else, and leaves it only once the Mac has
 * confirmed it. `sync` sends whatever is waiting, in order, and finishes a
 * stopped recording once all of its pieces are through. It stops at the first
 * network failure and is simply called again later, so a sleeping Mac, a lift
 * or a dead zone delays the transcript but never loses audio. A reload or a
 * crash keeps the store, so the next page load carries on.
 */

import type { CaptureApi } from "./api";

export interface StoredPiece {
  recording: string;
  index: number;
  /** A Blob in the browser; opaque here. */
  bytes: unknown;
}

export interface PendingRecording {
  id: string;
  title: string;
  /** Pieces cut so far. */
  pieces: number;
  /** Seconds recorded. */
  duration: number;
  /** True once the person pressed stop. */
  stopped: boolean;
}

export interface PieceStore {
  putPiece(piece: StoredPiece): Promise<void>;
  pieces(recording: string): Promise<StoredPiece[]>;
  removePiece(recording: string, index: number): Promise<void>;
  recordings(): Promise<PendingRecording[]>;
  putRecording(recording: PendingRecording): Promise<void>;
  removeRecording(id: string): Promise<void>;
}

export interface SyncReport {
  /** Pieces still on the phone. */
  waiting: number;
  /** Recordings handed to the Mac for transcription in this run. */
  finished: string[];
  /** Set when the run stopped early; try again later. */
  error: string | null;
}

type Api = Pick<CaptureApi, "putPiece" | "finish">;

export class Uploader {
  private running: Promise<SyncReport> | null = null;

  constructor(
    private readonly store: PieceStore,
    private readonly api: Api,
  ) {}

  /** Send what is waiting. Concurrent calls share one run. */
  sync(): Promise<SyncReport> {
    if (this.running === null) {
      this.running = this.run().finally(() => {
        this.running = null;
      });
    }
    return this.running;
  }

  private async run(): Promise<SyncReport> {
    const finished: string[] = [];
    for (const recording of await this.store.recordings()) {
      for (const piece of await this.store.pieces(recording.id)) {
        const sent = await this.api.putPiece(recording.id, piece.index, piece.bytes);
        if (!sent.ok && sent.status !== 409 && sent.status !== 404) return this.report(finished, sent.error);
        // 409 and 404 mean the Mac has closed or dropped this recording: the
        // piece can never land, so keeping it would only block the queue.
        await this.store.removePiece(recording.id, piece.index);
      }
      if (!recording.stopped) continue;
      if (recording.pieces === 0) {
        await this.store.removeRecording(recording.id);
        continue;
      }
      const done = await this.api.finish(recording.id, recording.pieces, recording.duration);
      if (!done.ok && done.status === 0) return this.report(finished, done.error);
      await this.store.removeRecording(recording.id);
      if (done.ok) finished.push(recording.id);
      else return this.report(finished, done.error);
    }
    return this.report(finished, null);
  }

  private async report(finished: string[], error: string | null): Promise<SyncReport> {
    let waiting = 0;
    for (const recording of await this.store.recordings()) waiting += (await this.store.pieces(recording.id)).length;
    return { waiting, finished, error };
  }
}

/** Seconds to wait before the next try: 2, 4, 8 … capped at a minute. */
export function backoff(attempt: number): number {
  return Math.min(60, 2 ** Math.max(1, attempt));
}

/** An in-memory store, for tests and for browsers without IndexedDB. */
export class MemoryPieceStore implements PieceStore {
  private readonly items = new Map<string, StoredPiece>();
  private readonly recs = new Map<string, PendingRecording>();

  async putPiece(piece: StoredPiece): Promise<void> {
    this.items.set(`${piece.recording}/${piece.index}`, piece);
  }
  async pieces(recording: string): Promise<StoredPiece[]> {
    return [...this.items.values()].filter((piece) => piece.recording === recording).sort((a, b) => a.index - b.index);
  }
  async removePiece(recording: string, index: number): Promise<void> {
    this.items.delete(`${recording}/${index}`);
  }
  async recordings(): Promise<PendingRecording[]> {
    return [...this.recs.values()];
  }
  async putRecording(recording: PendingRecording): Promise<void> {
    this.recs.set(recording.id, { ...recording });
  }
  async removeRecording(id: string): Promise<void> {
    this.recs.delete(id);
  }
}
