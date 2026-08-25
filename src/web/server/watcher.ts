/**
 * The filesystem watcher — the "something changed" half of liveness
 * (weave-workspace §6).
 *
 * ```text
 * fs.watch(vault,      {recursive}) ─┐
 * fs.watch(repo/.okf,  {recursive}) ─┼─▶ debounce 80ms ─▶ onPath (cache.invalidate)
 * git HEAD/index poll (2s)          ─┘                 ─▶ onChange(scopes) ─▶ SSE
 * ```
 *
 * ## Events are hints, never deltas
 *
 * macOS coalesces `fs.watch` events and can drop them under a rapid burst,
 * and recursive watches on every platform report renames and content writes
 * with the same `"rename" | "change"` vocabulary. So a change here means
 * "something in this scope moved, re-read it" and nothing more. Everything
 * downstream — the cache, the SSE frame, the client's refetch — is built on
 * that weaker promise, which is why a missed event costs latency rather than
 * correctness.
 *
 * ## Coalescing into a scope set, not a path list
 *
 * A `git checkout` or a `/weave-scan` touches hundreds of files. The
 * debounce collects them into a {@link ChangeScope} *set*, so one window
 * emits at most three frames (`vault`, `repo`, `git`) no matter how many
 * paths took part. Per-path work still happens — {@link WatcherOptions.onPath}
 * fires immediately for each accepted path so the cache can evict precisely —
 * but the broadcast is per scope.
 *
 * The window is **leading-edge opening, trailing-edge firing**: the first
 * accepted path opens an 80 ms window and every later path joins it without
 * restarting it. A restart-on-each-event debounce starves under a sustained
 * write stream (a large checkout would emit nothing until it finished);
 * this variant bounds notification latency at `debounceMs` regardless of
 * event rate, which is the property that matters for a live UI.
 *
 * ## Why git is polled rather than watched
 *
 * `<repo>/.git` is not under either watched root, and watching it directly
 * would mean absorbing the object database's write traffic to learn one bit.
 * A 2 s fingerprint of `HEAD`, the loose ref it points at, and `index`
 * catches branch switches, commits and staging with three `stat`/`read`
 * calls and no subprocess.
 */

import { promises as fs, watch, type FSWatcher } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { classifyPath } from "../../core/cache/workspace";
import { repoIndexDir } from "../../core/paths";
import { CHANGE_SCOPES, type ChangeScope } from "../shared/wire";

// --- injectable timers --------------------------------------------------------

/**
 * The two timing primitives this module needs, injected so tests never sleep.
 *
 * Cancellation is a returned closure rather than an opaque handle: it keeps
 * the interface free of `NodeJS.Timeout` (which a fake would have to forge)
 * and makes "cancel exactly the thing I scheduled" the only expressible
 * operation.
 */
export interface Scheduler {
  /** Run `fn` once after `ms`. Returns a cancel function; cancelling twice is safe. */
  delay(fn: () => void, ms: number): () => void;
  /** Run `fn` every `ms`. Returns a cancel function; cancelling twice is safe. */
  repeat(fn: () => void, ms: number): () => void;
}

/**
 * Real timers, `unref`'d so a watcher nobody closed cannot by itself keep the
 * pi session's process alive after shutdown.
 */
export const realScheduler: Scheduler = {
  delay(fn, ms) {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return () => clearTimeout(handle);
  },
  repeat(fn, ms) {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return () => clearInterval(handle);
  },
};

// --- the ignore list ----------------------------------------------------------

/** §6 defaults: 80 ms debounce, 2 s git poll, 200 ms self-write suppression. */
export const DEFAULT_DEBOUNCE_MS = 80;
export const DEFAULT_GIT_POLL_MS = 2_000;
export const DEFAULT_SUPPRESS_MS = 200;

/** Split a path on either separator, dropping empty and `.` segments. */
function segments(path: string): string[] {
  return path.split(/[\\/]/).filter((part) => part.length > 0 && part !== ".");
}

/**
 * True when a watch event for this path should be discarded outright.
 *
 * Takes the path **relative to the watched root** — that is what `fs.watch`
 * hands us, and it is also the only form in which a `.git` segment is
 * unambiguous. An absolute path could contain a directory literally named
 * `.git` somewhere above the root and would then be misread.
 *
 * The list, and why each entry is on it:
 *
 * | Pattern     | Source |
 * | ----------- | ------ |
 * | `.git/**`   | The object database writes constantly and means nothing to us. `HEAD` and `index` are the two exceptions — they are the branch-switch and staging signals, and are classified as the `git` scope. |
 * | `*.swp`     | vim's swap file, rewritten on every keystroke. |
 * | `*~`        | emacs/gedit backup on save — arrives paired with the real write. |
 * | `.#*`       | emacs lock symlink, created on first edit and removed on close. |
 * | `4913`      | vim's writability probe: created, `stat`ed and deleted before every single save. Named for the port-number-looking constant in `vim/src/fileio.c`. |
 * | `.DS_Store` | Finder rewrites it merely for opening the folder. |
 */
