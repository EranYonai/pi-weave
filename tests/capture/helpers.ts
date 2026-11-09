import { request } from "node:http";
import type { StoredPasskey } from "../../src/capture/server/auth";
import type { WebAuthn } from "../../src/capture/server/webauthn";

export const ORIGIN = "http://cap.test";

export interface Reply {
  status: number;
  body: any;
  text: string;
  headers: Record<string, string | string[] | undefined>;
}

/** A tiny cookie-keeping client for the capture server. */
export class Client {
  jar = new Map<string, string>();

  constructor(
    private readonly base: string,
    public host = "cap.test",
    public origin: string | null = ORIGIN,
  ) {}

  send(method: string, path: string, body?: unknown, raw?: Buffer, extra: Record<string, string> = {}): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const payload = raw ?? (body === undefined ? undefined : Buffer.from(JSON.stringify(body)));
      const headers: Record<string, string> = { host: this.host, ...extra };
      if (this.origin !== null && method !== "GET") headers.origin = this.origin;
      if (this.jar.size > 0) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
      if (payload) headers["content-length"] = String(payload.length);
      const req = request(`${this.base}${path}`, { method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const set = res.headers["set-cookie"] ?? [];
          for (const line of set) {
            const [pair] = line.split(";");
            const eq = pair!.indexOf("=");
            const name = pair!.slice(0, eq);
            const value = pair!.slice(eq + 1);
            if (value === "" || /Max-Age=0/.test(line)) this.jar.delete(name);
            else this.jar.set(name, value);
          }
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = null;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, text, headers: res.headers });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  get(path: string) {
    return this.send("GET", path);
  }
  post(path: string, body: unknown = {}) {
    return this.send("POST", path, body);
  }
}

/**
 * A stand-in authenticator: registration responses carry `{ id, ok }` and
 * authentication responses `{ id, ok }`; `ok: false` fails verification.
 */
export const fakeWebAuthn: WebAuthn = {
  async registrationOptions(rp, user, existing) {
    return {
      challenge: `reg-${Math.random().toString(36).slice(2)}`,
      rp: { id: rp.rpId, name: "Weave Capture" },
      user: { id: user.id, name: user.name, displayName: user.name },
      pubKeyCredParams: [],
      excludeCredentials: existing.map((p: StoredPasskey) => ({ id: p.id, type: "public-key" as const })),
    };
  },
  async verifyRegistration(_rp, response) {
    const r = response as unknown as { id: string; ok: boolean };
    return r?.ok ? { id: r.id, publicKey: "pk", counter: 0, transports: ["internal"] } : null;
  },
  async authenticationOptions() {
    return { challenge: `auth-${Math.random().toString(36).slice(2)}` };
  },
  async verifyAuthentication(_rp, response, _challenge, passkey) {
    const r = response as unknown as { ok: boolean };
    return r.ok ? passkey.counter + 1 : null;
  },
};
