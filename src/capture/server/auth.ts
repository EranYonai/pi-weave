import { createHash, randomBytes, randomInt } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { timingSafeMatch } from "../../web/server/security";
import type { PasskeyInfo } from "../shared/wire";

/**
 * Sign-in records for the one person who uses Weave Capture: passkeys, recovery
 * codes and sessions, kept in `<dir>/auth.json` (mode 0600).
 *
 * The shape follows Hearthside's: the server stores only each passkey's
 * public key, never a secret that signs in by itself. Session tokens and
 * recovery codes are stored as SHA-256 hashes, so a copy of the file lets
 * nobody in. One person, one file, no database.
 */

export interface StoredPasskey {
  /** Credential id, base64url. */
  id: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports: string[];
  name: string;
  created: string;
  lastUsed: string | null;
}

interface StoredSession {
  hash: string;
  expires: number;
  recovery: boolean;
}

interface AuthFile {
  version: 1;
  /** WebAuthn user handle, base64url. */
  userId: string;
  name: string | null;
  passkeys: StoredPasskey[];
  recovery: string[];
  sessions: StoredSession[];
}

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RECOVERY_CODE_COUNT = 10;

/** URL-safe random token. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// No 0/O, 1/I/L or U, so a code survives being read aloud or written down.
const ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789";

/** A recovery code like `K7PQ-M2XD-9RTA` (about 59 bits). */
export function recoveryCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]!);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((group) => group.join("")).join("-");
}

/** Accept lower case, spaces and missing dashes. */
export function normalizeRecoveryCode(input: string): string {
  const raw = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return raw.length === 12 ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}` : raw;
}

/** A friendly default name for a passkey, from the browser's user agent. */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Passkey";
}

export class AuthStore {
  private readonly path: string;
  private data: AuthFile | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    dir: string,
    private readonly now: () => number = Date.now,
  ) {
    this.path = join(dir, "auth.json");
  }

  /** Serialize every read-modify-write, so two requests never lose an update. */
  private run<T>(task: (data: AuthFile) => T | Promise<T>, write: boolean): Promise<T> {
    const next = this.queue.then(async () => {
      const data = await this.load();
      const result = await task(data);
      if (write) await this.save(data);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<AuthFile> {
    if (this.data !== null) return this.data;
    try {
      this.data = JSON.parse(await fs.readFile(this.path, "utf8")) as AuthFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.data = { version: 1, userId: randomToken(16), name: null, passkeys: [], recovery: [], sessions: [] };
    }
    return this.data;
  }

  private async save(data: AuthFile): Promise<void> {
    data.sessions = data.sessions.filter((session) => session.expires > this.now());
    await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(tmp, this.path);
  }

  /** Setup is open until the first passkey is saved. */
  isSetUp(): Promise<boolean> {
    return this.run((data) => data.passkeys.length > 0, false);
  }

  user(): Promise<{ id: string; name: string | null }> {
    return this.run((data) => ({ id: data.userId, name: data.name }), false);
  }

  passkeys(): Promise<StoredPasskey[]> {
    return this.run((data) => data.passkeys.map((passkey) => ({ ...passkey })), false);
  }

  passkeyList(): Promise<PasskeyInfo[]> {
    return this.run(
      (data) => data.passkeys.map(({ id, name, created, lastUsed }) => ({ id, name, created, lastUsed })),
      false,
    );
  }

  findPasskey(id: string): Promise<StoredPasskey | null> {
    return this.run((data) => data.passkeys.find((passkey) => passkey.id === id) ?? null, false);
  }

  /**
   * Save the first passkey and the person's name, and return fresh recovery
   * codes. Refuses once set up, so a second visitor to `/setup` gets nothing.
   */
  completeSetup(name: string, passkey: StoredPasskey): Promise<string[] | null> {
    return this.run((data) => {
      if (data.passkeys.length > 0) return null;
      data.name = name;
      data.passkeys.push(passkey);
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
      data.recovery = codes.map(sha256);
      return codes;
    }, true);
  }

  addPasskey(passkey: StoredPasskey): Promise<void> {
    return this.run((data) => {
      data.passkeys = data.passkeys.filter((existing) => existing.id !== passkey.id);
      data.passkeys.push(passkey);
    }, true);
  }

  /** Remove a passkey. The last one cannot go: that would lock the person out. */
  removePasskey(id: string): Promise<"removed" | "last" | "missing"> {
    return this.run((data) => {
      if (!data.passkeys.some((passkey) => passkey.id === id)) return "missing";
      if (data.passkeys.length === 1) return "last";
      data.passkeys = data.passkeys.filter((passkey) => passkey.id !== id);
      return "removed";
    }, true);
  }

  markPasskeyUsed(id: string, counter: number): Promise<void> {
    return this.run((data) => {
      const passkey = data.passkeys.find((item) => item.id === id);
      if (passkey) {
        passkey.counter = counter;
        passkey.lastUsed = new Date(this.now()).toISOString();
      }
    }, true);
  }

  /** Use up a recovery code. True when it was valid and unused. */
  redeemRecoveryCode(code: string): Promise<boolean> {
    const hash = sha256(normalizeRecoveryCode(code));
    return this.run((data) => {
      const index = data.recovery.findIndex((stored) => timingSafeMatch(stored, hash));
      if (index === -1) return false;
      data.recovery.splice(index, 1);
      return true;
    }, true);
  }

  /** Replace every recovery code with ten new ones. */
  newRecoveryCodes(): Promise<string[]> {
    return this.run((data) => {
      const codes = Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
      data.recovery = codes.map(sha256);
      return codes;
    }, true);
  }

  recoveryCodesLeft(): Promise<number> {
    return this.run((data) => data.recovery.length, false);
  }

  createSession(recovery = false): Promise<string> {
    const token = randomToken();
    return this.run((data) => {
      data.sessions.push({ hash: sha256(token), expires: this.now() + SESSION_TTL_MS, recovery });
      return token;
    }, true);
  }

  session(token: string | undefined): Promise<{ recovery: boolean } | null> {
    if (!token) return Promise.resolve(null);
    const hash = sha256(token);
    return this.run((data) => {
      const found = data.sessions.find((session) => timingSafeMatch(session.hash, hash) && session.expires > this.now());
      return found ? { recovery: found.recovery } : null;
    }, false);
  }

  /** A session that came from a recovery code becomes a normal one once a passkey is added. */
  upgradeSession(token: string): Promise<void> {
    const hash = sha256(token);
    return this.run((data) => {
      for (const session of data.sessions) if (session.hash === hash) session.recovery = false;
    }, true);
  }

  endSession(token: string | undefined): Promise<void> {
    if (!token) return Promise.resolve();
    const hash = sha256(token);
    return this.run((data) => {
      data.sessions = data.sessions.filter((session) => session.hash !== hash);
    }, true);
  }
}
