/**
 * Razorpay Payment Status Client — M4
 *
 * Provides an independent, on-demand fallback to fetch the current state of a
 * Razorpay payment directly from the Razorpay API.
 *
 * ─── Architectural position ──────────────────────────────────────────────────
 *
 * PRIMARY PATH (M2 + M3): Razorpay → webhook → webhook_events → derivePaymentState()
 * FALLBACK PATH (M4):     Razorpay API → payments.fetch() → fetchPaymentStatus()
 *
 * M4 is a pure observation layer. It does NOT:
 *   - modify the database
 *   - alter M3's canonical state
 *   - implement reconciliation or recovery logic
 *   - cache, poll, or schedule background work
 *
 * ─── Authentication ──────────────────────────────────────────────────────────
 *
 * Reuses the existing `getRazorpayClient()` singleton from lib/razorpay/client.ts.
 * No new credentials or environment variables are required.
 *
 * ─── SDK error shape (verified from node_modules/razorpay/dist/api.js) ──────
 *
 * When an HTTP error occurs, the Razorpay SDK normalises it and throws:
 *   { statusCode: number, error: { code, description, ... } }
 *
 * This matches the `INormalizeError` type from the SDK type definitions.
 * Network-level errors (no HTTP response) propagate as plain Error objects.
 *
 * MUST NOT be imported in any browser-side code.
 */

import { getRazorpayClient } from "@/lib/razorpay/client";

// ─── Razorpay API status literal type ────────────────────────────────────────
//
// Sourced from node_modules/razorpay/dist/types/payments.d.ts (line 82):
//   status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
//
// Defined inline to avoid depending on a non-public deep import path.
// If the Razorpay SDK ever adds a new status, this type should be updated.

/** Exact status values returned by the Razorpay Payments API. */
export type RazorpayApiPaymentStatus =
  | "created"
  | "authorized"
  | "captured"
  | "refunded"
  | "failed";

// ─── Observation type ─────────────────────────────────────────────────────────

/**
 * Normalised internal snapshot of a Razorpay payment as returned by the API.
 *
 * Fields are camelCased following the project's internal convention.
 * The `razorpayStatus` field preserves the exact value from the Razorpay API.
 *
 * This is NOT an M3 `PaymentState`. It is an independent API observation.
 * Callers must not conflate these two concepts.
 */
export interface RazorpayPaymentObservation {
  /** The payment ID as confirmed by the Razorpay API response. */
  paymentId: string;
  /**
   * Raw Razorpay payment status from the API.
   * Possible values: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'
   *
   * Note: 'refunded' is a valid Razorpay API status but has no corresponding
   * M3 PaymentState. It is preserved here for future milestone use.
   */
  razorpayStatus: RazorpayApiPaymentStatus;
  /** Whether the payment has been captured (true only for 'captured' status). */
  captured: boolean;
  /** Payment amount in the smallest currency unit (e.g. paise for INR). */
  amount: number;
  /** ISO 4217 currency code, e.g. "INR". */
  currency: string;
  /** UNIX timestamp when Razorpay created the payment record. */
  createdAt: number;
  /** ISO 8601 timestamp when our application received this API observation. */
  fetchedAt: string;
  // Error fields — populated for 'failed' status; null otherwise.
  errorCode: string | null;
  errorDescription: string | null;
  errorSource: string | null;
  errorStep: string | null;
  errorReason: string | null;
}

// ─── Result type ──────────────────────────────────────────────────────────────

/**
 * Discriminated union result returned by `fetchPaymentStatus`.
 *
 * Never throws — all outcomes are represented as union members so callers can
 * use exhaustive type narrowing without wrapping in try/catch.
 *
 *   success       → API call succeeded; `observation` contains the data.
 *   not_found     → Razorpay returned 404 (payment does not exist in this account/mode).
 *   api_error     → Razorpay returned a non-404 HTTP error, or a network error occurred.
 *   config_error  → Required Razorpay credentials are not configured.
 */
export type RazorpayPaymentFetchResult =
  | { outcome: "success"; observation: RazorpayPaymentObservation }
  | { outcome: "not_found" }
  | { outcome: "api_error"; message: string }
  | { outcome: "config_error"; message: string };

// ─── Local structural type for the Razorpay SDK payment response ─────────────
//
// Describes only the fields we actually read from the SDK response.
// Structurally compatible with the full `Payments.RazorpayPayment` SDK type,
// but defined locally to avoid depending on a non-public deep import path.

interface RazorpayPaymentResponse {
  id: string;
  status: RazorpayApiPaymentStatus;
  captured?: boolean;
  amount: number | string;
  currency: string;
  created_at: number;
  error_code?: string | null;
  error_description?: string | null;
  error_source?: string | null;
  error_step?: string | null;
  error_reason?: string | null;
}

// ─── Normalization (pure) ─────────────────────────────────────────────────────

