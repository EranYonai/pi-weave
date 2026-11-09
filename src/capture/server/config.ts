import { homedir } from "node:os";
import { join } from "node:path";
import { resolveVaultRoot } from "../../core/paths";

/**
 * Settings for `pi-weave-capture`, from flags and environment.
 *
 *   --origin   PI_WEAVE_CAPTURE_ORIGIN  public address, e.g. https://weave.manta.run
 *   --port     PI_WEAVE_CAPTURE_PORT    loopback port the tunnel forwards to (3310)
 *   --dir      PI_WEAVE_CAPTURE_DIR     sign-in data and audio (~/.okf-capture)
 *   --whisper  PI_WEAVE_WHISPER         whisper.cpp program (whisper-cli)
 *   --model    PI_WEAVE_WHISPER_MODEL   ggml model file (<dir>/models/ggml-large-v3-turbo.bin)
 *   --language PI_WEAVE_WHISPER_LANG    spoken language, or auto (auto)
 *   --ffmpeg   PI_WEAVE_FFMPEG          ffmpeg program (ffmpeg)
 *
 * The vault comes from PI_WEAVE_VAULT like every other pi-weave entry point.
 * Sign-in data lives outside the vault on purpose: the vault is a folder a
 * person syncs and shares with agents, and passkey records do not belong there.
 */
export interface CaptureConfig {
  origin: string;
  /** WebAuthn relying party id: the origin's host name. */
  rpId: string;
  port: number;
  host: string;
  dir: string;
  vaultRoot: string;
  whisper: string;
  model: string;
  language: string;
  ffmpeg: string;
  /** Days to keep a meeting's audio after it is transcribed. */
  keepAudioDays: number;
}

export const DEFAULT_ORIGIN = "https://weave.manta.run";
export const DEFAULT_PORT = 3310;
export const MODEL_FILE = "ggml-large-v3-turbo.bin";
export const MODEL_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${MODEL_FILE}`;

function flags(args: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq > 0) out.set(arg.slice(2, eq), arg.slice(eq + 1));
    else if (i + 1 < args.length) out.set(arg.slice(2), args[++i]!);
  }
  return out;
}

export function resolveConfig(args: readonly string[] = [], env: NodeJS.ProcessEnv = process.env): CaptureConfig {
  const f = flags(args);
  const pick = (flag: string, name: string, fallback: string) => f.get(flag) ?? env[name] ?? fallback;
  const origin = new URL(pick("origin", "PI_WEAVE_CAPTURE_ORIGIN", DEFAULT_ORIGIN)).origin;
  const port = Number(pick("port", "PI_WEAVE_CAPTURE_PORT", String(DEFAULT_PORT)));
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error(`pi-weave-capture: invalid port '${String(port)}'`);
  const dir = pick("dir", "PI_WEAVE_CAPTURE_DIR", join(homedir(), ".okf-capture"));
  return {
    origin,
    rpId: new URL(origin).hostname,
    port,
    host: "127.0.0.1",
    dir,
    vaultRoot: resolveVaultRoot(env),
    whisper: pick("whisper", "PI_WEAVE_WHISPER", "whisper-cli"),
    model: pick("model", "PI_WEAVE_WHISPER_MODEL", join(dir, "models", MODEL_FILE)),
    language: pick("language", "PI_WEAVE_WHISPER_LANG", "auto"),
    ffmpeg: pick("ffmpeg", "PI_WEAVE_FFMPEG", "ffmpeg"),
    keepAudioDays: 7,
  };
}
