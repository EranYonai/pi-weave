/**
 * Keyed async mutation queue (core-owned; no harness dependencies).
 *
 * Serializes async mutators that touch the same resource key (e.g. a note
 * file path) so concurrent callers — parallel tool calls, multiple tools
 * writing at once — can't interleave writes. Replaces the pi harness's
 * `withFileMutationQueue` with a portable equivalent, per AGENTS.md rule 3
 * (logic lives in core; adapters stay thin).
 *
 * Properties:
 * - Tasks sharing a key run strictly one-after-another, in call order.
 * - Tasks with different keys run concurrently.
 * - A rejected task does NOT wedge the queue: its error propagates to its
 *   own caller, and later tasks for the same key still run.
 * - The value each task resolves with is passed through untouched.
 */

const queues = new Map<string, Promise<unknown>>();

export function withMutationQueue<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = queues.get(key) ?? Promise.resolve();
  // `prior` (as stored below) never rejects; the dual callbacks are
  // belt-and-braces so even a foreign promise in the map can't wedge us.
  const result = prior.then(() => task(), () => task());
  // Store a non-rejecting tail so a failure can't poison later tasks.
  queues.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}
