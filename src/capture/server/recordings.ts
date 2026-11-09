import { promises as fs } from "node:fs";
import { join } from "node:path";
import { listTranscripts, saveTranscript, type TranscriptSegment } from "../../core/capture";
import type { MeetingSummary } from "../shared/wire";
import { randomToken } from "./auth";

/**
 * Recordings on their way into the vault.
 *
 * Each one is a folder under `<dir>/recordings/<id>/`: `meta.json` plus the
 * numbered audio pieces the phone uploads (`000000.bin`, …). Pieces are
 * idempotent, so the phone can resend any it is unsure of. On finish the
 * pieces are joined in order, transcribed, and written to the vault; then the
 * folder waits `keepAudioDays` before it is removed, in case the transcript
 * needs a second run.
 *
 * Transcription runs one recording at a time, in the order finished. A
 * recording left `queued` or `transcribing` by a restart is picked up again on
 * start.
 */

export type RecordingStatus = "recording" | "queued" | "transcribing" | "failed" | "done";

export interface RecordingMeta {
  id: string;
  title: string;
  /** ISO time recording started on the phone. */
  recorded: string;
  mime: string;
  status: RecordingStatus;
  /** Seconds, as the phone measured. */
  duration: number;
  pieces: number;
  error?: string;
  /** Vault slug once transcribed. */
  slug?: string;
  /** ISO time it reached the vault, for audio clean-up. */
  done?: string;
}

/** Turns the joined audio file into timed text. */
export type Transcribe = (audioPath: string, workDir: string) => Promise<TranscriptSegment[]>;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PIECE_LIMIT = 100_000;

export function isRecordingId(id: string): boolean {
  return ID_RE.test(id);
}

/** The audio container a MIME type names, for the joined file's extension. */
export function audioExtension(mime: string): string {
  if (/mp4|m4a|aac/i.test(mime)) return "m4a";
  if (/ogg/i.test(mime)) return "ogg";
  if (/wav/i.test(mime)) return "wav";
  return "webm";
}

export function defaultTitle(recorded: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `Meeting ${recorded.getFullYear()}-${pad(recorded.getMonth() + 1)}-${pad(recorded.getDate())} ${pad(recorded.getHours())}:${pad(recorded.getMinutes())}`;
}

export class Recordings {
  private readonly root: string;
  private chain: Promise<void> = Promise.resolve();
  private readonly pending = new Set<string>();

  constructor(
    dir: string,
    private readonly vaultRoot: string,
    private readonly transcribe: Transcribe,
    private readonly keepAudioDays = 7,
    private readonly now: () => Date = () => new Date(),
    private readonly log: (line: string) => void = () => {},
  ) {
    this.root = join(dir, "recordings");
  }

  private folder(id: string): string {
    return join(this.root, id);
  }

  private async write(meta: RecordingMeta): Promise<void> {
    await fs.mkdir(this.folder(meta.id), { recursive: true });
    const path = join(this.folder(meta.id), "meta.json");
    await fs.writeFile(`${path}.tmp`, `${JSON.stringify(meta, null, 2)}\n`);
    await fs.rename(`${path}.tmp`, path);
  }

  async get(id: string): Promise<RecordingMeta | null> {
    if (!isRecordingId(id)) return null;
    try {
      return JSON.parse(await fs.readFile(join(this.folder(id), "meta.json"), "utf8")) as RecordingMeta;
    } catch {
      return null;
    }
  }

  async all(): Promise<RecordingMeta[]> {
    const names = await fs.readdir(this.root).catch(() => [] as string[]);
    const metas = await Promise.all(names.map((name) => this.get(name)));
    return metas.filter((meta): meta is RecordingMeta => meta !== null);
  }

  async create(input: { title?: string; recorded?: string; mime?: string }): Promise<RecordingMeta> {
    const started = input.recorded && !Number.isNaN(Date.parse(input.recorded)) ? new Date(input.recorded) : this.now();
    const title = input.title?.trim().slice(0, 120);
    const meta: RecordingMeta = {
      id: randomToken(12),
      title: title || defaultTitle(started),
      recorded: started.toISOString(),
      mime: (input.mime ?? "audio/webm").slice(0, 100),
      status: "recording",
      duration: 0,
      pieces: 0,
    };
    await this.write(meta);
    return meta;
  }

  /** Store piece `index`. Refused once the recording is finished. */
  async putPiece(id: string, index: number, bytes: Buffer): Promise<"ok" | "missing" | "closed" | "invalid"> {
    if (!Number.isInteger(index) || index < 0 || index >= PIECE_LIMIT) return "invalid";
    const meta = await this.get(id);
    if (meta === null) return "missing";
    if (meta.status !== "recording") return "closed";
    await fs.writeFile(join(this.folder(id), `${String(index).padStart(6, "0")}.bin`), bytes);
    return "ok";
  }

  private async missingPieces(id: string, count: number): Promise<number[]> {
    const names = new Set(await fs.readdir(this.folder(id)));
    const missing: number[] = [];
    for (let index = 0; index < count; index++) {
      if (!names.has(`${String(index).padStart(6, "0")}.bin`)) missing.push(index);
    }
    return missing;
  }

