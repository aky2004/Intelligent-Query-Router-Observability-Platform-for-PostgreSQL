/**
 * Per-node circuit breaker for the connection pool.
 *
 * States:
 *   CLOSED   → normal operation; all requests pass through
 *   OPEN     → node tripped; requests routed elsewhere immediately
 *   HALF_OPEN → one probe request allowed; success closes, failure reopens
 *
 * Configuration (env-driven, sane defaults):
 *   CIRCUIT_FAILURE_THRESHOLD  – consecutive failures before tripping   (default 5)
 *   CIRCUIT_SUCCESS_THRESHOLD  – consecutive successes to close half-open (default 2)
 *   CIRCUIT_RECOVERY_MS        – ms to wait in OPEN before probing       (default 15 000)
 */

import { logger } from "../utils/logger";

const FAILURE_THRESHOLD = Number(process.env.CIRCUIT_FAILURE_THRESHOLD ?? 5);
const SUCCESS_THRESHOLD = Number(process.env.CIRCUIT_SUCCESS_THRESHOLD ?? 2);
const RECOVERY_MS = Number(process.env.CIRCUIT_RECOVERY_MS ?? 15_000);

type State = "CLOSED" | "OPEN" | "HALF_OPEN";

interface Breaker {
  state: State;
  failures: number;
  successes: number;
  openedAt: number | null;
}

const breakers = new Map<string, Breaker>();

const get = (nodeId: string): Breaker => {
  if (!breakers.has(nodeId)) {
    breakers.set(nodeId, { state: "CLOSED", failures: 0, successes: 0, openedAt: null });
  }
  return breakers.get(nodeId)!;
};

/** Returns true if the node is currently allowed to receive requests. */
export const isAllowed = (nodeId: string): boolean => {
  const b = get(nodeId);
  if (b.state === "CLOSED") return true;
  if (b.state === "OPEN") {
    if (b.openedAt !== null && Date.now() - b.openedAt >= RECOVERY_MS) {
      b.state = "HALF_OPEN";
      b.successes = 0;
      logger.info("Circuit breaker HALF_OPEN", { nodeId });
      return true; // allow one probe
    }
    return false;
  }
  // HALF_OPEN: allow exactly one probe at a time
  return true;
};

/** Call after a successful query on this node. */
export const recordSuccess = (nodeId: string): void => {
  const b = get(nodeId);
  if (b.state === "CLOSED") {
    b.failures = 0;
    return;
  }
  b.successes += 1;
  if (b.successes >= SUCCESS_THRESHOLD) {
    b.state = "CLOSED";
    b.failures = 0;
    b.successes = 0;
    b.openedAt = null;
    logger.info("Circuit breaker CLOSED", { nodeId });
  }
};

/** Call after a failed query on this node. */
export const recordFailure = (nodeId: string): void => {
  const b = get(nodeId);
  b.failures += 1;
  b.successes = 0;
  if (b.state === "HALF_OPEN" || b.failures >= FAILURE_THRESHOLD) {
    b.state = "OPEN";
    b.openedAt = Date.now();
    logger.error("Circuit breaker OPEN — node excluded from routing", { nodeId, failures: b.failures });
  }
};

export const getState = (nodeId: string): State => get(nodeId).state;

/** Export a snapshot of all breaker states for the dashboard. */
export const getAllBreakers = (): Array<{ nodeId: string; state: State; failures: number }> =>
  [...breakers.entries()].map(([nodeId, b]) => ({ nodeId, state: b.state, failures: b.failures }));
