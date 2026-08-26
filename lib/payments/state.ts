/**
 * Canonical Payment State Derivation — M3
 *
 * Answers: "What is the current factual payment state for this underlying
 * payment, based on the Razorpay webhook events RecoverAI has received?"
 *
 * ─── General Rule ────────────────────────────────────────────────────────────
 *
 * State is derived using EVENT-TYPE FINALITY PRECEDENCE:
 *
 *   CAPTURED (rank 3) > AUTHORIZED (rank 2) > FAILED (rank 1) > UNKNOWN (rank 0)
 *
 * From all webhook events for a payment, the canonical state is the one
 * carried by the event type with the highest finality rank.
 *
 * `payment_link.paid` is a correlation/confirmation signal only. It carries
 * no independent payment state rank and does not compete in the precedence
 * order. A Payment Link transaction that produces payment.authorized +
 * payment.captured + payment_link.paid resolves to CAPTURED.
 *
 * ─── Why finality precedence is semantically correct ─────────────────────────
 *
 * Razorpay's payment lifecycle has irreversible positive finality:
 * - A captured payment cannot become un-captured.
 * - A payment.failed event received after payment.captured is a webhook
 *   delivery artifact (out-of-order or retry), not a state reversal.
 * - authorization is a transient state that terminates in either capture
 *   or failure; it never supersedes a completed capture.
 *
 * This rule correctly handles ALL valid event orderings without special cases:
 *
 *   failed                        → FAILED
 *   authorized                    → AUTHORIZED
 *   captured                      → CAPTURED
 *   failed → authorized           → AUTHORIZED
 *   authorized → captured         → CAPTURED
 *   failed → captured             → CAPTURED
 *   captured → failed             → CAPTURED   (finality preserved)
 *   authorized → failed → captured → CAPTURED
 *   payment_link.paid + captured  → CAPTURED
 *   duplicates of any event       → same state (idempotent by design)
 *
 * ─── MUST NOT be imported in browser-side code ───────────────────────────────
 */

import { getDb } from "../db/client";

// ─── State types ──────────────────────────────────────────────────────────────

export type PaymentState = "UNKNOWN" | "FAILED" | "AUTHORIZED" | "CAPTURED";

/**
 * The finality rank of each state-bearing event type.
 *
 * Higher rank = higher finality = wins in the precedence order.
 * `payment_link.paid` is NOT included — it is a correlation signal, not a
 * payment state event. It carries no rank.
 */
const FINALITY_RANK: Record<string, number> = {
  "payment.failed":     1,
  "payment.authorized": 2,
  "payment.captured":   3,
};

const RANK_TO_STATE: Record<number, PaymentState> = {
  0: "UNKNOWN",
  1: "FAILED",
  2: "AUTHORIZED",
  3: "CAPTURED",
};

// ─── Correlation query ────────────────────────────────────────────────────────

/**
 * Retrieves all webhook event types associated with a given payment ID.
 *
 * Correlation strategy:
 *   The canonical payment ID (`pay_xxx`) is stored in:
 *     - `related_entity_id` for payment.* events
 *     - `payload.payment.entity.id` inside `raw_payload` for payment_link.paid
 *
 *   We use `json_extract` on `raw_payload` as the single authoritative lookup,
 *   which works uniformly for all event types including payment_link.paid.
 *
 *   The existing `idx_webhook_events_related_entity_id` index on the
 *   `related_entity_id` column covers payment.* lookups efficiently.
 *   SQLite does not index json_extract expressions without a generated column,
 *   so payment_link.paid correlation relies on the full table scan being
 *   acceptable at current scale. This is noted for M5 optimisation if needed.
 */
function getEventTypesForPayment(paymentId: string): string[] {
  const db = getDb();

  const rows = db.prepare(`
    SELECT DISTINCT event_type
    FROM   webhook_events
    WHERE  json_extract(raw_payload, '$.payload.payment.entity.id') = ?
  `).all(paymentId) as { event_type: string }[];

  return rows.map((r) => r.event_type);
}

// ─── State derivation ─────────────────────────────────────────────────────────

/**
 * Derives the canonical payment state for a given payment ID.
 *
 * The derivation is deterministic and order-independent:
 * it finds the maximum finality rank across all event types received
 * for this payment and maps it to the corresponding state.
 *
 * Returns `UNKNOWN` if no recognised state-bearing events have been received.
 */
export function derivePaymentState(paymentId: string): PaymentState {
  const eventTypes = getEventTypesForPayment(paymentId);

  let maxRank = 0;

  for (const eventType of eventTypes) {
    const rank = FINALITY_RANK[eventType] ?? 0;
    if (rank > maxRank) {
      maxRank = rank;
    }
  }

  return RANK_TO_STATE[maxRank] ?? "UNKNOWN";
}

/**
 * Derives the canonical payment state from a pre-supplied list of event types.
 *
 * This is the pure, database-free version of the derivation logic.
 * Useful for unit testing and for callers that have already fetched the events.
 *
 * `payment_link.paid` in the list is silently ignored (no finality rank).
 */
export function derivePaymentStateFromEvents(eventTypes: string[]): PaymentState {
  let maxRank = 0;

  for (const eventType of eventTypes) {
    const rank = FINALITY_RANK[eventType] ?? 0;
    if (rank > maxRank) {
      maxRank = rank;
    }
  }

  return RANK_TO_STATE[maxRank] ?? "UNKNOWN";
}
