/**
 * GET /api/recovery-score?paymentId=pay_xxx
 *
 * Returns the M6 deterministic recovery score for a given payment ID.
 *
 * This is a THIN ADAPTER over `computeRecoveryScore` in
 * `lib/payments/recovery-score.ts`. All scoring logic lives in the lib.
 *
 * This endpoint:
 *   - Reads from the M2 webhook_events database (via M3 state derivation)
 *   - Does NOT call the Razorpay API
 *   - Does NOT modify the database
 *   - Is deterministic for the same payment + reference timestamp
 *
 * Response shapes:
 *
 *   200  — scoring completed (score may reflect low confidence if evidence scarce)
 *   400  — missing or malformed paymentId
 *   500  — unexpected server error
 *
 * Milestone 6: Deterministic Recovery Scoring.
 *
 * MUST NOT be imported in browser-side code.
 */

import { NextRequest, NextResponse } from "next/server";
import { computeRecoveryScore } from "@/lib/payments/recovery-score";

// ─── paymentId validation ─────────────────────────────────────────────────────
//
// Mirrors the validation in M4 and M5 routes.

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
        error:
          "Invalid paymentId format — expected Razorpay payment ID (e.g. pay_xxx)",
        paymentId,
      },
      { status: 400 }
    );
  }

  // 3. Compute recovery score — never throws
  let result;
  try {
    result = computeRecoveryScore(paymentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[recovery-score] Unexpected error:", msg);
    return NextResponse.json(
      { error: "Server error — recovery score computation failed" },
      { status: 500 }
    );
  }

  // 4. Return the result directly.
  // The result never contains credentials (enforced by computeRecoveryScore).
  return NextResponse.json(result, { status: 200 });
}
