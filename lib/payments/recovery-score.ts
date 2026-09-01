/**
 * Deterministic Recovery Scoring — M6
 *
 * Answers: "Based on the verified evidence we currently have, how recoverable
 * is this payment?"
 *
 * ─── Architectural position ───────────────────────────────────────────────────
 *
 * M2: Razorpay → webhook → webhook_events (persisted evidence)
 * M3: webhook_events → derivePaymentState() → UNKNOWN/FAILED/AUTHORIZED/CAPTURED
 * M4: Razorpay API → fetchPaymentStatus() → RazorpayPaymentFetchResult
 * M5: M3 + M4 → reconcilePayment() → ReconciliationResult
 * M6: All evidence → computeRecoveryScore() → RecoveryScoreResult
 *
 * M6 MUST NOT:
 *   - call the Razorpay API (that is M4's responsibility)
 *   - modify the database
 *   - use LLM / AI inference
 *   - fabricate evidence that does not exist in persisted data
 *   - produce non-deterministic output
 *
 * Identical inputs MUST always produce identical output.
 *
 * ─── Score model (0–100) ──────────────────────────────────────────────────────
 *
 * 1. Failure Type     — max 40 pts
 * 2. Payment History  — max 25 pts
 * 3. Retry History    — max 15 pts
 * 4. Amount / Context — max 10 pts
 * 5. Recency          — max 10 pts
 *
 * Total possible: 100 pts
 *
 * ─── Tiers ────────────────────────────────────────────────────────────────────
 *
 * 70–100 → HIGH
 * 40–69  → MEDIUM
 * 0–39   → LOW
 *
 * ─── Confidence ───────────────────────────────────────────────────────────────
 *
 * Reflects how much reliable evidence was available, NOT the recovery
 * probability itself.
 *
 * HIGH:   ≥ 3 major factors available (failure_type + payment_history + recency
 *         or retry_history)
 * MEDIUM: 2 major factors available
 * LOW:    < 2 major factors available
 *
 * ─── MUST NOT be imported in browser-side code ───────────────────────────────
 */

import { getDb } from "@/lib/db/client";
import { derivePaymentState, type PaymentState } from "@/lib/payments/state";

// ─── Public types ─────────────────────────────────────────────────────────────

export type RecoveryTier = "HIGH" | "MEDIUM" | "LOW";
export type ConfidenceLevel = "HIGH" | "MEDIUM" | "LOW";

/** A single scoring factor with its contribution and explanation. */
export interface ScoringFactor {
  /** Internal factor name — stable across versions. */
  factor:
    | "failure_type"
    | "payment_history"
    | "retry_history"
    | "amount_context"
    | "recency";
  /** Whether sufficient evidence was available to score this factor. */
  available: boolean;
  /** Points awarded for this factor. 0 if unavailable. */
  points: number;
  /** Maximum points this factor can contribute. */
  maxPoints: number;
  /** Human-readable explanation of the score for this factor. */
  reason: string;
}

/** The complete M6 recovery score result. */
export interface RecoveryScoreResult {
  paymentId: string;
  /** The M3 webhook-derived canonical state used as input. */
  webhookState: PaymentState;
  /** 0–100 deterministic recovery score. */
  recoveryScore: number;
  /** Score tier: HIGH (70–100), MEDIUM (40–69), LOW (0–39). */
  recoveryTier: RecoveryTier;
  /** Evidence completeness level (not a prediction). */
  confidence: ConfidenceLevel;
  /** Per-factor breakdown explaining the score. */
  factors: ScoringFactor[];
  /** ISO 8601 timestamp when this score was computed. */
  scoredAt: string;
}

// ─── Internal evidence types ──────────────────────────────────────────────────

/**
 * Normalised evidence extracted from the webhook event raw_payload
 * for the payment being scored.
 */
interface PaymentEvidence {
  /** Raw error fields from payment.failed event payload (if present). */
  errorSource: string | null;
  errorReason: string | null;
  errorStep: string | null;
  /** Payment method from any payment event. */
  method: string | null;
  /** Contact phone number (used for cross-payment history). */
  contact: string | null;
  /** Payment amount in paise. */
  amount: number | null;
  /** UNIX timestamp of payment creation. */
  createdAt: number | null;
}

