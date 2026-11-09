import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { TranscriptSegment } from "../../core/capture";
import type { CaptureConfig } from "./config";
import type { Transcribe } from "./recordings";

/**
 * Transcription with whisper.cpp on the Mac. Audio never leaves the machine.
 *
 *   ffmpeg      phone audio (WebM or MP4) -> 16 kHz mono WAV, what whisper.cpp reads
 *   whisper-cli WAV -> JSON with one entry per segment, offsets in milliseconds
 *
 * Install both with `brew install ffmpeg whisper-cpp`; `pi-weave-capture doctor`
 * checks them and the model file.
 */

export type RunProgram = (program: string, args: readonly string[]) => Promise<void>;

/** Run a program, failing with the tail of its stderr. */
export const runProgram: RunProgram = (program, args) =>
  new Promise((resolve, reject) => {
    execFile(program, [...args], { maxBuffer: 64 * 1024 * 1024 }, (error, _stdout, stderr) => {
      if (!error) return resolve();
      const detail = String(stderr).trim().split("\n").slice(-3).join(" ");
      reject(new Error(`${program} failed${detail ? `: ${detail}` : ` (${error.message})`}`));
    });
  });

interface WhisperJson {
  transcription?: { offsets?: { from?: number }; text?: string }[];
}

/** Segments from whisper-cli's `-oj` output. */
export function parseWhisperJson(text: string): TranscriptSegment[] {
  const parsed = JSON.parse(text) as WhisperJson;
  if (!Array.isArray(parsed.transcription)) throw new Error("whisper output has no transcription");
  return parsed.transcription.map((item) => ({
    start: (item.offsets?.from ?? 0) / 1000,
    text: String(item.text ?? ""),
  }));
}

export function whisperTranscriber(config: Pick<CaptureConfig, "ffmpeg" | "whisper" | "model" | "language">, run: RunProgram = runProgram): Transcribe {
  return async (audioPath, workDir) => {
    const wav = join(workDir, "audio.wav");
    const out = join(workDir, "transcript");
    try {
      await run(config.ffmpeg, ["-y", "-loglevel", "error", "-i", audioPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
      await run(config.whisper, ["-m", config.model, "-f", wav, "-l", config.language, "-oj", "-of", out, "-np"]);
      return parseWhisperJson(await fs.readFile(`${out}.json`, "utf8"));
    } finally {
      // The WAV is ten times the phone's audio and is rebuilt on a retry.
      await fs.rm(wav, { force: true });
    }
  };
}
