/* v8 ignore start -- process wiring; the bundle smoke test runs it */
import { resolve } from "node:path";
import { main } from "./index";

// The bundle's entry: run `main` against the real process. `argv[1]` is the
// bundle itself, which the launch agent runs again at login.
process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  env: process.env,
  script: resolve(process.argv[1] ?? "pi-weave-capture"),
});
/* v8 ignore stop */