// ─── Evidence extraction ──────────────────────────────────────────────────────

/**
 * Extracts the normalised evidence fields for a given payment ID from the
 * persisted webhook_events table.
 *
 * Priority for field extraction:
 *   - error fields: from payment.failed event (only one that has them)
 *   - method/contact/amount/created_at: from any payment.* event
 *
 * Returns null if no payment events exist for this ID.
 */
function extractPaymentEvidence(paymentId: string): PaymentEvidence | null {
  const db = getDb();

  // Fetch all payment.* event rows for this payment ID, ordered by event type
  // so payment.failed comes first (alphabetically), giving us error fields.
  const rows = db
    .prepare(
      `
      SELECT event_type,
             json_extract(raw_payload, '$.payload.payment.entity.error_source')
               AS error_source,
             json_extract(raw_payload, '$.payload.payment.entity.error_reason')
               AS error_reason,
             json_extract(raw_payload, '$.payload.payment.entity.error_step')
               AS error_step,
             json_extract(raw_payload, '$.payload.payment.entity.method')
               AS method,
             json_extract(raw_payload, '$.payload.payment.entity.contact')
               AS contact,
             json_extract(raw_payload, '$.payload.payment.entity.amount')
               AS amount,
             json_extract(raw_payload, '$.payload.payment.entity.created_at')
               AS created_at
      FROM   webhook_events
      WHERE  json_extract(raw_payload, '$.payload.payment.entity.id') = ?
        AND  event_type IN ('payment.failed','payment.authorized','payment.captured')
      ORDER BY event_type ASC
    `
    )
    .all(paymentId) as Array<{
    event_type: string;
    error_source: string | null;
    error_reason: string | null;
    error_step: string | null;
    method: string | null;
    contact: string | null;
    amount: number | string | null;
    created_at: number | null;
  }>;

  if (rows.length === 0) {
    return null;
  }

  // Merge: prefer error fields from payment.failed, other fields from any row.
  const failedRow = rows.find((r) => r.event_type === "payment.failed");
  const anyRow = rows[0];

  return {
    errorSource: failedRow?.error_source ?? null,
    errorReason: failedRow?.error_reason ?? null,
    errorStep: failedRow?.error_step ?? null,
    method: anyRow.method ?? null,
    contact: anyRow.contact ?? null,
    amount: anyRow.amount !== null ? Number(anyRow.amount) : null,
    createdAt: anyRow.created_at ?? null,
  };
}

/**
 * Counts prior SUCCESSFUL payments (payment.captured) for a given contact
 * phone number, excluding the current payment ID.
 *
 * Returns null if contact is not available.
 */
