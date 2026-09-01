/**
 * Deterministic Diagnosis and Recommendation - M7A
 *
 * Answers: "Given the verified evidence from M3/M6, what happened to this
 * payment and what should the merchant do next?"
 *
 * M7A MUST NOT:
 *   - call the Razorpay API
 *   - use LLM / AI inference
 *   - modify the database
 *   - fabricate evidence not present in M3/M6 output
 *   - expose customer PII (phone, email)
 *   - expose credentials or environment variables
 *   - produce non-deterministic output
 *
 * Identical inputs MUST always produce identical output.
 *
 * Diagnosis derivation from M6 failure_type factor points:
 *   40 pts / CAPTURED   -> CAPTURED
 *   38 pts / AUTHORIZED -> AUTHORIZED
 *   35 pts              -> INFRASTRUCTURE_FAILURE
 *   28 pts              -> BANK_DECLINE
 *   18 pts              -> BUSINESS_CONFIGURATION
 *   10 pts              -> CUSTOMER_ACTION_REQUIRED
 *   15 pts / available  -> UNKNOWN_PAYMENT_STATE
 *   15 pts / unavail    -> INSUFFICIENT_EVIDENCE
 *   UNKNOWN state       -> INSUFFICIENT_EVIDENCE
 *
 * MUST NOT be imported in browser-side code.
 */

import { computeRecoveryScore, type RecoveryScoreResult, type RecoveryTier } from "@/lib/payments/recovery-score";

// --- Public types ---

export type DiagnosisCategory =
  | "CAPTURED"
  | "AUTHORIZED"
  | "BANK_DECLINE"
  | "CUSTOMER_ACTION_REQUIRED"
  | "BUSINESS_CONFIGURATION"
  | "INFRASTRUCTURE_FAILURE"
  | "UNKNOWN_PAYMENT_STATE"
  | "INSUFFICIENT_EVIDENCE";

export type RecommendationAction =
  | "NO_ACTION"
  | "CHECK_CAPTURE_STATUS"
  | "RETRY_PAYMENT"
  | "CUSTOMER_ACTION_REQUIRED"
  | "REVIEW_MERCHANT_CONFIGURATION"
  | "COLLECT_MORE_EVIDENCE";

export type RecommendationPriority = "HIGH" | "MEDIUM" | "LOW";

export interface Diagnosis {
  category: DiagnosisCategory;
  summary: string;
  evidence: string[];
}

export interface Recommendation {
  action: RecommendationAction;
  priority: RecommendationPriority;
  message: string;
}

export interface GenerationMeta {
  mode: "deterministic" | "ai";
}

export interface DiagnosisResult {
  paymentId: string;
  webhookState: RecoveryScoreResult["webhookState"];
  recoveryScore: number;
  recoveryTier: RecoveryTier;
  confidence: RecoveryScoreResult["confidence"];
  diagnosis: Diagnosis;
  recommendation: Recommendation;
  generation: GenerationMeta;
}

// --- Priority mapping ---

function tierToPriority(tier: RecoveryTier): RecommendationPriority {
  switch (tier) {
    case "HIGH":   return "HIGH";
    case "MEDIUM": return "MEDIUM";
    case "LOW":    return "LOW";
  }
}

// --- Diagnosis classification ---

/**
 * Derives the M7A diagnosis category from a RecoveryScoreResult.
 * Uses webhookState + failure_type factor points. No DB access. No API calls.
 */
export function classifyDiagnosis(score: RecoveryScoreResult): DiagnosisCategory {
  const { webhookState, factors } = score;

  if (webhookState === "CAPTURED")   return "CAPTURED";
  if (webhookState === "AUTHORIZED") return "AUTHORIZED";

  if (webhookState === "FAILED") {
    const ft = factors.find((f) => f.factor === "failure_type");
    if (!ft) return "INSUFFICIENT_EVIDENCE";

    if (ft.points === 35) return "INFRASTRUCTURE_FAILURE";
    if (ft.points === 28) return "BANK_DECLINE";
    if (ft.points === 18) return "BUSINESS_CONFIGURATION";
    if (ft.points === 10) return "CUSTOMER_ACTION_REQUIRED";
    // 15 pts: available=true -> source unclassified; available=false -> no evidence
    if (ft.points === 15) return ft.available ? "UNKNOWN_PAYMENT_STATE" : "INSUFFICIENT_EVIDENCE";
    return "INSUFFICIENT_EVIDENCE";
  }

  // webhookState === "UNKNOWN"
  return "INSUFFICIENT_EVIDENCE";
}

