/**
 * GET /api/razorpay-payment-status?paymentId=pay_xxx
 *
 * Returns the current payment status as observed directly from the Razorpay API.
 *
 * This is the M4 fallback observation layer. It calls the Razorpay API
 * independently from the webhook-derived state provided by M3.
 *
 * This endpoint DOES call the Razorpay API on every request.
 * It does NOT modify the database.
 * It does NOT replace M3.
 * It does NOT implement reconciliation or recovery logic.
 *
 * Endpoint:   GET /api/razorpay-payment-status?paymentId=pay_xxx
 * Source:     Razorpay Payments API (real-time)
 *
 * Response shapes:
 *
 *   200  — payment found; normalized observation returned
 *   400  — missing or malformed paymentId
 *   404  — payment not found in Razorpay (not_found outcome)
 *   500  — server configuration error (credentials missing)
 *   502  — Razorpay API error or network failure
 *
 * Milestone 4: Razorpay API Status Fallback.
 *
 * MUST NOT be imported in browser-side code.
 */

import { NextRequest, NextResponse } from "next/server";
import { fetchPaymentStatus } from "@/lib/razorpay/payments";

// ─── paymentId validation ─────────────────────────────────────────────────────
//
// Razorpay payment IDs begin with "pay_" followed by alphanumeric characters.
// We use a minimal pattern that:
//   - enforces the "pay_" prefix (known from real data)
//   - requires at least one character after the prefix
//   - rejects whitespace-only or obviously wrong IDs
//   - does NOT hard-code a fixed length (Razorpay could change ID length)
//
// Examples of valid IDs seen in real Test Mode data:
//   pay_TUJOzQxoEqFSLU  (16 chars after prefix)
//   pay_TUJULUouXtIq8y  (16 chars after prefix)
//
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

  // 3. Call the M4 payment status client
  const result = await fetchPaymentStatus(paymentId);

  switch (result.outcome) {
    case "success": {
      const obs = result.observation;
      // Map internal observation fields to the documented route response shape.
      // The field "status" is the external-facing name (from razorpayStatus).
      return NextResponse.json(
        {
          paymentId:        obs.paymentId,
          source:           "razorpay_api",
          status:           obs.razorpayStatus,
          captured:         obs.captured,
          amount:           obs.amount,
          currency:         obs.currency,
          fetchedAt:        obs.fetchedAt,
          errorCode:        obs.errorCode,
          errorDescription: obs.errorDescription,
          errorSource:      obs.errorSource,
          errorStep:        obs.errorStep,
          errorReason:      obs.errorReason,
        },
        { status: 200 }
      );
    }

    case "not_found": {
      return NextResponse.json(
        {
          error:     "Payment not found",
          paymentId,
          source:    "razorpay_api",
        },
        { status: 404 }
      );
    }

    case "api_error": {
      // Log the safe internal message server-side; return a generic response.
      console.error("[razorpay-payment-status] Razorpay API error:", result.message);
      return NextResponse.json(
        {
          error:  "Razorpay API error — unable to retrieve payment status",
          source: "razorpay_api",
        },
        { status: 502 }
      );
    }

    case "config_error": {
      console.error("[razorpay-payment-status] Configuration error:", result.message);
      return NextResponse.json(
        { error: "Server configuration error — payment status unavailable" },
        { status: 500 }
      );
    }
  }
}
