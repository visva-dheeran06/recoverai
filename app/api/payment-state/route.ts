/**
 * GET /api/payment-state?paymentId=pay_xxx
 *
 * Returns the canonical factual payment state for a given payment ID,
 * derived deterministically from the persisted Razorpay webhook event history.
 *
 * This endpoint does NOT call the Razorpay API — it reads only from the
 * local webhook_events table populated by M2 webhook intake.
 *
 * Milestone 3: Canonical Payment State Derivation.
 *
 * Response shape:
 *   200 { paymentId, state, derivedAt }
 *   400 { error }
 *
 * Possible state values:
 *   "CAPTURED"    — payment.captured received (highest finality)
 *   "AUTHORIZED"  — payment.authorized received, no capture yet
 *   "FAILED"      — payment.failed received, no higher-finality event
 *   "UNKNOWN"     — no recognised state-bearing events received for this payment
 */

import { NextRequest, NextResponse } from "next/server";
import { derivePaymentState } from "@/lib/payments/state";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const paymentId = req.nextUrl.searchParams.get("paymentId");

  if (!paymentId || !paymentId.trim()) {
    return NextResponse.json(
      { error: "Missing required query parameter: paymentId" },
      { status: 400 }
    );
  }

  let state: ReturnType<typeof derivePaymentState>;
  try {
    state = derivePaymentState(paymentId.trim());
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[payment-state] Failed to derive payment state:", paymentId, message);
    return NextResponse.json(
      { error: "Failed to derive payment state" },
      { status: 500 }
    );
  }

  return NextResponse.json(
    {
      paymentId: paymentId.trim(),
      state,
      derivedAt: new Date().toISOString(),
    },
    { status: 200 }
  );
}
