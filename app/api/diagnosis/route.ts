/**
 * GET /api/diagnosis?paymentId=pay_xxx
 *
 * Returns the M7A deterministic diagnosis and recommendation for a payment,
 * optionally enhanced by M7B AI (Gemini).
 *
 * This is a thin adapter over `diagnosePayment` in
 * `lib/payments/diagnosis.ts`. All deterministic logic lives in the lib.
 *
 * M7B: If GEMINI_API_KEY is present, `enhanceWithAi` is called as a
 * best-effort post-processor. It may upgrade generation.mode to "ai" if it
 * produces valid output. Any failure (missing key, SDK error, timeout, bad
 * output) preserves the original deterministic result unchanged.
 *
 * This endpoint:
 *   - Reads from the M2 webhook_events database (via M6 -> M3)
 *   - Does NOT call the Razorpay API
 *   - Does NOT modify the database
 *   - Returns deterministic output when AI is unavailable
 *   - Never exposes PII, credentials, or internal errors
 *
 * Response shapes:
 *   200 - diagnosis completed (generation.mode = "deterministic" or "ai")
 *   400 - missing or malformed paymentId
 *   500 - unexpected server error (generic message only)
 *
 * Milestone 7A: Deterministic Diagnosis and Recommendation.
 * Milestone 7B: Optional AI Enhancement.
 *
 * MUST NOT be imported in browser-side code.
 */

import { NextRequest, NextResponse } from "next/server";
import { diagnosePayment } from "@/lib/payments/diagnosis";

// --- paymentId validation ---
// Mirrors the validation in M4, M5, and M6 routes.

const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]{1,}$/;

function isValidPaymentId(id: string): boolean {
  return PAYMENT_ID_PATTERN.test(id);
}

// --- Route handler ---

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

  // 3. Compute deterministic M7A diagnosis — should not throw, but guard defensively
  let result;
  try {
    result = diagnosePayment(paymentId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    console.error("[diagnosis] Unexpected error:", msg);
    return NextResponse.json(
      { error: "Server error — diagnosis computation failed" },
      { status: 500 }
    );
  }

  // 4. M7B: Attempt optional AI enhancement.
  //    enhanceWithAi() NEVER throws — any failure returns the original result.
  //    No API key → skipped instantly. Error/timeout → deterministic fallback.
  try {
    const { enhanceWithAi } = await import("@/lib/payments/ai-enhancement");
    result = await enhanceWithAi(result);
  } catch {
    // Dynamic import or any unexpected failure — keep deterministic result
  }

  // 5. Return the result directly.
  // The result never contains PII or credentials (enforced by diagnosePayment + enhanceWithAi).
  return NextResponse.json(result, { status: 200 });
}
