/**
 * Payment Reconciliation — M5
 *
 * Answers: "Do our persisted webhook-derived state (M3) and Razorpay's
 * current API observation (M4) agree, and if not, what is the discrepancy?"
 *
 * ─── Architectural position ───────────────────────────────────────────────────
 *
 * M3 (primary):  webhook_events → derivePaymentState() → UNKNOWN/FAILED/AUTHORIZED/CAPTURED
 * M4 (fallback): Razorpay API   → fetchPaymentStatus() → RazorpayPaymentFetchResult
 * M5 (compare):  M3 + M4        → reconcilePayment()  → ReconciliationResult
 *
 * M5 MUST NOT:
 *   - mutate M3's PaymentState
 *   - insert/update the database
 *   - modify webhook_events
 *   - add polling, cron, or background jobs
 *   - declare "API always wins" or "Webhook always wins"
 *   - add REFUNDED or RECOVERED to M3's PaymentState
 *
 * M5 composes M3 and M4; it duplicates neither.
 *
 * ─── Reconciliation outcomes ──────────────────────────────────────────────────
 *
 * CONSISTENT
 *   Both M3 and M4 agree on the same effective payment outcome.
 *   Examples: M3=CAPTURED + API=captured, M3=FAILED + API=failed
 *
 * API_AHEAD
 *   The Razorpay API shows a more final successful state than the webhook
 *   history currently reflects. A webhook may be delayed or missing.
 *   Examples: M3=AUTHORIZED + API=captured, M3=UNKNOWN + API=captured
 *
 * WEBHOOK_AHEAD
 *   Webhook-derived state is more final than the API observation.
 *   Not automatically impossible — captures may take time to fully propagate
 *   across all Razorpay systems, or the observation may be momentarily stale.
 *   Example: M3=CAPTURED + API=authorized
 *
 * WEBHOOK_ONLY
 *   A meaningful webhook-derived state exists, but the M4 API observation is
 *   unavailable (api_error, config_error, or not_found when webhook says paid).
 *
 * API_ONLY
 *   Razorpay API has a meaningful completed state but M3 has UNKNOWN
 *   (no relevant webhook history exists yet or webhooks were missed).
 *   Examples: M3=UNKNOWN + API=failed, M3=UNKNOWN + API=captured
 *
 * NOT_FOUND
 *   Razorpay reports the payment does not exist in this account/mode.
 *
 * ERROR
 *   The API observation could not be obtained. Not enough information to
 *   classify the M3-vs-M4 relationship further.
 *
 * ─── Razorpay API status → effective outcome mapping ─────────────────────────
 *
 * captured    → CAPTURED  (maps directly to M3 state)
 * authorized  → AUTHORIZED
 * failed      → FAILED
 * created     → no meaningful completed state (no M3 equivalent: not yet settled)
 * refunded    → treated as a distinct observation; does not map to M3 PaymentState
 *
 * ─── MUST NOT be imported in browser-side code ───────────────────────────────
 */

import { derivePaymentState, type PaymentState } from "@/lib/payments/state";
import {
  fetchPaymentStatus,
  type RazorpayApiPaymentStatus,
  type RazorpayPaymentObservation,
} from "@/lib/razorpay/payments";

// ─── Outcome type ──────────────────────────────────────────────────────────────

/**
 * The result of comparing M3 webhook-derived state vs M4 API observation.
 *
 * Note: This is the M5 reconciliation category, not M3's PaymentState.
 * Adding new categories here does NOT affect M3's PaymentState.
 */
export type ReconciliationOutcome =
  | "CONSISTENT"
  | "API_AHEAD"
  | "WEBHOOK_AHEAD"
  | "WEBHOOK_ONLY"
  | "API_ONLY"
  | "NOT_FOUND"
  | "ERROR";

// ─── Result types ──────────────────────────────────────────────────────────────

/**
 * The full reconciliation result returned by `reconcilePayment`.
 *
 * All fields are present in every result (no discriminated narrowing needed for
 * the basic outcome). Callers can pattern-match on `outcome` for richer details.
 */
export interface ReconciliationResult {
  /** The payment ID that was reconciled. */
  paymentId: string;