function countPriorSuccessfulPayments(
  contact: string,
  currentPaymentId: string
): number {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT COUNT(DISTINCT json_extract(raw_payload, '$.payload.payment.entity.id')) AS cnt
      FROM   webhook_events
      WHERE  event_type = 'payment.captured'
        AND  json_extract(raw_payload, '$.payload.payment.entity.contact') = ?
        AND  json_extract(raw_payload, '$.payload.payment.entity.id') != ?
    `
    )
    .get(contact, currentPaymentId) as { cnt: number };
  return row.cnt;
}

/**
 * Counts prior FAILED payment attempts for a given contact phone number,
 * before the current payment's created_at timestamp, excluding the current
 * payment ID.
 *
 * Returns null if contact is not available.
 */
function countPriorFailedPayments(
  contact: string,
  currentPaymentId: string,
  beforeCreatedAt: number
): number {
  const db = getDb();
  const row = db
    .prepare(
      `
      SELECT COUNT(DISTINCT json_extract(raw_payload, '$.payload.payment.entity.id')) AS cnt
      FROM   webhook_events
      WHERE  event_type = 'payment.failed'
        AND  json_extract(raw_payload, '$.payload.payment.entity.contact') = ?
        AND  json_extract(raw_payload, '$.payload.payment.entity.id') != ?
        AND  json_extract(raw_payload, '$.payload.payment.entity.created_at') < ?
    `
    )
    .get(contact, currentPaymentId, beforeCreatedAt) as { cnt: number };
  return row.cnt;
}

// ─── Factor scoring functions (pure) ─────────────────────────────────────────

/**
 * Scores the Failure Type factor (max 40 pts).
 *
 * Scoring rules based on `error_source`:
 *
 *   NOT a failure (CAPTURED/AUTHORIZED):     40 pts  — already succeeded or in progress
 *   error_source = "razorpay":               35 pts  — infrastructure issue, likely retryable
 *   error_source = "bank":                   28 pts  — transient bank decline, often retryable
 *   error_source = "business":               18 pts  — merchant-side issue
 *   error_source = "customer":               10 pts  — customer action (abandon/block)
 *   error_source unknown/null (FAILED):      15 pts  — failure confirmed, source unclear
 *   state = UNKNOWN (no failure event):      20 pts  — no failure evidence, cautiously neutral
 *
 * Rationale: error_source is the most reliable Razorpay failure classifier.
 * Bank and Razorpay errors are typically transient and retryable. Customer
 * errors indicate deliberate non-payment. Business errors need merchant action.
 */
export function scoreFailureType(
  webhookState: PaymentState,
  evidence: PaymentEvidence | null
): ScoringFactor {
  const MAX = 40;

  if (webhookState === "CAPTURED") {
    return {
      factor: "failure_type",
      available: true,
      points: MAX,
      maxPoints: MAX,
      reason: "Payment was successfully captured — maximum recovery score for failure type.",
    };
  }

  if (webhookState === "AUTHORIZED") {
    return {
      factor: "failure_type",
      available: true,
      points: 38,
      maxPoints: MAX,
      reason: "Payment is authorized (pending capture) — highly recoverable.",
    };
  }

  if (webhookState === "FAILED") {
    const src = evidence?.errorSource?.toLowerCase() ?? null;

    if (src === "razorpay") {
      return {
        factor: "failure_type",
        available: true,
        points: 35,
        maxPoints: MAX,
        reason:
          "Failure source: Razorpay infrastructure. These are typically transient and highly retryable.",
      };
    }
    if (src === "bank") {
      return {
        factor: "failure_type",
        available: true,
        points: 28,
        maxPoints: MAX,
        reason:
          "Failure source: bank decline. Bank declines are often transient (insufficient funds, limits) and recoverable with retry or alternate payment method.",
      };
    }
    if (src === "business") {
      return {
        factor: "failure_type",
        available: true,
        points: 18,
        maxPoints: MAX,
        reason:
          "Failure source: business/merchant configuration. Recovery requires merchant action to resolve.",
      };
    }
    if (src === "customer") {
      return {
        factor: "failure_type",
        available: true,
        points: 10,
        maxPoints: MAX,
        reason:
          "Failure source: customer action (e.g., authentication declined, card blocked). Recovery depends on customer willingness to retry.",
      };
    }

    // FAILED but error_source unknown/null
    return {
      factor: "failure_type",
      available: evidence !== null,
      points: 15,
      maxPoints: MAX,
      reason:
        evidence !== null
          ? "Payment failed but error source is unclassified. Applying neutral failure score."
          : "Payment failed but no detailed failure evidence is available in webhook history.",
    };
  }

  // UNKNOWN state — no failure event received
  return {
    factor: "failure_type",
    available: false,
    points: 20,
    maxPoints: MAX,
    reason:
      "No failure event recorded in webhook history. Payment state is unknown — applying cautious neutral score.",
  };
}

/**
 * Scores the Payment History factor (max 25 pts).
 *
 * Uses prior successful payments (payment.captured) for the same contact.
 *
 * Rules:
 *   contact unavailable:                    0 pts, unavailable
 *   ≥ 2 prior successful payments:         25 pts — strong repeat customer
 *   1 prior successful payment:            18 pts — known payer
 *   0 prior successful payments:            0 pts — no positive history
 *
 * Rationale: A customer who has previously completed payments in this Razorpay
 * account has demonstrated payment intent and ability. No prior history means
 * we cannot infer positive intent — but it is NOT negative evidence.
 */
export function scorePaymentHistory(
  evidence: PaymentEvidence | null,
  priorSuccessCount: number | null
): ScoringFactor {
  const MAX = 25;

  if (evidence?.contact == null || priorSuccessCount === null) {
    return {
      factor: "payment_history",
      available: false,
      points: 0,
      maxPoints: MAX,
      reason:
        "Contact information not available — cannot determine prior payment history.",
    };
  }

  if (priorSuccessCount >= 2) {
    return {
      factor: "payment_history",
      available: true,
      points: MAX,
      maxPoints: MAX,
      reason: `Strong repeat customer: ${priorSuccessCount} prior successful payment(s) from the same contact.`,
    };
  }

  if (priorSuccessCount === 1) {
    return {
      factor: "payment_history",
      available: true,
      points: 18,
      maxPoints: MAX,
      reason: "Known payer: 1 prior successful payment from the same contact.",
    };
  }

  return {
    factor: "payment_history",
    available: true,
    points: 0,
    maxPoints: MAX,
    reason:
      "No prior successful payments found for this contact. Cannot infer positive payment intent.",
  };
}

/**
 * Scores the Retry History factor (max 15 pts).
 *
 * Counts prior payment FAILURES for the same contact before this payment.
 *
 * Rules:
 *   contact unavailable:        7 pts (neutral — insufficient evidence)
 *   0 prior failures:          15 pts — first failure, high recovery probability
 *   1 prior failure:           10 pts — one prior attempt
 *   2 prior failures:           5 pts — persistent difficulty
 *   ≥ 3 prior failures:         0 pts — persistent non-payment pattern
 *
 * Rationale: A customer with multiple prior failed payments may face systemic
 * issues (blocked cards, insufficient funds, blocked by bank). The CURRENT
 * payment's created_at is used to bound the lookback strictly.
 */
export function scoreRetryHistory(
  evidence: PaymentEvidence | null,
  priorFailureCount: number | null
): ScoringFactor {
  const MAX = 15;

  if (evidence?.contact == null || priorFailureCount === null) {
    return {
      factor: "retry_history",
      available: false,
      points: 7,
      maxPoints: MAX,
      reason:
        "Contact information not available — applying neutral score (7/15) for retry history.",
    };
  }

  if (priorFailureCount === 0) {
    return {
      factor: "retry_history",
      available: true,
      points: MAX,
      maxPoints: MAX,
      reason: "No prior failed payments from this contact — first failure, strong recovery signal.",
    };
  }

  if (priorFailureCount === 1) {
    return {
      factor: "retry_history",
      available: true,
      points: 10,
      maxPoints: MAX,
      reason: `1 prior failed payment from this contact before this attempt.`,
    };
  }

  if (priorFailureCount === 2) {
    return {
      factor: "retry_history",
      available: true,
      points: 5,
      maxPoints: MAX,
      reason: `2 prior failed payments from this contact — persistent difficulty pattern.`,
    };
  }

  return {
    factor: "retry_history",
    available: true,
    points: 0,
    maxPoints: MAX,
    reason: `${priorFailureCount} prior failed payments from this contact — significant non-payment pattern.`,
  };
}

/**
 * Scores the Amount / Context factor (max 10 pts).
 *
 * Smaller amounts are generally easier to recover (lower friction for customer,
 * less business risk). Scoring based on amount in paise:
 *
 *   ≤ 1,000 paise  (≤ ₹10):     10 pts
 *   ≤ 10,000 paise (≤ ₹100):    8 pts
 *   ≤ 100,000 paise (≤ ₹1,000): 6 pts
 *   ≤ 1,000,000 paise (≤ ₹10,000): 4 pts
 *   > 1,000,000 paise (> ₹10,000): 2 pts
 *   amount unavailable:          5 pts (neutral)
 *
 * Rationale: This is a contextual modifier only. All brackets still receive
 * positive points because amount alone cannot determine irrecoverability.
 */
export function scoreAmountContext(evidence: PaymentEvidence | null): ScoringFactor {
  const MAX = 10;

  if (evidence?.amount == null) {
    return {
      factor: "amount_context",
      available: false,
      points: 5,
      maxPoints: MAX,
      reason: "Payment amount not available — applying neutral score (5/10).",
    };
  }

  const paise = evidence.amount;
  const inr = paise / 100;

  if (paise <= 1_000) {
    return {
      factor: "amount_context",
      available: true,
      points: MAX,
      maxPoints: MAX,
      reason: `Low-value transaction (₹${inr.toFixed(2)}) — minimal friction for recovery.`,
    };
  }
  if (paise <= 10_000) {
    return {
      factor: "amount_context",
      available: true,
      points: 8,
      maxPoints: MAX,
      reason: `Small transaction (₹${inr.toFixed(2)}) — low friction for recovery.`,
    };
  }
  if (paise <= 100_000) {
    return {
      factor: "amount_context",
      available: true,
      points: 6,
      maxPoints: MAX,
      reason: `Moderate transaction (₹${inr.toFixed(2)}) — standard recovery complexity.`,
    };
  }
  if (paise <= 1_000_000) {
    return {
      factor: "amount_context",
      available: true,
      points: 4,
      maxPoints: MAX,
      reason: `Large transaction (₹${inr.toFixed(2)}) — higher friction for recovery.`,
    };
  }
  return {
    factor: "amount_context",
    available: true,
    points: 2,
    maxPoints: MAX,
    reason: `Very large transaction (₹${inr.toFixed(2)}) — significant friction for recovery.`,
  };
}

/**
 * Scores the Recency factor (max 10 pts).
 *
 * More recent failures are more recoverable (customer is still active,
 * payment context is fresh). Uses `created_at` UNIX timestamp from the payload
 * relative to the supplied `referenceTimestamp` (seconds since epoch).
 *
 * To maintain determinism, the reference timestamp is a required parameter —
 * callers must supply it explicitly (e.g. Date.now() / 1000 at call time).
 *
 * Rules (age = referenceTimestamp - created_at, in seconds):
 *   ≤ 1 day   (86400 s):        10 pts — very fresh
 *   ≤ 7 days  (604800 s):       8 pts
 *   ≤ 30 days (2592000 s):      5 pts
 *   ≤ 90 days (7776000 s):      2 pts
 *   > 90 days:                   0 pts — stale
 *   created_at unavailable:      5 pts (neutral)
 */
export function scoreRecency(
  evidence: PaymentEvidence | null,
  referenceTimestampSeconds: number
): ScoringFactor {
  const MAX = 10;

  if (evidence?.createdAt == null) {
    return {
      factor: "recency",
      available: false,
      points: 5,
      maxPoints: MAX,
      reason: "Payment timestamp not available — applying neutral recency score (5/10).",
    };
  }

  const ageSeconds = referenceTimestampSeconds - evidence.createdAt;

  if (ageSeconds <= 0) {
    // createdAt is in the future — data anomaly, treat as very fresh
    return {
      factor: "recency",
      available: true,
      points: MAX,
      maxPoints: MAX,
      reason: "Payment timestamp indicates very recent activity — maximum recency score.",
    };
  }

  const ageDays = ageSeconds / 86400;

  if (ageDays <= 1) {
    return {
      factor: "recency",
      available: true,
      points: MAX,
      maxPoints: MAX,
      reason: `Payment is very recent (${ageDays.toFixed(1)} day(s) ago) — high recency score.`,
    };
  }
  if (ageDays <= 7) {
    return {
      factor: "recency",
      available: true,
      points: 8,
      maxPoints: MAX,
      reason: `Payment is recent (${ageDays.toFixed(1)} day(s) ago).`,
    };
  }
  if (ageDays <= 30) {
    return {
      factor: "recency",
      available: true,
      points: 5,
      maxPoints: MAX,
      reason: `Payment is moderately recent (${ageDays.toFixed(1)} day(s) ago).`,
    };
  }
  if (ageDays <= 90) {
    return {
      factor: "recency",
      available: true,
      points: 2,
      maxPoints: MAX,
      reason: `Payment is aging (${ageDays.toFixed(1)} day(s) ago) — reduced recency score.`,
    };
  }
  return {
    factor: "recency",
    available: true,
    points: 0,
    maxPoints: MAX,
    reason: `Payment is stale (${ageDays.toFixed(0)} day(s) ago) — no recency score.`,
  };
}

// ─── Tier and confidence classification (pure) ────────────────────────────────

/** Maps a 0–100 score to the corresponding recovery tier. */
export function scoreToTier(score: number): RecoveryTier {
  if (score >= 70) return "HIGH";
  if (score >= 40) return "MEDIUM";
  return "LOW";
}

/**
 * Computes the confidence level based on factor availability.
 *
 * Major factors: failure_type, payment_history, recency
 * Supporting factors: retry_history, amount_context
 *
 * HIGH:   failure_type available + at least 2 other factors available
 * MEDIUM: failure_type available + 1 other factor, OR
 *         failure_type unavailable but 3+ other factors available
 * LOW:    fewer than 2 factors available
 */
export function computeConfidence(factors: ScoringFactor[]): ConfidenceLevel {
  const available = factors.filter((f) => f.available);
  const count = available.length;

  const failureTypeAvail = factors.find((f) => f.factor === "failure_type")?.available ?? false;

  if (failureTypeAvail && count >= 3) return "HIGH";
  if (failureTypeAvail && count >= 2) return "MEDIUM";
  if (!failureTypeAvail && count >= 3) return "MEDIUM";
  return "LOW";
}

// ─── Pure scoring (no DB I/O) ─────────────────────────────────────────────────

/**
 * Computes the recovery score from pre-extracted evidence.
 *
 * This is the PURE, database-free core of M6. It accepts all evidence as
 * parameters so it can be unit-tested without DB access.
 *
 * @param paymentId - The payment ID being scored.
 * @param webhookState - The M3 canonical state.
 * @param evidence - Normalised evidence from the webhook payload (or null).
 * @param priorSuccessCount - Prior successful payments for same contact (or null).
 * @param priorFailureCount - Prior failed payments for same contact before this (or null).
 * @param referenceTimestampSeconds - UNIX seconds used as "now" for recency.
 * @param scoredAt - ISO 8601 timestamp for the result.
 */
export function computeRecoveryScoreFromEvidence(
  paymentId: string,
  webhookState: PaymentState,
  evidence: PaymentEvidence | null,
  priorSuccessCount: number | null,
  priorFailureCount: number | null,
  referenceTimestampSeconds: number,
  scoredAt: string
): RecoveryScoreResult {
  const factors: ScoringFactor[] = [
    scoreFailureType(webhookState, evidence),
    scorePaymentHistory(evidence, priorSuccessCount),
    scoreRetryHistory(evidence, priorFailureCount),
    scoreAmountContext(evidence),
    scoreRecency(evidence, referenceTimestampSeconds),
  ];

  const recoveryScore = Math.min(
    100,
    Math.max(0, factors.reduce((sum, f) => sum + f.points, 0))
  );

  return {
    paymentId,
    webhookState,
    recoveryScore,
    recoveryTier: scoreToTier(recoveryScore),
    confidence: computeConfidence(factors),
    factors,
    scoredAt,
  };
}

// ─── Main function (DB + pure) ────────────────────────────────────────────────

/**
 * Computes the deterministic recovery score for a given payment ID.
 *
 * Reads from the M2 webhook_events database and M3 state derivation.
 * Does NOT call the Razorpay API (that is M4's responsibility).
 * Does NOT modify the database.
 * Never throws — returns a result with confidence=LOW for unknown payments.
 *
 * @param paymentId - The Razorpay payment ID, e.g. "pay_TUJOzQxoEqFSLU".
 * @param referenceTimestampSeconds - Optional UNIX seconds for recency computation.
 *   Defaults to current wall-clock time. Pass explicitly for deterministic testing.
 */
export function computeRecoveryScore(
  paymentId: string,
  referenceTimestampSeconds?: number
): RecoveryScoreResult {
  const scoredAt = new Date().toISOString();
  const refTs = referenceTimestampSeconds ?? Math.floor(Date.now() / 1000);

  // 1. M3 webhook-derived state.
  const webhookState = derivePaymentState(paymentId);

  // 2. Extract evidence from webhook_events.
  const evidence = extractPaymentEvidence(paymentId);

  // 3. Contact-based history queries (only if contact available).
  const contact = evidence?.contact ?? null;
  const createdAt = evidence?.createdAt ?? null;

  const priorSuccessCount =
    contact !== null
      ? countPriorSuccessfulPayments(contact, paymentId)
      : null;

  const priorFailureCount =
    contact !== null && createdAt !== null
      ? countPriorFailedPayments(contact, paymentId, createdAt)
      : null;

  // 4. Compute and return.
  return computeRecoveryScoreFromEvidence(
    paymentId,
    webhookState,
    evidence,
    priorSuccessCount,
    priorFailureCount,
    refTs,
    scoredAt
  );
}
