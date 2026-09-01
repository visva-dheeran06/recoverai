/**
 * GET /api/reconciliation?paymentId=pay_xxx
 *
 * Returns the M5 reconciliation result for a given payment ID.
 *
 * Reconciliation compares:
 *   M3 — webhook-derived canonical payment state (from persisted webhook_events)
 *   M4 — on-demand Razorpay API observation (fetched in real-time)
 *
 * This endpoint is a THIN ADAPTER over `reconcilePayment`. All classification
 * logic lives in `lib/payments/reconciliation.ts`.
 *
 * This endpoint DOES call the Razorpay API on every request.
 * It DOES read the database (M3 state derivation).
 * It does NOT modify the database.
 * It does NOT implement recovery logic or AI diagnosis.
 * It does NOT poll or run background jobs.
 *
 * Response shapes:
 *
 *   200  — reconciliation completed (outcome may be CONSISTENT, API_AHEAD, etc.)
 *   400  — missing or malformed paymentId
 *   500  — unexpected server error
 *
 * Milestone 5: Payment Reconciliation.
 *
 * MUST NOT be imported in browser-side code.
 */

import { NextRequest, NextResponse } from "next/server";
import { reconcilePayment } from "@/lib/payments/reconciliation";

// ─── paymentId validation ─────────────────────────────────────────────────────
//
// Mirrors the validation in the M4 route.
// Razorpay payment IDs begin with "pay_" followed by at least one alphanumeric char.

const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]{1,}$/;

function isValidPaymentId(id: string): boolean {
  return PAYMENT_ID_PATTERN.test(id);
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const raw = req.nextUrl.searchParams.get("paymentId");

  // 1. Missing parameter
  if (!raw || !raw.trim()) {
    return NextResponse.json(
      { error: "Missing required query parameter: paymentId" },
      { status: 400 }
    );
  }

  const paymentId = raw.trim();

  // 2. Malformed ID
  if (!isValidPaymentId(paymentId)) {
    return NextResponse.json(
      {
        error: "Invalid paymentId format — expected Razorpay payment ID (e.g. pay_xxx)",
        paymentId,
      },
      { status: 400 }
    );
  }

  // 3. Reconcile — never throws
  let result;
  try {
    result = await reconcilePayment(paymentId);
  } catch (err) {
    // reconcilePayment is documented to never throw, but guard defensively.
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[reconciliation] Unexpected error:", msg);
    return NextResponse.json(
      { error: "Server error — reconciliation failed" },
      { status: 500 }
    );
  }

  // 4. Map result to response body.
  // The response exposes the reconciliation result directly.
  // apiObservation is included only when present (non-null).
  // Credentials are never in the result (enforced by reconcilePayment).
  return NextResponse.json(
    {
      paymentId:     result.paymentId,
      outcome:       result.outcome,
      webhookState:  result.webhookState,
      apiObservation: result.apiObservation,
      summary:       result.summary,
      reconciledAt:  result.reconciledAt,
    },
    { status: 200 }
  );
}
