/**
 * POST /api/webhooks/razorpay
 *
 * Receives, authenticates, deduplicates, and persists Razorpay webhook events.
 *
 * Processing order (MUST NOT be changed):
 *   1. Read the raw request body as a string.
 *   2. Read X-Razorpay-Signature header.
 *   3. Read X-Razorpay-Event-Id header.
 *   4. Verify HMAC-SHA256 signature against the raw body.
 *   5. Reject invalid signatures with 401.
 *   6. Parse JSON.
 *   7. Validate event type is supported.
 *   8. Deduplicate using event_id (DB UNIQUE constraint).
 *   9. Persist the verified event.
 *  10. Return 200.
 *
 * Milestone 2: Reliable Razorpay Webhook Intake.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  verifyRazorpaySignature,
  extractRelatedEntityId,
  persistWebhookEvent,
  isSupportedEventType,
} from "@/lib/razorpay/webhooks";

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Step 1: Read the raw body BEFORE any JSON parsing. ──────────────────────
  // Next.js App Router does not auto-parse the body in route handlers when
  // you call req.text() — the raw bytes are preserved exactly as received.
  const rawBody = await req.text();

  // ── Step 2: Read security-critical headers. ──────────────────────────────────
  const receivedSignature = req.headers.get("x-razorpay-signature");
  const eventId = req.headers.get("x-razorpay-event-id");

  // ── Step 3: Require event ID — used for idempotency. ────────────────────────
  if (!eventId) {
    console.warn("[webhook] Missing X-Razorpay-Event-Id header");
    return NextResponse.json(
      { error: "Missing X-Razorpay-Event-Id header" },
      { status: 400 }
    );
  }

  // ── Step 4: Verify signature against the raw body. ──────────────────────────
  let signatureValid: boolean;
  try {
    signatureValid = verifyRazorpaySignature(rawBody, receivedSignature);
  } catch (err) {
    // RAZORPAY_WEBHOOK_SECRET is not configured.
    const message = err instanceof Error ? err.message : "Configuration error";
    console.error("[webhook] Signature verification configuration error:", message);
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  // ── Step 5: Reject invalid signatures. ──────────────────────────────────────
  if (!signatureValid) {
    console.warn("[webhook] Invalid signature for event:", eventId);
    return NextResponse.json(
      { error: "Invalid webhook signature" },
      { status: 401 }
    );
  }

  // ── Step 6: Parse JSON (only after signature is verified). ──────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsedPayload: Record<string, any>;
  try {
    parsedPayload = JSON.parse(rawBody);
  } catch {
    console.warn("[webhook] Failed to parse JSON body for event:", eventId);
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  const eventType: string = parsedPayload.event ?? "";

  // ── Step 7: Validate the event type. ────────────────────────────────────────
  if (!isSupportedEventType(eventType)) {
    // Unsupported events are acknowledged (200) but not persisted or processed.
    // This prevents Razorpay from retrying them unnecessarily.
    console.log(`[webhook] Unsupported event type received: "${eventType}" — acknowledging without processing`);
    return NextResponse.json(
      { received: true, processed: false, reason: "event_type_not_supported" },
      { status: 200 }
    );
  }

  // ── Step 8 + 9: Extract entity ID, deduplicate, and persist. ────────────────
  const relatedEntityId = extractRelatedEntityId(eventType, parsedPayload.payload ?? {});

  let persistResult: { inserted: boolean; isDuplicate: boolean };
  try {
    persistResult = persistWebhookEvent({
      eventId,
      eventType,
      relatedEntityId,
      rawPayload: rawBody,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[webhook] Failed to persist event:", eventId, message);
    // Return 500 so Razorpay will retry — we want to guarantee persistence.
    return NextResponse.json(
      { error: "Failed to persist event" },
      { status: 500 }
    );
  }

  // ── Step 10: Acknowledge. ────────────────────────────────────────────────────
  if (persistResult.isDuplicate) {
    console.log(`[webhook] Duplicate event received: ${eventId} (${eventType}) — already processed`);
    return NextResponse.json(
      { received: true, processed: false, reason: "duplicate_event_id" },
      { status: 200 }
    );
  }

  console.log(
    `[webhook] Event persisted: ${eventId} | type=${eventType} | entity=${relatedEntityId ?? "none"}`
  );

  return NextResponse.json(
    { received: true, processed: true },
    { status: 200 }
  );
}