export function isIgnoredPath(path: string): boolean {
  const parts = segments(path);
  const gitAt = parts.indexOf(".git");
  if (gitAt >= 0) {
    // Everything under `.git` is noise except the two files §6 names, and
    // those only when they sit directly in the git directory.
    const rest = parts.slice(gitAt + 1);
    return !(rest.length === 1 && (rest[0] === "HEAD" || rest[0] === "index"));
  }
  const base = parts[parts.length - 1] ?? "";
  if (base === ".DS_Store" || base === "4913") return true;
  if (base.endsWith(".swp") || base.endsWith("~")) return true;
  return base.startsWith(".#");
}

/**
 * The scope a *non-ignored* event path belongs to, or `null` for "not our
 * business".
 *
 * `relPath` is relative to `root`; `root` is one of the watched roots.
 * Classification of everything outside `.git` is delegated to
 * {@link classifyPath} in `src/core/cache/workspace` — the same function the
 * cache uses to decide what an invalidation affects. Two implementations of
 * "is this a note?" would eventually disagree, and the disagreement would
 * present as a note that silently stops updating.
 */
export function inferScope(
  root: string,
  relPath: string,
  opts: { cwd: string; vaultRoot: string },
): ChangeScope | null {
  if (isIgnoredPath(relPath)) return null;
  // Survived the ignore list with a `.git` segment ⇒ it is HEAD or index.
  if (segments(relPath).includes(".git")) return "git";
  const scope = classifyPath(resolve(root, relPath), opts);
  return scope === "none" ? null : scope;
}

// --- watch handles ------------------------------------------------------------

/** The slice of `FSWatcher` this module uses. */
export interface WatchHandle {
  close(): void;
}

/**
 * Opens one recursive watch. Injected so tests can make it throw (the
 * network-filesystem case, §6 / §14) without mocking `node:fs` globally.
 *
 * `onEvent` receives the path relative to `root`, or `null` when the platform
 * declined to name the file — which is a legitimate outcome and means "assume
 * the whole root moved".
 */
export type OpenWatch = (
  root: string,
  onEvent: (relPath: string | null) => void,
  onError: (error: Error) => void,
) => WatchHandle;

/** `fs.watch` with the options §6 requires. Recursive is safe on `engines >= 20.13.0`. */
export const realOpenWatch: OpenWatch = (root, onEvent, onError) => {
  const watcher: FSWatcher = watch(root, { recursive: true, persistent: false }, (_type, filename) => {
    onEvent(typeof filename === "string" ? filename : null);
  });
  watcher.on("error", onError);
  return watcher;
};

// --- status -------------------------------------------------------------------

/** One root that `fs.watch` refused, with the reason. */
export interface WatchFailure {
  root: string;
  error: string;
}

/**
 * What {@link Watcher.start} achieved.
 *
 * `available === false` is the signal §14 calls for: the caller falls back to
 * polling `/api/graph` for a changed stamp instead of assuming liveness it is
 * not getting. It is never an exception — a container or network filesystem
 * without `inotify` must degrade the workspace, not fail to open it.
 */
export interface WatcherStatus {
  /** Roots currently under an open watch. */
  watching: string[];
  /** Roots that could not be watched, and why. */
  failed: WatchFailure[];
  /** True while at least one root is watched. */
  available: boolean;
}

export interface WatcherOptions {
  /** Repository/working directory. `<cwd>/.okf` is the second watched root. */
  cwd: string;
  /** Vault root (`~/.okf` by default). The first watched root. */
  vaultRoot: string;
  /**
   * One call per debounce window, with the scopes that changed, in
   * {@link CHANGE_SCOPES} order. Never called with an empty list.
   */
  onChange: (scopes: readonly ChangeScope[]) => void;
  /**
   * One call per accepted path, immediately — not debounced. This is
   * `cache.invalidate(path)` in the §6 diagram: eviction wants every path,
   * the broadcast wants one frame per scope.
   */
  onPath?: (absPath: string, scope: ChangeScope) => void;
  /** Injected clock in epoch ms, for suppression windows. */
  now?: () => number;
  debounceMs?: number;
  gitPollMs?: number;
  scheduler?: Scheduler;
  openWatch?: OpenWatch;
}

/** Fingerprint components of the git directory. Empty string = absent. */
interface GitFingerprint {
  head: string;
  ref: string;
  index: string;
}

