/**
 * Server-side Razorpay client initialisation.
 *
 * This module must ONLY be imported in server-side code (API routes, server
 * actions, etc.). It must never be imported in any file that ships to the browser.
 *
 * Credentials are read exclusively from environment variables and are never
 * logged, returned in responses, or exposed to client-side code.
 */

import Razorpay from "razorpay";

function createRazorpayClient(): Razorpay {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    throw new Error(
      "Missing required environment variables: RAZORPAY_KEY_ID and/or RAZORPAY_KEY_SECRET. " +
        "Ensure .env.local is present with valid Test Mode credentials."
    );
  }

  return new Razorpay({
    key_id: keyId,
    key_secret: keySecret,
  });
}

// Lazily-initialised singleton — created once on first import.
let _client: Razorpay | null = null;

export function getRazorpayClient(): Razorpay {
  if (!_client) {
    _client = createRazorpayClient();
  }
  return _client;
}
