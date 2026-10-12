/** Polling `GET /api/trail`, alongside (not inside) the graph poll in `../workspace.ts`. */

import type { TrailPayload } from "../../shared/wire";
import type { FetchLike } from "../api";
import { fetchTrail } from "../api";
import { POLL_MS } from "../workspace";

export interface TrailPollOptions {
  fetch: FetchLike;
  onTrail: (trail: TrailPayload) => void;
  repeat?: (fn: () => void, ms: number) => () => void;
}

/**
 * Poll the trail every {@link POLL_MS}, revalidating on its stamp, and report
 * only fresh payloads. A failed poll keeps what was there: the trail is an
 * extra, and a blip must not blank it. Returns `stop`.
 */
export function startTrailPoll(opts: TrailPollOptions): () => void {
  let previous: TrailPayload | null = null;
  let stopped = false;
  let polling = false;
  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const result = await fetchTrail(opts.fetch, previous);
      if (stopped || !result.ok || result.cached) return;
      previous = result.data;
      opts.onTrail(result.data);
    } finally {
      polling = false;
    }
  };
  const repeat = opts.repeat ?? ((fn, ms) => {
    const timer = setInterval(fn, ms);
    return () => clearInterval(timer);
  });
  const cancel = repeat(() => void poll(), POLL_MS);
  void poll();
  return () => {
    stopped = true;
    cancel();
  };
}