function sameFingerprint(a: GitFingerprint, b: GitFingerprint): boolean {
  return a.head === b.head && a.ref === b.ref && a.index === b.index;
}

/**
 * Watches the vault and the repository index, and polls git.
 *
 * A class for the same reason {@link classifyPath}'s owner is: this has a
 * lifetime, open OS handles and mutable state that a caller must be able to
 * `close()`. Everything decision-shaped is a pure exported function above, so
 * the class holds wiring only.
 */
export class Watcher {
  private readonly cwd: string;
  private readonly vaultRoot: string;
  private readonly onChange: (scopes: readonly ChangeScope[]) => void;
  private readonly onPath: ((absPath: string, scope: ChangeScope) => void) | undefined;
  private readonly now: () => number;
  private readonly debounceMs: number;
  private readonly gitPollMs: number;
  private readonly scheduler: Scheduler;
  private readonly openWatch: OpenWatch;

  /** Watched root → its open handle. */
  private readonly handles = new Map<string, WatchHandle>();
  private readonly failures: WatchFailure[] = [];

  /** Scopes accumulated by the currently open debounce window. */
  private readonly pending = new Set<ChangeScope>();
  private cancelDebounce: (() => void) | null = null;
  private cancelPoll: (() => void) | null = null;

  /** Absolute path → epoch ms at which its self-write suppression expires. */
  private readonly suppressed = new Map<string, number>();

  /** `null` until the first poll establishes a baseline to compare against. */
  private gitSeen: GitFingerprint | null = null;

  private started = false;
  private closed = false;

  constructor(opts: WatcherOptions) {
    this.cwd = opts.cwd;
    this.vaultRoot = opts.vaultRoot;
    this.onChange = opts.onChange;
    this.onPath = opts.onPath;
    this.now = opts.now ?? (() => Date.now());
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.gitPollMs = opts.gitPollMs ?? DEFAULT_GIT_POLL_MS;
    this.scheduler = opts.scheduler ?? realScheduler;
    this.openWatch = opts.openWatch ?? realOpenWatch;
  }

  /**
   * Open the watches and start the git poll.
   *
   * Never throws. A root that cannot be watched is recorded in
   * {@link WatcherStatus.failed} and the others still run; if every root
   * fails, `available` is false and the caller falls back to stamp polling.
   */
  start(): WatcherStatus {
    if (this.started) return this.status();
    this.started = true;
    for (const root of [this.vaultRoot, repoIndexDir(this.cwd)]) {
      this.open(root);
    }
    this.cancelPoll = this.scheduler.repeat(() => void this.pollGitOnce(), this.gitPollMs);
    return this.status();
  }

  /** Current watch health. Reflects roots lost to a runtime error, not just startup. */
  status(): WatcherStatus {
    return {
      watching: [...this.handles.keys()],
      failed: this.failures.map((f) => ({ ...f })),
      available: this.handles.size > 0,
    };
  }

  /**
   * Ignore changes to `absPath` for the next `ms`.
   *
   * `POST /api/open` (and, at P5, a browser save) writes through the same
   * filesystem the watcher is watching, so without this the write comes
   * straight back as a change event, which broadcasts, which makes the client
   * refetch what it just caused. A window rather than a one-shot flag because
   * a single logical save can produce several events — the editor's temp
   * file, the rename, the mtime touch.
   */
  suppress(absPath: string, ms: number = DEFAULT_SUPPRESS_MS): void {
    this.suppressed.set(resolve(absPath), this.now() + ms);
  }

  /**
   * Stop everything: close the OS handles, cancel the debounce window and the
   * poll. Idempotent, because both `session_shutdown` and an explicit stop can
   * plausibly arrive.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handle of this.handles.values()) safeClose(handle);
    this.handles.clear();
    this.cancelDebounce?.();
    this.cancelDebounce = null;
    this.cancelPoll?.();
    this.cancelPoll = null;
    this.pending.clear();
  }

  /**
   * One git fingerprint comparison. The body of the poll, exposed so tests
   * drive it directly instead of waiting 2 s.
   *
   * The first call only establishes a baseline: at startup nothing has
   * changed yet, and emitting a `git` frame for the state the client already
   * fetched would be a spurious refetch on every boot.
   */
  async pollGitOnce(): Promise<void> {
    if (this.closed) return;
    const next = await readGitFingerprint(this.cwd);
    const previous = this.gitSeen;
    this.gitSeen = next;
    if (previous === null || sameFingerprint(previous, next)) return;
    this.enqueue("git");
  }

  // --- internals --------------------------------------------------------------