  /**
   * Close a recording and queue it. `missing` lists pieces the server never
   * got, so the phone can resend them and finish again.
   */
  async finish(
    id: string,
    input: { pieces: number; duration: number },
  ): Promise<{ ok: true; meta: RecordingMeta } | { ok: false; reason: "missing" | "invalid"; missing?: number[] }> {
    const meta = await this.get(id);
    if (meta === null) return { ok: false, reason: "missing" };
    if (meta.status !== "recording") return { ok: true, meta };
    if (!Number.isInteger(input.pieces) || input.pieces < 1 || input.pieces > PIECE_LIMIT) return { ok: false, reason: "invalid" };
    const missing = await this.missingPieces(id, input.pieces);
    if (missing.length > 0) return { ok: false, reason: "invalid", missing };
    const next: RecordingMeta = {
      ...meta,
      status: "queued",
      pieces: input.pieces,
      duration: Number.isFinite(input.duration) && input.duration > 0 ? input.duration : 0,
    };
    await this.write(next);
    this.enqueue(id);
    return { ok: true, meta: next };
  }

  /** Queue a failed recording again. */
  async retry(id: string): Promise<boolean> {
    const meta = await this.get(id);
    if (meta === null || meta.status !== "failed") return false;
    const { error: _error, ...rest } = meta;
    await this.write({ ...rest, status: "queued" });
    this.enqueue(id);
    return true;
  }

  /** Throw away a recording that has not reached the vault. */
  async discard(id: string): Promise<boolean> {
    const meta = await this.get(id);
    if (meta === null || meta.status === "done" || meta.status === "transcribing") return false;
    await fs.rm(this.folder(id), { recursive: true, force: true });
    return true;
  }

  async rename(id: string, title: string): Promise<boolean> {
    const meta = await this.get(id);
    const clean = title.trim().slice(0, 120);
    if (meta === null || meta.status === "done" || clean === "") return false;
    await this.write({ ...meta, title: clean });
    return true;
  }

  private enqueue(id: string): void {
    if (this.pending.has(id)) return;
    this.pending.add(id);
    this.chain = this.chain.then(() => this.process(id)).finally(() => this.pending.delete(id));
  }

  /** Resolves once everything queued so far has been processed. */
  idle(): Promise<void> {
    return this.chain;
  }

  private async process(id: string): Promise<void> {
    const meta = await this.get(id);
    if (meta === null || (meta.status !== "queued" && meta.status !== "transcribing")) return;
    await this.write({ ...meta, status: "transcribing" });
    try {
      // A restart between writing the note and marking the recording done
      // must not write the transcript twice.
      const existing = (await listTranscripts(this.vaultRoot)).find((item) => item.capture === id);
      let slug = existing?.slug;
      if (slug === undefined) {
        const folder = this.folder(id);
        const audio = join(folder, `audio.${audioExtension(meta.mime)}`);
        const handle = await fs.open(audio, "w");
        try {
          for (let index = 0; index < meta.pieces; index++) {
            await handle.write(await fs.readFile(join(folder, `${String(index).padStart(6, "0")}.bin`)));
          }
        } finally {
          await handle.close();
        }
        const segments = await this.transcribe(audio, folder);
        const latest = (await this.get(id)) ?? meta;
        const note = await saveTranscript(this.vaultRoot, {
          title: latest.title,
          recorded: new Date(meta.recorded),
          duration: meta.duration,
          segments,
          capture: id,
        });
        slug = note.slug;
      }
      const latest = (await this.get(id)) ?? meta;
      await this.write({ ...latest, status: "done", slug, done: this.now().toISOString() });
      this.log(`transcribed ${id} -> ${slug}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const latest = (await this.get(id)) ?? meta;
      await this.write({ ...latest, status: "failed", error: message.slice(0, 500) });
      this.log(`transcription failed for ${id}: ${message}`);
    }
  }

  /** Re-queue work a restart interrupted, and drop audio past its keep time. */
  async resume(): Promise<void> {
    await this.prune();
    for (const meta of await this.all()) {
      if (meta.status === "queued" || meta.status === "transcribing") this.enqueue(meta.id);
    }
  }

  async prune(): Promise<number> {
    const cutoff = this.now().getTime() - this.keepAudioDays * 24 * 60 * 60 * 1000;
    let removed = 0;
    for (const meta of await this.all()) {
      if (meta.status === "done" && meta.done !== undefined && Date.parse(meta.done) < cutoff) {
        await fs.rm(this.folder(meta.id), { recursive: true, force: true });
        removed++;
      }
    }
    return removed;
  }

  /** Every tab: recordings not yet in the vault, then the vault's transcripts. */
  async meetings(): Promise<MeetingSummary[]> {
    const inFlight = (await this.all())
      .filter((meta) => meta.status !== "done")
      .map((meta): MeetingSummary => ({
        id: meta.id,
        kind: "recording",
        title: meta.title,
        recorded: meta.recorded,
        duration: meta.duration,
        status: meta.status as MeetingSummary["status"],
        ...(meta.error !== undefined ? { error: meta.error } : {}),
      }));
    const transcripts = (await listTranscripts(this.vaultRoot)).map((item): MeetingSummary => ({
      id: item.slug,
      kind: "transcript",
      title: item.title,
      recorded: item.recorded,
      duration: item.duration,
      status: item.status,
    }));
    return [...inFlight, ...transcripts].sort((a, b) => b.recorded.localeCompare(a.recorded));
  }
}
