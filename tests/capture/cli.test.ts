import { promises as fs } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { Writable } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";
import { launchAgent, LAUNCH_LABEL, main } from "../../src/capture/server/index";
import { makeTempDir } from "../helpers";

let home: string;
let out: string;
let calls: string[][];
const stdout = () =>
  new Writable({
    write(chunk, _enc, done) {
      out += String(chunk);
      done();
    },
  });

beforeEach(async () => {
  home = await makeTempDir();
  out = "";
  calls = [];
});

const io = (extra: Partial<Parameters<typeof main>[1]> = {}) => ({
  stdout: stdout(),
  env: { PATH: "/usr/bin", PI_WEAVE_VAULT: join(home, "vault"), PI_WEAVE_CAPTURE_DIR: join(home, "cap") },
  script: "/opt/pi-weave/src/capture/dist/capture.mjs",
  home,
  uid: 501,
  run: async (program: string, args: readonly string[]) => {
    calls.push([program, ...args]);
  },
  ...extra,
});

describe("pi-weave-capture", () => {
  it("prints usage for an unknown command and refuses a bad port", async () => {
    expect(await main(["frobnicate"], io())).toBe(2);
    expect(out).toContain("usage: pi-weave-capture");
    expect(await main(["serve", "--port", "nope"], io())).toBe(2);
    expect(out).toContain("invalid port");
  });

  it("doctor reports what is missing and the tunnel steps", async () => {
    expect(await main(["doctor"], io({ run: async (p) => { if (p === "whisper-cli") throw new Error("no"); } }))).toBe(1);
    expect(out).toContain("ok    ffmpeg");
    expect(out).toContain("MISS  whisper.cpp");
    expect(out).toContain("brew install whisper-cpp");
    expect(out).toContain("MISS  model");
    expect(out).toContain("cloudflared tunnel route dns weave weave.manta.run");
    await fs.mkdir(join(home, "cap", "models"), { recursive: true });
    await fs.writeFile(join(home, "cap", "models", "ggml-large-v3-turbo.bin"), "");
    out = "";
    expect(await main(["doctor"], io())).toBe(0);
    expect(out).not.toContain("MISS");
  });

  it("installs and removes the launch agent", async () => {
    expect(await main(["install", "--port", "3311"], io())).toBe(0);
    const plist = join(home, "Library", "LaunchAgents", `${LAUNCH_LABEL}.plist`);
    const text = await fs.readFile(plist, "utf8");
    expect(text).toContain("<string>/opt/pi-weave/src/capture/dist/capture.mjs</string>\n    <string>serve</string>\n    <string>--port</string>\n    <string>3311</string>");
    expect(text).toContain("<key>PI_WEAVE_VAULT</key>");
    expect(text).toContain("/opt/homebrew/bin:/usr/local/bin:/usr/bin");
    expect(calls).toEqual([
      ["launchctl", "bootout", "gui/501", plist],
      ["launchctl", "bootstrap", "gui/501", plist],
    ]);
    expect(await main(["uninstall"], io({ run: async () => { throw new Error("not loaded"); } }))).toBe(0);
    await expect(fs.access(plist)).rejects.toThrow();
    expect(await main(["install"], io({ env: {}, run: async (p, a) => { if (a[0] === "bootout") throw new Error("x"); } }))).toBe(0);
  });

  it("escapes values in the launch agent", () => {
    expect(launchAgent("/n", "/s & <t>", [], { A: "x<y" }, "/l")).toContain("<string>/s &amp; &lt;t&gt;</string>");
  });

  it("serves until told to stop", async () => {
    let health = "";
    const code = await main(["--port", "0", "--origin", "http://cap.test"], io({
      wait: async (server) => {
        health = await new Promise((resolve) => {
          request(`${server.url}/api/health`, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => resolve(body));
          }).end();
        });
        await server.close();
      },
    }));
    expect(code).toBe(0);
    expect(health).toBe('{"ok":true}');
    expect(out).toContain("published as http://cap.test");
  });
});
