/**
 * POST /api/payment-link
 *
 * Creates a Razorpay Test Mode Standard Payment Link.
 * This is a server-side-only route — credentials never reach the client.
 *
 * Milestone 1: Technical validation of Razorpay Test Mode connectivity.
 */

import { NextResponse } from "next/server";
import { getRazorpayClient } from "@/lib/razorpay/client";
import { randomUUID } from "crypto";

// Only allow POST — creating a Payment Link is a non-idempotent write operation.
export async function POST() {
  // 1. Verify required environment variables are present.
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return NextResponse.json(
      {
        error:
          "Server configuration error: Razorpay credentials are not configured.",
      },
      { status: 500 }
    );
  }

  // Razorpay reference_id max length is 40 characters.
  // "recoverai-m1-" = 13 chars + 8 hex chars = 21 chars total.
  const referenceId = `recoverai-m1-${randomUUID().replace(/-/g, "").slice(0, 8)}`;

  try {
    const razorpay = getRazorpayClient();

    // 3. Make the REAL authenticated request to Razorpay Test Mode.
    //    POST https://api.razorpay.com/v1/payment_links
    //
    //    amount is in paise (smallest currency unit):
    //    ₹100 = 10000 paise
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const paymentLink = await razorpay.paymentLink.create({
      amount: 10000, // ₹100 in paise
      currency: "INR",
      description: "RecoverAI – Milestone 1 Test Mode Payment Link",
      reference_id: referenceId,
      // Note: the SDK type marks `customer` as required, but the Razorpay API
      // accepts Standard Payment Links without it. Omitting it avoids a
      // BAD_REQUEST_ERROR ("faulty key: customer") when an empty object is sent.
    } as any); // eslint-disable-line @typescript-eslint/no-explicit-any


    // 4. Return only the safe fields needed for verification.
    //    Do NOT return the full Razorpay response object.
    return NextResponse.json(
      {
        id: paymentLink.id,
        short_url: paymentLink.short_url,
        status: paymentLink.status,
        amount: paymentLink.amount,
        currency: paymentLink.currency,
        reference_id: paymentLink.reference_id,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    // Handle Razorpay API errors without leaking credentials or internals.
    const message =
      err instanceof Error ? err.message : "Unknown error occurred.";

    // Razorpay SDK errors include an `error` property with structured details.
    const razorpayError = (err as { error?: { description?: string; code?: string } })?.error;

    return NextResponse.json(
      {
        error: "Failed to create Razorpay Payment Link.",
        details: razorpayError
          ? {
              description: razorpayError.description ?? message,
              code: razorpayError.code ?? "UNKNOWN",
            }
          : { description: message, code: "UNKNOWN" },
      },
      { status: 502 }
    );
  }
}