  /** The reconciliation outcome category. */
  outcome: ReconciliationOutcome;

  /** The M3 webhook-derived state. Always present. */
  webhookState: PaymentState;

  /**
   * The Razorpay API observation. Populated when outcome is a SUCCESS call
   * (CONSISTENT, API_AHEAD, WEBHOOK_AHEAD, API_ONLY, WEBHOOK_ONLY with
   * available observation).
   * Null when the API call failed, returned not_found, or was not made.
   */
  apiObservation: RazorpayPaymentObservation | null;

  /**
   * Human-readable summary of the reconciliation result.
   * Safe to log; never contains credentials.
   */
  summary: string;

  /** ISO 8601 timestamp when the reconciliation was computed. */
  reconciledAt: string;
}

// ─── Internal Razorpay API status → effective M3-comparable state ─────────────

/**
 * Maps a Razorpay API payment status to the closest M3-comparable PaymentState.
 *
 * Returns null for statuses that have no M3 equivalent:
 *   - "created"  — payment initiated but not yet settled
 *   - "refunded" — post-capture reversal; M3 has no REFUNDED state
 *
 * Callers must handle the null case explicitly.
 */
function razorpayStatusToM3State(
  apiStatus: RazorpayApiPaymentStatus
): PaymentState | null {
  switch (apiStatus) {
    case "captured":   return "CAPTURED";
    case "authorized": return "AUTHORIZED";
    case "failed":     return "FAILED";
    case "created":    return null; // no M3 equivalent — not yet settled
    case "refunded":   return null; // no M3 equivalent — post-capture reversal
  }
}

// ─── Finality rank (reused from M3 logic without importing internals) ──────────
//
// We compare finality using the same conceptual rank that M3 uses.
// We do NOT import M3's internal FINALITY_RANK constant — we re-express it here
// as it applies to PaymentState (the output of M3), not event types.

const STATE_RANK: Record<PaymentState, number> = {
  UNKNOWN:    0,
  FAILED:     1,
  AUTHORIZED: 2,
  CAPTURED:   3,
};

// ─── Core reconciliation logic ────────────────────────────────────────────────

/**
 * Classifies the M3-vs-M4 relationship given:
 *   - the M3 webhook-derived state
 *   - the comparable M3-equivalent of the M4 API observation (or null)
 *   - the raw M4 API status (to distinguish refunded/created from null due to mapping)
 */
function classifyReconciliation(
  webhookState: PaymentState,
  m3EquivalentOfApi: PaymentState | null,
  apiStatus: RazorpayApiPaymentStatus
): ReconciliationOutcome {
  // Handle API statuses without M3 equivalents.
  if (m3EquivalentOfApi === null) {
    if (apiStatus === "refunded") {
      // Razorpay says refunded. This is AFTER capture, so strictly the
      // underlying payment was captured. Treat as CONSISTENT only if M3
      // already shows CAPTURED; otherwise it's a discrepancy we surface
      // as WEBHOOK_ONLY (webhook never received a refund event in M3 scope).
      if (webhookState === "CAPTURED") {
        // Refunded after captured — CONSISTENT at the underlying payment level
        // since capture did happen (just subsequent lifecycle event).
        return "CONSISTENT";
      }
      // Non-captured M3 state + refunded API is unusual — surface as WEBHOOK_ONLY
      return "WEBHOOK_ONLY";
    }

    // apiStatus === "created": payment not yet settled
    if (webhookState !== "UNKNOWN") {
      // Webhook has state but API still shows "created" — temporary/stale API state
      return "WEBHOOK_AHEAD";
    }
    // Both are "not settled" — technically consistent at an incomplete level
    return "CONSISTENT";
  }

  // Both have M3-comparable states. Compare by finality rank.
  const webhookRank = STATE_RANK[webhookState];
  const apiRank     = STATE_RANK[m3EquivalentOfApi];

  if (webhookState === m3EquivalentOfApi) {
    return "CONSISTENT";
  }

  if (apiRank > webhookRank) {
    // API shows higher finality — webhook is behind
    if (webhookState === "UNKNOWN") {
      return "API_ONLY"; // webhook has no state at all, API has one
    }
    return "API_AHEAD";
  }

  // webhookRank > apiRank
  return "WEBHOOK_AHEAD";
}