// --- Diagnosis builder (pure) ---

/**
 * Builds the Diagnosis object. Evidence is sanitised - no PII, no raw DB values.
 */
export function buildDiagnosis(
  category: DiagnosisCategory,
  score: RecoveryScoreResult
): Diagnosis {
  const { factors } = score;
  const historyFactor = factors.find((f) => f.factor === "payment_history");
  const retryFactor   = factors.find((f) => f.factor === "retry_history");
  const recencyFactor = factors.find((f) => f.factor === "recency");
  const amountFactor  = factors.find((f) => f.factor === "amount_context");

  const evidence: string[] = [];

  if (historyFactor?.available) {
    if (historyFactor.points >= 25) {
      evidence.push("Strong prior payment history detected for this contact.");
    } else if (historyFactor.points > 0) {
      evidence.push("Prior successful payment history exists for this contact.");
    } else {
      evidence.push("No prior successful payment history found for this contact.");
    }
  } else {
    evidence.push("Contact information unavailable — payment history unknown.");
  }

  if (retryFactor?.available) {
    if (retryFactor.points === 15) {
      evidence.push("No prior failed payment attempts detected for this contact.");
    } else if (retryFactor.points >= 5) {
      evidence.push("Limited prior failed payment attempts detected for this contact.");
    } else {
      evidence.push("Repeated prior failed payment attempts detected for this contact.");
    }
  }

  if (recencyFactor?.available) {
    if (recencyFactor.points >= 8) {
      evidence.push("Payment attempt is recent.");
    } else if (recencyFactor.points >= 2) {
      evidence.push("Payment attempt occurred within the past 90 days.");
    } else {
      evidence.push("Payment attempt is older than 90 days — recency signal is low.");
    }
  }

  if (amountFactor?.available) {
    if (amountFactor.points >= 8) {
      evidence.push("Transaction amount is low — recovery friction is minimal.");
    } else if (amountFactor.points >= 4) {
      evidence.push("Transaction amount is moderate.");
    } else {
      evidence.push("Transaction amount is high — recovery may require additional effort.");
    }
  }

  switch (category) {
    case "CAPTURED":
      return {
        category,
        summary: "The payment has already been successfully captured. No recovery action is needed.",
        evidence: ["Payment reached captured state — highest finality.", ...evidence],
      };
    case "AUTHORIZED":
      return {
        category,
        summary: "The payment is authorized and pending capture. Verify capture status before taking any action.",
        evidence: ["Payment reached authorized state — capture pending.", ...evidence],
      };
    case "BANK_DECLINE":
      return {
        category,
        summary: "The payment was declined by the customer's bank. Bank declines are often transient and may be resolved by retrying or using an alternate payment method.",
        evidence: ["Bank decline detected as the failure source.", ...evidence],
      };
    case "CUSTOMER_ACTION_REQUIRED":
      return {
        category,
        summary: "The payment failed due to a customer-side action (such as authentication failure or a card block). Recovery depends on the customer's willingness and ability to retry.",
        evidence: ["Customer action identified as the failure source.", ...evidence],
      };
    case "BUSINESS_CONFIGURATION":
      return {
        category,
        summary: "The payment failed due to a business or merchant configuration issue. The merchant must resolve their configuration before the customer can be asked to retry.",
        evidence: ["Business/merchant configuration identified as the failure source.", ...evidence],
      };
    case "INFRASTRUCTURE_FAILURE":
      return {
        category,
        summary: "The payment failed due to a Razorpay infrastructure issue. These failures are typically transient and the payment can be retried.",
        evidence: ["Razorpay infrastructure identified as the failure source.", ...evidence],
      };
    case "UNKNOWN_PAYMENT_STATE":
      return {
        category,
        summary: "The payment failed, but the specific failure source could not be determined from available webhook evidence.",
        evidence: ["Payment failure confirmed, but failure source is unclassified in available evidence.", ...evidence],
      };
    case "INSUFFICIENT_EVIDENCE":
      return {
        category,
        summary: "Insufficient evidence in the webhook history to determine what happened to this payment.",
        evidence: ["No sufficient webhook evidence available for this payment ID.", ...evidence],
      };
  }
}

