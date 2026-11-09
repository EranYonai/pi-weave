import { promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { MEETINGS_FOLDER, readTranscript, setTranscriptStatus } from "../../core/capture";
import { parseNoteFile } from "../../core/frontmatter";
import { renameNote, resolveNotePath } from "../../core/vault";
import { MAX_PIECE_BYTES, type SessionState, type TranscriptPayload } from "../shared/wire";
import { AuthStore, deviceLabel, randomToken, SESSION_TTL_MS, type StoredPasskey } from "./auth";
import type { CaptureConfig } from "./config";
import { cookies, HttpError, readBody, readJson, send, sendJson, setCookie, text } from "./http";
import { ICON_SVG, MANIFEST, PAGE_CSS, PAGE_HTML } from "./page";
import { Recordings } from "./recordings";
import type { AuthenticationResponseJSON, RegistrationResponseJSON, WebAuthn } from "./webauthn";

/**
 * The capture server: the phone page, passkey sign-in, audio upload and the
 * meeting list.
 *
 * It binds to 127.0.0.1 only. The Cloudflare Tunnel is the one way in, and
 * it forwards the public host name, so every request must name exactly the
 * configured origin's host; state-changing requests must also carry that
 * origin in `Origin`. Everything except the page, its assets and the sign-in
 * endpoints needs a session cookie. It serves transcripts from `meetings/`
 * only, never any other vault note.
 */

export interface CaptureDeps {
  config: CaptureConfig;
  auth: AuthStore;
  webauthn: WebAuthn;
  recordings: Recordings;
  /** The phone page's script. */
  appJs: () => Promise<Buffer>;
  now?: () => number;
}

interface Challenge {
  challenge: string;
  purpose: "setup" | "login" | "passkey";
  name?: string;
  expires: number;
}

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 100;
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_MAX_FAILURES = 5;

export function defaultAppPath(): string {
  return fileURLToPath(new URL("../dist/app.js", import.meta.url));
}

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

export function createCaptureHandler(deps: CaptureDeps): Handler {
  const { config, auth, webauthn, recordings } = deps;
  const now = deps.now ?? Date.now;
  const host = new URL(config.origin).host;
  const secure = config.origin.startsWith("https:");
  const sessionCookie = secure ? "__Host-weave-capture" : "weave_capture";
  const challengeCookie = secure ? "__Host-weave-challenge" : "weave_challenge";
  const rp = { origin: config.origin, rpId: config.rpId };
  const challenges = new Map<string, Challenge>();
  const recoveryFailures: number[] = [];

  function saveChallenge(challenge: Omit<Challenge, "expires">): string {
    for (const [id, item] of challenges) if (item.expires <= now()) challenges.delete(id);
    if (challenges.size >= MAX_CHALLENGES) throw new HttpError(429, "Too many sign-in attempts at once. Wait a minute and try again.");
    const id = randomToken(16);
    challenges.set(id, { ...challenge, expires: now() + CHALLENGE_TTL_MS });
    return setCookie(challengeCookie, id, CHALLENGE_TTL_MS / 1000, secure);
  }

  function takeChallenge(req: IncomingMessage, purpose: Challenge["purpose"]): Challenge {
    const id = cookies(req)[challengeCookie];
    const found = id === undefined ? undefined : challenges.get(id);
    if (id !== undefined) challenges.delete(id);
    if (found === undefined || found.purpose !== purpose || found.expires <= now()) {
      throw new HttpError(400, "That took too long. Please try again.");
    }
    return found;
  }

  const sessionHeader = (token: string) => setCookie(sessionCookie, token, SESSION_TTL_MS / 1000, secure);
  const clearHeaders = [setCookie(sessionCookie, "", 0, secure), setCookie(challengeCookie, "", 0, secure)];

  async function session(req: IncomingMessage) {
    const token = cookies(req)[sessionCookie];
    return { token, session: await auth.session(token) };
  }

  /** A signed-in request. Recovery sessions may only add a passkey. */
  async function requireSession(req: IncomingMessage, allowRecovery = false): Promise<string> {
    const { token, session: found } = await session(req);
    if (found === null || token === undefined) throw new HttpError(401, "Sign in first.");
    if (found.recovery && !allowRecovery) throw new HttpError(403, "Add a passkey before you continue.");
    return token;
  }

  function newPasskey(id: Omit<StoredPasskey, "name" | "created" | "lastUsed">, req: IncomingMessage, name?: string): StoredPasskey {
    return { ...id, name: name || deviceLabel(req.headers["user-agent"]), created: new Date(now()).toISOString(), lastUsed: null };
  }

  async function transcript(slug: string): Promise<TranscriptPayload> {
    const path = slug.startsWith(`${MEETINGS_FOLDER}/`) ? resolveNotePath(config.vaultRoot, slug) : null;
    const raw = path === null ? null : await fs.readFile(path, "utf8").catch(() => null);
    const summary = raw === null ? null : readTranscript(slug, raw);
    if (raw === null || summary === null) throw new HttpError(404, "That transcript is not in the vault any more.");
    return { id: slug, kind: "transcript", title: summary.title, recorded: summary.recorded, duration: summary.duration, status: summary.status, body: parseNoteFile(raw).body };
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", config.origin);
    const path = url.pathname;

    if (path === "/api/health") return sendJson(res, 200, { ok: true });
    if (req.headers.host !== host) throw new HttpError(421, `This app answers only at ${config.origin}.`);
    if (method !== "GET" && method !== "HEAD" && req.headers.origin !== config.origin) {
      throw new HttpError(403, "That request did not come from this app.");
    }

    // --- page and assets ------------------------------------------------
    if (method === "GET" && path === "/app.js") return send(res, 200, await deps.appJs(), "text/javascript; charset=utf-8");
    if (method === "GET" && path === "/app.css") return send(res, 200, PAGE_CSS, "text/css; charset=utf-8");
    if (method === "GET" && path === "/manifest.webmanifest") return send(res, 200, MANIFEST, "application/manifest+json");
    if (method === "GET" && path === "/icon.svg") return send(res, 200, ICON_SVG, "image/svg+xml");
    if (method === "GET" && !path.startsWith("/api/")) return send(res, 200, PAGE_HTML, "text/html; charset=utf-8");

    // --- sign-in ----------------------------------------------------------
    if (method === "GET" && path === "/api/session") {
      const { session: found } = await session(req);
      const user = await auth.user();
      const state: SessionState = { setUp: await auth.isSetUp(), signedIn: found !== null, recovery: found?.recovery ?? false, name: user.name };
      return sendJson(res, 200, state);
    }

    if (method === "POST" && path === "/api/auth/setup/options") {
      const name = text((await readJson(req)).name, 60);
      if (!name) throw new HttpError(400, "Add your name.");
      if (await auth.isSetUp()) throw new HttpError(409, "This app is already set up. Sign in instead.");
      const user = await auth.user();
      const options = await webauthn.registrationOptions(rp, { id: user.id, name }, []);
      return sendJson(res, 200, options, { "set-cookie": saveChallenge({ challenge: options.challenge, purpose: "setup", name }) });
    }

    if (method === "POST" && path === "/api/auth/setup/verify") {
      const body = await readJson(req);
      const challenge = takeChallenge(req, "setup");
      const verified = await webauthn.verifyRegistration(rp, body.response as RegistrationResponseJSON, challenge.challenge);
      if (verified === null) throw new HttpError(400, "That passkey could not be saved. Try again.");
      const codes = await auth.completeSetup(challenge.name ?? "Me", newPasskey(verified, req));
      if (codes === null) throw new HttpError(409, "This app is already set up. Sign in instead.");
      const token = await auth.createSession();
      return sendJson(res, 200, { codes }, { "set-cookie": sessionHeader(token) });
    }

    if (method === "POST" && path === "/api/auth/login/options") {
      if (!(await auth.isSetUp())) throw new HttpError(409, "Set up the app first.");
      const options = await webauthn.authenticationOptions(rp);
      return sendJson(res, 200, options, { "set-cookie": saveChallenge({ challenge: options.challenge, purpose: "login" }) });
    }

    if (method === "POST" && path === "/api/auth/login/verify") {
      const body = await readJson(req);
      const challenge = takeChallenge(req, "login");
      const response = body.response as AuthenticationResponseJSON | undefined;
      const passkey = typeof response?.id === "string" ? await auth.findPasskey(response.id) : null;
      if (passkey === null) {
        // Lets the page ask the passkey manager to forget a passkey this app no longer knows.
        return sendJson(res, 401, { error: "That passkey isn’t recognised here. Try again and pick another one.", unknownPasskey: true });
      }
      const counter = await webauthn.verifyAuthentication(rp, response!, challenge.challenge, passkey);
      if (counter === null) throw new HttpError(401, "That passkey isn’t recognised here.");
      await auth.markPasskeyUsed(passkey.id, counter);
      return sendJson(res, 200, { ok: true }, { "set-cookie": sessionHeader(await auth.createSession()) });
    }

    if (method === "POST" && path === "/api/auth/recover") {
      const cutoff = now() - RECOVERY_WINDOW_MS;
      while (recoveryFailures.length > 0 && recoveryFailures[0]! < cutoff) recoveryFailures.shift();
      if (recoveryFailures.length >= RECOVERY_MAX_FAILURES) throw new HttpError(429, "Too many attempts. Wait 15 minutes and try again.");
      const code = text((await readJson(req)).code, 40);
      if (!code || !(await auth.redeemRecoveryCode(code))) {
        recoveryFailures.push(now());
        throw new HttpError(401, "That code didn’t work. Check it and try again.");
      }
      return sendJson(res, 200, { ok: true }, { "set-cookie": sessionHeader(await auth.createSession(true)) });
    }

    if (method === "POST" && path === "/api/auth/logout") {
      await auth.endSession(cookies(req)[sessionCookie]);
      return sendJson(res, 200, { ok: true }, { "set-cookie": clearHeaders });
    }

    // --- passkeys (a recovery session may add one) ---------------------------
    if (method === "POST" && path === "/api/passkeys/options") {
      await requireSession(req, true);
      const user = await auth.user();
      const options = await webauthn.registrationOptions(rp, { id: user.id, name: user.name ?? "Me" }, await auth.passkeys());
      return sendJson(res, 200, options, { "set-cookie": saveChallenge({ challenge: options.challenge, purpose: "passkey" }) });
    }

    if (method === "POST" && path === "/api/passkeys/verify") {
      const token = await requireSession(req, true);
      const body = await readJson(req);
      const challenge = takeChallenge(req, "passkey");
      const verified = await webauthn.verifyRegistration(rp, body.response as RegistrationResponseJSON, challenge.challenge);
      if (verified === null) throw new HttpError(400, "That passkey could not be saved. Try again.");
      await auth.addPasskey(newPasskey(verified, req, text(body.name, 60)));
      await auth.upgradeSession(token);
      return sendJson(res, 200, { ok: true });
    }

    await requireSession(req);

    // --- settings ---------------------------------------------------------------
    if (method === "GET" && path === "/api/passkeys") {
      return sendJson(res, 200, { passkeys: await auth.passkeyList(), recoveryCodesLeft: await auth.recoveryCodesLeft() });
    }
    if (method === "DELETE" && path.startsWith("/api/passkeys/")) {
      const result = await auth.removePasskey(decodeURIComponent(path.slice("/api/passkeys/".length)));
      if (result === "missing") throw new HttpError(404, "That passkey is already gone.");
      if (result === "last") throw new HttpError(409, "Keep at least one passkey, or you can’t sign in.");
      return sendJson(res, 200, { ok: true });
    }
    if (method === "POST" && path === "/api/recovery-codes") return sendJson(res, 200, { codes: await auth.newRecoveryCodes() });

    // --- meetings ---------------------------------------------------------------
    if (method === "GET" && path === "/api/meetings") return sendJson(res, 200, { meetings: await recordings.meetings() });

    if (method === "GET" && path === "/api/transcript") return sendJson(res, 200, await transcript(url.searchParams.get("slug") ?? ""));

    if (method === "POST" && path === "/api/transcript/status") {
      const body = await readJson(req);
      const status = body.status === "new" ? "new" : "read";
      const slug = (await transcript(text(body.slug, 300))).id;
      await setTranscriptStatus(config.vaultRoot, slug, status);
      return sendJson(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/transcript/title") {
      const body = await readJson(req);
      const slug = (await transcript(text(body.slug, 300))).id;
      const title = text(body.title, 120);
      if (!title) throw new HttpError(400, "Give the meeting a name.");
      const result = await renameNote(config.vaultRoot, slug, title);
      if (!result.ok) throw new HttpError(409, "A meeting with that name already exists.");
      return sendJson(res, 200, { slug: result.slug });
    }

    if (method === "POST" && path === "/api/recordings") {
      const body = await readJson(req);
      const meta = await recordings.create({ title: text(body.title, 120), recorded: text(body.recorded, 40), mime: text(body.mime, 100) });
      return sendJson(res, 200, { id: meta.id, title: meta.title });
    }

    const match = /^\/api\/recordings\/([A-Za-z0-9_-]+)(?:\/(pieces\/(\d+)|finish|retry|title))?$/.exec(path);
    if (match !== null) {
      const id = match[1]!;
      const action = match[2];
      if (method === "PUT" && match[3] !== undefined) {
        const result = await recordings.putPiece(id, Number(match[3]), await readBody(req, MAX_PIECE_BYTES));
        if (result === "missing") throw new HttpError(404, "That recording is gone.");
        if (result === "closed") throw new HttpError(409, "That recording is already finished.");
        if (result === "invalid") throw new HttpError(400, "That piece number is not valid.");
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && action === "finish") {
        const body = await readJson(req);
        const result = await recordings.finish(id, { pieces: Number(body.pieces), duration: Number(body.duration) });
        if (!result.ok && result.reason === "missing") throw new HttpError(404, "That recording is gone.");
        if (!result.ok) return sendJson(res, 409, { error: "Some audio has not arrived yet.", missing: result.missing ?? [] });
        return sendJson(res, 200, { ok: true, status: result.meta.status });
      }
      if (method === "POST" && action === "retry") {
        if (!(await recordings.retry(id))) throw new HttpError(409, "Only a failed recording can be tried again.");
        return sendJson(res, 200, { ok: true });
      }
      if (method === "POST" && action === "title") {
        if (!(await recordings.rename(id, text((await readJson(req)).title, 120)))) throw new HttpError(409, "That recording can’t be renamed now.");
        return sendJson(res, 200, { ok: true });
      }
      if (method === "DELETE" && action === undefined) {
        if (!(await recordings.discard(id))) throw new HttpError(409, "That recording can’t be deleted now.");
        return sendJson(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, "Not found.");
  }

  return async (req, res) => {
    try {
      await route(req, res);
    } catch (error) {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      sendJson(res, 500, { error: "Something went wrong on the Mac. Check the capture log." });
    }
  };
}

export interface CaptureServer {
  url: string;
  close(): Promise<void>;
}

export async function startCaptureServer(deps: CaptureDeps, port = deps.config.port): Promise<CaptureServer> {
  const handler = createCaptureHandler(deps);
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, deps.config.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const bound = typeof address === "object" && address !== null ? address.port : port;
  return {
    url: `http://${deps.config.host}:${bound}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
