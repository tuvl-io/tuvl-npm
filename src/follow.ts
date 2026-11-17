/**
 * Following a run's journal without losing the thread when the connection does.
 *
 * A followed stream that ends is not a run that ended: a proxy times the connection out, a pod restarts, the network
 * drops. Only the run's last event, or a terminal status, says it is over. Anything else reopens the stream from the
 * last position read (`from_seq` is inclusive and journal positions have gaps, so the next one is the last plus one,
 * never a count) and skips what was already delivered.
 *
 * Draft frames (`token_delta`) carry no position, so a draft cannot be resumed: after a reconnect the caller gets a
 * `token_reset` for every draft it was showing, and the engine sends the draft so far once more (`replay: true`).
 */

import { MAX_TRANSIENT, pause, sleep, transient } from "./retry";
import { parseSseEvents } from "./sse";
import { isTokenEvent, TERMINAL_STATUSES, TuvlStreamError, type Run, type RunStreamEvent } from "./types";

/** After one of these there is nothing more in the journal. */
const LAST_EVENTS: ReadonlySet<string> = new Set(["run_completed", "run_failed", "run_aborted"]);
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 8_000;
/** A connection that stayed open this long was working, so the failures before it no longer count. */
const HEALTHY_MS = 5_000;

export interface FollowSource {
  /** Open `GET /api/runs/{id}/events` from `fromSeq`; with `replayOnly` it replays what is there and ends by itself. */
  open(fromSeq: number | undefined, replayOnly: boolean): Promise<Response>;
  /** The run as the server has it now. */
  status(): Promise<Run>;
}

export async function* followRun(
  runId: string,
  source: FollowSource,
  options: { fromSeq?: number; follow?: boolean; signal?: AbortSignal } = {},
): AsyncGenerator<RunStreamEvent> {
  const { signal } = options;
  if (options.follow === false) {
    yield* parseSseEvents(await source.open(options.fromSeq, false), signal);
    return;
  }

  let next = options.fromSeq;
  let last: number | undefined;
  const drafting = new Set<string>();
  let failures = 0;
  let cause: unknown;
  let opened = false;
  let replayOnly = false;

  for (;;) {
    cause = undefined;
    if (opened) {
      for (const agent of drafting) yield { type: "token_reset", run_id: runId, agent_id: agent };
      drafting.clear();
    }
    let connectedAt: number | undefined;
    let progressed = false;
    let ended = false;
    try {
      const response = await source.open(next, replayOnly);
      opened = true;
      connectedAt = Date.now();
      for await (const event of parseSseEvents(response, signal)) {
        if (isTokenEvent(event)) {
          if (event.type === "token_delta") drafting.add(event.agent_id);
          else drafting.delete(event.agent_id);
          yield event;
          continue;
        }
        if (last !== undefined && event.seq <= last) continue;
        last = event.seq;
        next = event.seq + 1;
        progressed = true;
        yield event;
        if (LAST_EVENTS.has(event.type)) return;
      }
      ended = true;
    } catch (error) {
      if (signal?.aborted) return;
      if (!opened || !transient(error)) throw error;
      cause = error;
    }
    if (signal?.aborted) return;
    if (replayOnly && ended) return;
    if (progressed || (connectedAt !== undefined && Date.now() - connectedAt >= HEALTHY_MS)) failures = 0;

    if (!replayOnly && connectedAt !== undefined) {
      try {
        if (TERMINAL_STATUSES.includes((await source.status()).status)) {
          replayOnly = true;
          continue;
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (!transient(error)) throw error;
        cause = error;
      }
    }

    // (a connection that never opened says nothing about the run, so it is retried without asking)
    failures += 1;
    if (failures > MAX_TRANSIENT) throw new TuvlStreamError(runId, last, cause);
    try {
      await sleep(pause(failures, cause, RECONNECT_BASE_MS, RECONNECT_CAP_MS), signal);
    } catch {
      return;
    }
  }
}