  private open(root: string): void {
    try {
      const handle = this.openWatch(
        root,
        (relPath) => this.onEvent(root, relPath),
        (error) => this.onWatchError(root, error),
      );
      this.handles.set(root, handle);
    } catch (error) {
      this.failures.push({ root, error: messageOf(error) });
    }
  }

  /**
   * A watch that dies mid-session (the directory was deleted, inotify ran out
   * of handles) is demoted to a failure rather than left in `watching`, so
   * `available` stays an honest answer to "is liveness working right now?".
   */
  private onWatchError(root: string, error: Error): void {
    const handle = this.handles.get(root);
    if (handle === undefined) return;
    safeClose(handle);
    this.handles.delete(root);
    this.failures.push({ root, error: messageOf(error) });
  }

  private onEvent(root: string, relPath: string | null): void {
    if (this.closed) return;
    if (relPath === null) {
      // The platform declined to name the file. Treat the whole root as dirty
      // rather than guessing — this is the "hint, not delta" contract paying
      // for itself.
      this.enqueue(rootScope(root, this.vaultRoot));
      return;
    }
    const scope = inferScope(root, relPath, { cwd: this.cwd, vaultRoot: this.vaultRoot });
    if (scope === null) return;
    const abs = resolve(root, relPath);
    if (this.isSuppressed(abs)) return;
    this.onPath?.(abs, scope);
    this.enqueue(scope);
  }

  /** True while `abs` is inside its self-write window. Expired entries are reaped. */
  private isSuppressed(abs: string): boolean {
    const until = this.suppressed.get(abs);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.suppressed.delete(abs);
    return false;
  }

  /**
   * Add a scope to the open window, opening one if there is none. The window
   * is deliberately *not* restarted by later events — see the module header.
   */
  private enqueue(scope: ChangeScope): void {
    this.pending.add(scope);
    if (this.cancelDebounce !== null) return;
    this.cancelDebounce = this.scheduler.delay(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    this.cancelDebounce = null;
    if (this.closed || this.pending.size === 0) return;
    const scopes = CHANGE_SCOPES.filter((scope) => this.pending.has(scope));
    this.pending.clear();
    this.onChange(scopes);
  }
}

/** Which scope an unnamed event on a watched root implies. */
function rootScope(root: string, vaultRoot: string): ChangeScope {
  return resolve(root) === resolve(vaultRoot) ? "vault" : "repo";
}

function safeClose(handle: WatchHandle): void {
  try {
    handle.close();
  } catch {
    // Already closed, or the handle died with its directory. Either way there
    // is nothing left to release and shutdown must not fail because of it.
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// --- git fingerprint ----------------------------------------------------------

/**
 * Resolve the real git directory for `cwd`.
 *
 * Usually `<cwd>/.git`, but in a linked worktree or a submodule `.git` is a
 * *file* containing `gitdir: <path>`. Following it costs four lines and is the
 * difference between working and silently never reporting a branch switch for
 * everyone who uses `git worktree`.
 */
async function resolveGitDir(cwd: string): Promise<string> {
  const dotGit = join(cwd, ".git");
  const stat = await fs.stat(dotGit).catch(() => null);
  if (stat === null || stat.isDirectory()) return dotGit;
  const text = (await fs.readFile(dotGit, "utf8").catch(() => "")).trim();
  const match = /^gitdir:\s*(.+)$/.exec(text);
  if (match === null) return dotGit;
  const target = match[1]!.trim();
  return isAbsolute(target) ? target : resolve(cwd, target);
}

/**
 * A cheap, total fingerprint of "which commit are we on, and what is staged".
 *
 * - `HEAD` text: `ref: refs/heads/main` or a bare sha when detached. Catches
 *   every branch switch.
 * - the loose ref file `HEAD` names: catches commits, which move the ref but
 *   leave `HEAD` byte-identical. A commit always writes a *loose* ref, so not
 *   consulting `packed-refs` costs nothing — a packed ref is by definition one
 *   that has not moved since the pack.
 * - `index` size and mtime: catches staging without reading a file that is
 *   routinely megabytes.
 *
 * Every read is best-effort. Outside a repository all three parts stay empty,
 * the fingerprint never changes, and the poll is a no-op forever.
 */
async function readGitFingerprint(cwd: string): Promise<GitFingerprint> {
  const gitDir = await resolveGitDir(cwd);
  const head = (await fs.readFile(join(gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  const refMatch = /^ref:\s*(.+)$/.exec(head);
  const ref =
    refMatch === null
      ? ""
      : (await fs.readFile(join(gitDir, refMatch[1]!.trim()), "utf8").catch(() => "")).trim();
  const indexStat = await fs.stat(join(gitDir, "index")).catch(() => null);
  const index = indexStat === null ? "" : `${indexStat.size}:${indexStat.mtimeMs}`;
  return { head, ref, index };
}

