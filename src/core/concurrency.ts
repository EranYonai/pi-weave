/**
 * Bounded-concurrency task runner shared by the deep scan (summaries.ts) and
 * the session scan (sessions.ts).
 *
 * Extracted from summaries.ts so the two scanners cannot drift: a second copy
 * of the scheduler is a second place for an off-by-one or a lost
 * cancellation check.
 */

/**
 * Map `items` through `fn` with at most `concurrency` tasks in flight.
 *
 * Results keep input order. `shouldStop` is checked before each item is
 * taken; when it returns true, workers drain immediately and unprocessed
 * entries keep their slot in the results array (untouched — callers that
 * care about partial output must check `shouldStop` themselves, exactly as
 * the abort-aware scanners do).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop?: () => boolean,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      if (shouldStop?.()) return;
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  return results;
}