/**
 * Converts a raw Razorpay SDK payment object into the internal
 * `RazorpayPaymentObservation` representation.
 *
 * This is a PURE function — no network I/O, no side effects.
 * Kept separate from `fetchPaymentStatus` so it can be unit-tested cheaply
 * without mocking network calls.
 *
 * @param payment - The payment object returned by `razorpay.payments.fetch()`.
 * @returns A normalised `RazorpayPaymentObservation`.
 */
export function normalizePaymentObservation(
  payment: RazorpayPaymentResponse
): RazorpayPaymentObservation {
  return {
    paymentId:        payment.id,
    razorpayStatus:   payment.status,
    captured:         payment.captured ?? false,
    amount:           Number(payment.amount),
    currency:         payment.currency,
    createdAt:        payment.created_at,
    fetchedAt:        new Date().toISOString(),
    errorCode:        payment.error_code        ?? null,
    errorDescription: payment.error_description ?? null,
    errorSource:      payment.error_source      ?? null,
    errorStep:        payment.error_step        ?? null,
    errorReason:      payment.error_reason      ?? null,
  };
}

// ─── Error classification (pure) ──────────────────────────────────────────────

/**
 * Classifies a thrown SDK error into one of the recognised failure outcomes.
 *
 * The Razorpay SDK normalises HTTP errors as:
 *   { statusCode: number, error: { code, description, ... } }
 * (verified from node_modules/razorpay/dist/api.js `normalizeError` function)
 *
 * Network-level failures (no HTTP response) propagate as plain Error objects
 * and are classified as `api_error`.
 *
 * Credentials are NEVER included in the returned message strings.
 *
 * @param err - The value caught from a rejected SDK promise.
 * @returns An `api_error` or `not_found` result object.
 */
export function classifyRazorpayError(
  err: unknown
): Extract<RazorpayPaymentFetchResult, { outcome: "not_found" | "api_error" }> {
  // The SDK throws a plain object (not an Error instance) for HTTP errors.
  if (err !== null && typeof err === "object") {
    const maybeNormalized = err as {
      statusCode?: unknown;
      error?: { code?: string; description?: string };
    };

    if (maybeNormalized.statusCode !== undefined) {
      // HTTP error from Razorpay.
      const code = Number(maybeNormalized.statusCode);
      const description = maybeNormalized.error?.description ?? "";

      // Razorpay returns 404 for nonexistent IDs in some contexts, but was
      // observed returning HTTP 400 with "The id provided does not exist" in
      // real Test Mode verification (confirmed: scripts/test-m4-live.mjs).
      //
      // Razorpay may also return 400 with "not found" phrasing depending on
      // the ID format or context. Both variants indicate the payment ID is
      // unknown to this Razorpay account/mode — classify as not_found.
      const lowerDesc = description.toLowerCase();
      if (
        code === 404 ||
        (code === 400 &&
          (lowerDesc.includes("does not exist") ||
           lowerDesc.includes("not found")))
      ) {
        return { outcome: "not_found" };
      }

      // Other HTTP errors — extract a safe description (no credentials).
      const safeDescription = description || "Razorpay API error";
      return {
        outcome: "api_error",
        message: `Razorpay API returned status ${code}: ${safeDescription}`,
      };
    }
  }

  // Plain Error (network failure, unexpected throw, etc.)
  if (err instanceof Error) {
    return {
      outcome: "api_error",
      message: `Unexpected error calling Razorpay API: ${err.message}`,
    };
  }

  return {
    outcome: "api_error",
    message: "An unknown error occurred calling the Razorpay API",
  };
}

// ─── Main fetch function ───────────────────────────────────────────────────────

/**
 * Fetches the current status of a Razorpay payment directly from the API.
 *
 * Uses the existing `getRazorpayClient()` singleton — no new authentication
 * setup is required. Credentials are read from environment variables by the
 * existing client and are never surfaced in return values or logs.
 *
 * This function performs NETWORK I/O. It is not pure.
 *
 * @param paymentId - The Razorpay payment ID, e.g. "pay_TUJOzQxoEqFSLU".
 * @returns A `RazorpayPaymentFetchResult` discriminated union — never throws.
 */
export async function fetchPaymentStatus(
  paymentId: string
): Promise<RazorpayPaymentFetchResult> {
  // 1. Guard: reject obviously invalid input before making a network call.
  if (!paymentId || !paymentId.trim()) {
    return {
      outcome: "api_error",
      message: "paymentId must be a non-empty string",
    };
  }

  // 2. Initialise the client — throws a config Error if credentials are absent.
  let razorpay: ReturnType<typeof getRazorpayClient>;
  try {
    razorpay = getRazorpayClient();
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Razorpay client configuration error";
    return { outcome: "config_error", message };
  }

  // 3. Call the Razorpay API.
  try {
    const payment = await razorpay.payments.fetch(paymentId.trim());
    const observation = normalizePaymentObservation(payment);
    return { outcome: "success", observation };
  } catch (err) {
    return classifyRazorpayError(err);
  }
}
