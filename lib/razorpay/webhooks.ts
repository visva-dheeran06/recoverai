/**
 * Razorpay webhook utilities — server-side only.
 *
 * Provides:
 *   - Raw-body HMAC-SHA256 signature verification
 *   - Event payload parsing and entity ID extraction
 *
 * MUST NOT be imported in any browser-side code.
 */

import { createHmac } from "crypto";
import { getDb } from "@/lib/db/client";

// ─── Supported event types ────────────────────────────────────────────────────

export const SUPPORTED_EVENT_TYPES = [
  "payment.failed",
  "payment.authorized",
  "payment.captured",
  "payment_link.paid",
] as const;

export type SupportedEventType = (typeof SUPPORTED_EVENT_TYPES)[number];

export function isSupportedEventType(
  event: string
): event is SupportedEventType {
  return (SUPPORTED_EVENT_TYPES as readonly string[]).includes(event);
}

// ─── Signature verification ───────────────────────────────────────────────────

/**
 * Verifies the Razorpay HMAC-SHA256 webhook signature.
 *
 * Signature is computed over the EXACT raw request body bytes.
 * Do NOT call this with a re-serialised JSON string — it must be the
 * original body string received from the network.
 *
 * Throws if the secret is not configured.
 * Returns `true` if valid, `false` if invalid.
 */
export function verifyRazorpaySignature(
  rawBody: string,
  receivedSignature: string | null
): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (!secret) {
    throw new Error(
      "Missing required environment variable: RAZORPAY_WEBHOOK_SECRET. " +
        "Ensure .env.local is present with the Test Mode webhook secret."
    );
  }

  if (!receivedSignature) {
    return false;
  }

  const expectedSignature = createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");

  // Use a constant-time comparison to prevent timing attacks.
  if (expectedSignature.length !== receivedSignature.length) {
    return false;
  }

  let mismatch = 0;
  for (let i = 0; i < expectedSignature.length; i++) {
    mismatch |= expectedSignature.charCodeAt(i) ^ receivedSignature.charCodeAt(i);
  }

  return mismatch === 0;
}

// ─── Entity ID extraction ─────────────────────────────────────────────────────

/**
 * Extracts the primary correlatable entity ID from a Razorpay webhook payload.
 *
 * For payment events (payment.failed / payment.authorized / payment.captured):
 *   → payload.payment.entity.id  (e.g. "pay_XXXXX")
 *
 * For payment_link.paid:
 *   → payload.payment_link.entity.id  (e.g. "plink_XXXXX")
 *   The payment ID is also present at payload.payment.entity.id but the
 *   primary correlatable entity for a Payment Link event is the link itself.
 *
 * Returns null if the expected field is absent (logged at caller level).
 */
export function extractRelatedEntityId(
  eventType: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>
): string | null {
  if (eventType === "payment_link.paid") {
    return payload?.payment_link?.entity?.id ?? null;
  }
  // payment.failed, payment.authorized, payment.captured
  return payload?.payment?.entity?.id ?? null;
}

// ─── Event persistence ────────────────────────────────────────────────────────

export interface WebhookEventRecord {
  id: number;
  event_id: string;
  event_type: string;
  related_entity_id: string | null;
  received_at: string;
  signature_verified: number;
  raw_payload: string;
}

export interface InsertWebhookEventParams {
  eventId: string;
  eventType: string;
  relatedEntityId: string | null;
  rawPayload: string;
}

/**
 * Persists a verified webhook event.
 *
 * Uniqueness is enforced at the DATABASE level via the UNIQUE constraint on
 * `event_id`. If a duplicate `event_id` arrives, the INSERT is silently
 * ignored (INSERT OR IGNORE) and `isDuplicate: true` is returned so the
 * caller can return 200 without re-processing.
 */
export function persistWebhookEvent(params: InsertWebhookEventParams): {
  inserted: boolean;
  isDuplicate: boolean;
} {
  const db = getDb();

  const stmt = db.prepare(`
    INSERT OR IGNORE INTO webhook_events
      (event_id, event_type, related_entity_id, received_at, signature_verified, raw_payload)
    VALUES
      (@eventId, @eventType, @relatedEntityId, @receivedAt, 1, @rawPayload)
  `);

  const result = stmt.run({
    eventId: params.eventId,
    eventType: params.eventType,
    relatedEntityId: params.relatedEntityId,
    receivedAt: new Date().toISOString(),
    rawPayload: params.rawPayload,
  });

  const inserted = result.changes === 1;

  return {
    inserted,
    isDuplicate: !inserted,
  };
}
