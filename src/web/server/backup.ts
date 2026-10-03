/** Create a complete archive before offering a download; originals are read only. */
import { createReadStream } from "node:fs";
import { mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Zip, ZipDeflate } from "fflate";

export async function createVaultBackup(vaultRoot: string): Promise<{ path: string; dispose: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-weave-backup-"));
  const path = join(directory, "vault.zip");
  const dispose = (): Promise<void> => rm(directory, { recursive: true, force: true });
  try {
    const output = await open(path, "w");
    try {
      let pending = Promise.resolve();
      let failure: Error | null = null;
      let entries = 0;
      const zip = new Zip((error, chunk) => {
        if (error) { failure = error; return; }
        pending = pending.then(() => output.writeFile(chunk));
      });
      const flush = async (): Promise<void> => { await pending; if (failure) throw failure; };
      const walk = async (directory: string, prefix: string, ancestors: ReadonlySet<string>): Promise<void> => {
        const resolved = await realpath(directory);
        if (ancestors.has(resolved)) throw new Error(`Symbolic-link cycle in vault: ${prefix}`);
        const next = new Set([...ancestors, resolved]);
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          // ZIP readers on Windows treat backslashes as path separators.
          if (entry.name.includes("\\")) throw new Error(`Unsupported backup filename: ${entry.name}`);
          const source = join(directory, entry.name);
          const info = await stat(source);
          const name = prefix + entry.name + (info.isDirectory() ? "/" : "");
          if (!info.isDirectory() && !info.isFile()) throw new Error(`Unsupported vault entry: ${name}`);
          if (++entries > 65535 || info.isFile() && info.size > 0xffffffff) throw new Error("Vault exceeds ZIP format limits");
          const file = new ZipDeflate(name, { level: 1 });
          file.mtime = new Date(Math.max(new Date(1980, 0, 1).getTime(), Math.min(new Date(2099, 11, 31).getTime(), info.mtime.getTime())));
          zip.add(file);
          await flush();
          if (info.isDirectory()) {
            file.push(new Uint8Array(), true);
            await flush();
            await walk(source, name, next);
          } else {
            for await (const chunk of createReadStream(source)) {
              file.push(chunk as Uint8Array);
              await flush();
            }
            file.push(new Uint8Array(), true);
            await flush();
          }
        }
      };
      await walk(vaultRoot, "", new Set());
      zip.end();
      await flush();
    } finally { await output.close(); }
    return { path, dispose };
  } catch (error) { await dispose(); throw error; }
}
