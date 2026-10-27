/* v8 ignore start -- process wiring; the bundle smoke test runs it */
import { main, packageVersion } from "./index";

// The bundle's entry: run `main` against the real process.
const code = await main(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  env: process.env,
  cwd: process.cwd(),
  version: packageVersion(),
});
process.exitCode = code;
/* v8 ignore stop */