// --- Recommendation builder (pure) ---

/**
 * Builds the Recommendation object. Priority tracks M6 recoveryTier for
 * failure categories; fixed for CAPTURED/AUTHORIZED/INSUFFICIENT_EVIDENCE.
 */
export function buildRecommendation(
  category: DiagnosisCategory,
  score: RecoveryScoreResult
): Recommendation {
  const priority = tierToPriority(score.recoveryTier);

  switch (category) {
    case "CAPTURED":
      return {
        action: "NO_ACTION",
        priority: "LOW",
        message: "The payment has already been successfully captured. No further action is required. Do not retry this payment.",
      };
    case "AUTHORIZED":
      return {
        action: "CHECK_CAPTURE_STATUS",
        priority: "MEDIUM",
        message: "Verify that the capture has been completed or initiate capture if pending. Do not ask the customer to retry — the payment is already authorized.",
      };
    case "BANK_DECLINE":
      return {
        action: "RETRY_PAYMENT",
        priority,
        message: "Ask the customer to retry the payment. If the bank decline persists, suggest using an alternate payment method (e.g., UPI, a different card, or net banking).",
      };
    case "CUSTOMER_ACTION_REQUIRED":
      return {
        action: "CUSTOMER_ACTION_REQUIRED",
        priority,
        message: "Contact the customer to resolve the authentication or card issue before retrying. The customer may need to unblock their card, verify OTP settings, or use an alternate method.",
      };
    case "BUSINESS_CONFIGURATION":
      return {
        action: "REVIEW_MERCHANT_CONFIGURATION",
        priority,
        message: "Review your Razorpay merchant configuration (payment methods, limits, or account settings). Do not ask the customer to retry until the configuration issue is resolved.",
      };
    case "INFRASTRUCTURE_FAILURE":
      return {
        action: "RETRY_PAYMENT",
        priority,
        message: "Retry the payment — Razorpay infrastructure failures are typically transient and resolve quickly. If the issue persists, contact Razorpay support.",
      };
    case "UNKNOWN_PAYMENT_STATE":
    case "INSUFFICIENT_EVIDENCE":
      return {
        action: "COLLECT_MORE_EVIDENCE",
        priority: "LOW",
        message: "Insufficient evidence is available to make a specific recommendation. Check Razorpay's dashboard for more details, or wait for additional webhook events.",
      };
  }
}

// --- Main function ---

/**
 * Computes the deterministic M7A diagnosis and recommendation for a payment.
 *
 * Calls M6's computeRecoveryScore internally. Does NOT call the Razorpay API.
 * Does NOT modify the database. Never throws.
 *
 * @param paymentId - The Razorpay payment ID, e.g. "pay_TUJOzQxoEqFSLU".
 * @param referenceTimestampSeconds - Optional UNIX seconds for deterministic
 *   recency. Passed through to M6. Defaults to wall-clock time.
 */
export function diagnosePayment(
  paymentId: string,
  referenceTimestampSeconds?: number
): DiagnosisResult {
  const score          = computeRecoveryScore(paymentId, referenceTimestampSeconds);
  const category       = classifyDiagnosis(score);
  const diagnosis      = buildDiagnosis(category, score);
  const recommendation = buildRecommendation(category, score);

  return {
    paymentId:     score.paymentId,
    webhookState:  score.webhookState,
    recoveryScore: score.recoveryScore,
    recoveryTier:  score.recoveryTier,
    confidence:    score.confidence,
    diagnosis,
    recommendation,
    generation: { mode: "deterministic" },
  };
}