// ─── Summary strings ──────────────────────────────────────────────────────────

function buildSummary(
  outcome: ReconciliationOutcome,
  webhookState: PaymentState,
  observation: RazorpayPaymentObservation | null
): string {
  const apiStatus = observation?.razorpayStatus ?? "(unavailable)";
  switch (outcome) {
    case "CONSISTENT":
      return `M3 (${webhookState}) and Razorpay API (${apiStatus}) agree.`;
    case "API_AHEAD":
      return `Razorpay API (${apiStatus}) is ahead of M3 webhook state (${webhookState}). Webhook may be delayed.`;
    case "WEBHOOK_AHEAD":
      return `M3 webhook state (${webhookState}) is ahead of Razorpay API (${apiStatus}). API observation may be momentarily stale.`;
    case "WEBHOOK_ONLY":
      return `M3 has webhook state (${webhookState}) but Razorpay API observation is unavailable (${apiStatus}).`;
    case "API_ONLY":
      return `Razorpay API shows (${apiStatus}) but no webhook history exists for this payment (M3=UNKNOWN).`;
    case "NOT_FOUND":
      return `Payment not found in Razorpay. M3 webhook state: ${webhookState}.`;
    case "ERROR":
      return `Could not obtain Razorpay API observation. M3 webhook state: ${webhookState}.`;
  }
}

// ─── Main reconciliation function ─────────────────────────────────────────────

/**
 * Reconciles the M3 webhook-derived payment state with the current M4 Razorpay
 * API observation for the given payment ID.
 *
 * This function performs NETWORK I/O (via fetchPaymentStatus) and a DATABASE
 * read (via derivePaymentState). It is not pure.
 *
 * Never throws — all outcomes are represented in the returned `ReconciliationResult`.
 *
 * @param paymentId - The Razorpay payment ID, e.g. "pay_TUJOzQxoEqFSLU".
 * @returns A `ReconciliationResult` describing the M3 vs M4 relationship.
 */
export async function reconcilePayment(
  paymentId: string
): Promise<ReconciliationResult> {
  const reconciledAt = new Date().toISOString();

  // 1. Derive M3 webhook state (synchronous DB read — never throws in normal use).
  let webhookState: PaymentState;
  try {
    webhookState = derivePaymentState(paymentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown DB error";
    console.error("[reconcilePayment] Failed to derive M3 state:", paymentId, msg);
    // Cannot reconcile without M3 state — return ERROR.
    return {
      paymentId,
      outcome:        "ERROR",
      webhookState:   "UNKNOWN",
      apiObservation: null,
      summary:        `Failed to read webhook state: ${msg}`,
      reconciledAt,
    };
  }

  // 2. Fetch M4 API observation.
  const apiResult = await fetchPaymentStatus(paymentId);

  // 3. Handle API outcomes.
  if (apiResult.outcome === "not_found") {
    return {
      paymentId,
      outcome:        "NOT_FOUND",
      webhookState,
      apiObservation: null,
      summary:        buildSummary("NOT_FOUND", webhookState, null),
      reconciledAt,
    };
  }

  if (apiResult.outcome === "api_error" || apiResult.outcome === "config_error") {
    // API unavailable — can still report the webhook state.
    const outcome: ReconciliationOutcome =
      webhookState !== "UNKNOWN" ? "WEBHOOK_ONLY" : "ERROR";
    return {
      paymentId,
      outcome,
      webhookState,
      apiObservation: null,
      summary:        buildSummary(outcome, webhookState, null),
      reconciledAt,
    };
  }

  // 4. API call succeeded — classify.
  const observation       = apiResult.observation;
  const m3EquivalentOfApi = razorpayStatusToM3State(observation.razorpayStatus);
  const outcome           = classifyReconciliation(webhookState, m3EquivalentOfApi, observation.razorpayStatus);

  return {
    paymentId,
    outcome,
    webhookState,
    apiObservation: observation,
    summary:        buildSummary(outcome, webhookState, observation),
    reconciledAt,
  };
}
