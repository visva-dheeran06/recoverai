/**
 * M4 Razorpay Payment Status Client — Unit Tests
 *
 * Run with:  node --test tests/razorpay-payment-status.test.mjs
 *            (or via: npm test)
 *
 * ─── Test scope ───────────────────────────────────────────────────────────────
 *
 * These tests cover the PURE, network-free functions only:
 *
 *   normalizePaymentObservation(payment)  — converts SDK object to internal type
 *   classifyRazorpayError(err)            — classifies thrown SDK errors
 *
 * `fetchPaymentStatus` is NOT tested here because it performs network I/O.
 * Real Razorpay Test Mode verification will be covered in a separate live script.
 *
 * ─── No live API calls are made in this file ─────────────────────────────────
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { normalizePaymentObservation, classifyRazorpayError } = await import(
  "../lib/razorpay/payments.ts"
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Minimal base fixture matching Razorpay SDK's RazorpayPayment shape. */
function makePayment(overrides = {}) {
  return {
    id: "pay_TEST000000000",
    entity: "payment",
    status: "authorized",
    captured: false,
    amount: 10000,
    currency: "INR",
    created_at: 1724654052,
    // Required fields from RazorpayPaymentBaseRequestBody (present in SDK type)
    order_id: "order_TESTORDER0000",
    email: "test@example.com",
    contact: "+919999999999",
    notes: {},
    customer_id: "",
    // Error fields — null by default
    error_code: null,
    error_description: null,
    error_source: null,
    error_step: null,
    error_reason: null,
    // Remaining fields present on the SDK type
    invoice_id: null,
    international: false,
    refund_status: "null",
    bank: "",
    card_id: null,
    wallet: null,
    vpa: null,
    tax: 0,
    token_id: null,
    fee: 0,
    acquirer_data: {},
    method: "card",
    offers: { entity: "collection", count: 0, items: [] },
    ...overrides,
  };
}

// ─── normalizePaymentObservation ─────────────────────────────────────────────

describe("normalizePaymentObservation — pure normalization", () => {

  test("1. captured payment — status and captured flag", () => {
    const payment = makePayment({ status: "captured", captured: true });
    const obs = normalizePaymentObservation(payment);

    assert.equal(obs.paymentId,      "pay_TEST000000000");
    assert.equal(obs.razorpayStatus, "captured");
    assert.equal(obs.captured,       true);
    assert.equal(obs.amount,         10000);
    assert.equal(obs.currency,       "INR");
    assert.equal(obs.createdAt,      1724654052);
    assert.equal(obs.errorCode,      null);
    assert.equal(obs.errorDescription, null);
    assert.equal(obs.errorSource,    null);
    assert.equal(obs.errorStep,      null);
    assert.equal(obs.errorReason,    null);
  });

  test("2. authorized payment — captured is false, no error fields", () => {
    const payment = makePayment({ status: "authorized", captured: false });
    const obs = normalizePaymentObservation(payment);

    assert.equal(obs.razorpayStatus, "authorized");
    assert.equal(obs.captured,       false);
    assert.equal(obs.errorCode,      null);
  });

  test("3. failed payment — error fields are populated", () => {
    const payment = makePayment({
      status:            "failed",
      captured:          false,
      error_code:        "BAD_REQUEST_ERROR",
      error_description: "Payment processing failed because of incorrect OTP",
      error_source:      "customer",
      error_step:        "payment_authentication",
      error_reason:      "incorrect_otp",
    });
    const obs = normalizePaymentObservation(payment);

    assert.equal(obs.razorpayStatus,   "failed");
    assert.equal(obs.captured,         false);
    assert.equal(obs.errorCode,        "BAD_REQUEST_ERROR");
    assert.equal(obs.errorDescription, "Payment processing failed because of incorrect OTP");
    assert.equal(obs.errorSource,      "customer");
    assert.equal(obs.errorStep,        "payment_authentication");
    assert.equal(obs.errorReason,      "incorrect_otp");
  });

  test("4. refunded status — preserved as 'refunded', not mapped to an M3 state", () => {
    const payment = makePayment({ status: "refunded", captured: true });
    const obs = normalizePaymentObservation(payment);

    // 'refunded' is a valid Razorpay API status; it must pass through unchanged.
    assert.equal(obs.razorpayStatus, "refunded");
    // captured remains whatever the API returned for a refunded payment.
    assert.equal(obs.captured, true);
  });

  test("5. created status — preserved as 'created'", () => {
    const payment = makePayment({ status: "created", captured: false });
    const obs = normalizePaymentObservation(payment);
    assert.equal(obs.razorpayStatus, "created");
    assert.equal(obs.captured, false);
  });

  test("6. amount is always a number (SDK may return string)", () => {
    // The SDK type declares `amount: number | string`.
    const payment = makePayment({ amount: "15000" });
    const obs = normalizePaymentObservation(payment);
    assert.strictEqual(typeof obs.amount, "number");
    assert.equal(obs.amount, 15000);
  });

  test("7. captured defaults to false when field is missing/undefined", () => {
    const payment = makePayment({ captured: undefined });
    const obs = normalizePaymentObservation(payment);
    assert.equal(obs.captured, false);
  });

  test("8. fetchedAt is a valid ISO 8601 string", () => {
    const before = new Date().toISOString();
    const payment = makePayment({ status: "captured", captured: true });
    const obs = normalizePaymentObservation(payment);
    const after = new Date().toISOString();

    // fetchedAt must be between before and after.
    assert.ok(
      obs.fetchedAt >= before && obs.fetchedAt <= after,
      `fetchedAt "${obs.fetchedAt}" should be between "${before}" and "${after}"`
    );
    // Must be parseable as a date.
    assert.ok(!isNaN(Date.parse(obs.fetchedAt)), "fetchedAt must be a valid date string");
  });

  test("9. no credentials or secrets in observation fields", () => {
    const payment = makePayment({ status: "captured", captured: true });
    const obs = normalizePaymentObservation(payment);
    const serialized = JSON.stringify(obs);

    // These strings must never appear in any returned observation.
    assert.ok(!serialized.includes("key_id"),     "key_id must not appear in observation");
    assert.ok(!serialized.includes("key_secret"), "key_secret must not appear in observation");
    assert.ok(!serialized.includes("rzp_test_"), "API key prefix must not appear in observation");
    assert.ok(!serialized.includes("rzp_live_"), "Live key prefix must not appear in observation");
  });

  test("10. paymentId comes from payment.id, not the caller's argument", () => {
    // normalizePaymentObservation reads the ID from the SDK object — the API
    // is the authoritative source for the confirmed payment ID.
    const payment = makePayment({ id: "pay_CONFIRMED_FROM_API" });
    const obs = normalizePaymentObservation(payment);
    assert.equal(obs.paymentId, "pay_CONFIRMED_FROM_API");
  });

});

// ─── classifyRazorpayError ────────────────────────────────────────────────────

describe("classifyRazorpayError — error classification", () => {

  test("11. SDK 404 error (payment not found) → not_found", () => {
    // Shape confirmed from node_modules/razorpay/dist/api.js `normalizeError`:
    // throws { statusCode: err.response.status, error: err.response.data.error }
    const sdkError = {
      statusCode: 404,
      error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" },
    };
    const result = classifyRazorpayError(sdkError);
    assert.equal(result.outcome, "not_found");
  });

  test("11b. SDK 400 with 'does not exist' (real Razorpay Test Mode behavior) → not_found", () => {
    // VERIFIED by live Test Mode call (scripts/test-m4-live.mjs):
    // Razorpay returns HTTP 400 (not 404) for pay_DOESNOTEXIST with this description.
    const sdkError = {
      statusCode: 400,
      error: { code: "BAD_REQUEST_ERROR", description: "The id provided does not exist" },
    };
    const result = classifyRazorpayError(sdkError);
    assert.equal(result.outcome, "not_found",
      "Razorpay 400 'does not exist' must be classified as not_found (confirmed live)"
    );
  });

  test("11c. SDK 400 with 'not found' phrasing → not_found", () => {
    // Some Razorpay API contexts or ID formats may return "not found" phrasing.
    // Both are semantically equivalent — the payment ID is unknown.
    const sdkError = {
      statusCode: 400,
      error: { code: "BAD_REQUEST_ERROR", description: "The requested payment not found" },
    };
    const result = classifyRazorpayError(sdkError);
    assert.equal(result.outcome, "not_found",
      "Razorpay 400 'not found' phrasing must be classified as not_found"
    );
  });

  test("12. SDK 400 with different error (not not_found) → api_error with message", () => {
    const sdkError = {
      statusCode: 400,
      error: { code: "BAD_REQUEST_ERROR", description: "The amount is not valid" },
    };
    const result = classifyRazorpayError(sdkError);
    assert.equal(result.outcome, "api_error");
    assert.ok(
      result.outcome === "api_error" && result.message.includes("400"),
      `message should include status code, got: ${result.outcome === "api_error" ? result.message : "(not api_error)"}`
    );
  });

  test("13. SDK 401 error (bad credentials) → api_error", () => {
    const sdkError = {
      statusCode: 401,
      error: { code: "BAD_REQUEST_ERROR", description: "Unauthorized" },
    };
    const result = classifyRazorpayError(sdkError);
    assert.equal(result.outcome, "api_error");
  });

  test("14. SDK 500 error → api_error", () => {
    const sdkError = {
      statusCode: 500,
      error: { code: "SERVER_ERROR", description: "Internal server error" },
    };
    const result = classifyRazorpayError(sdkError);
    assert.equal(result.outcome, "api_error");
  });

  test("15. Plain Error (network failure) → api_error", () => {
    const networkError = new Error("connect ECONNREFUSED 127.0.0.1:443");
    const result = classifyRazorpayError(networkError);
    assert.equal(result.outcome, "api_error");
    assert.ok(
      result.outcome === "api_error" && result.message.includes("ECONNREFUSED"),
      "message should contain the network error details"
    );
  });

  test("16. Completely unknown thrown value → api_error", () => {
    const result = classifyRazorpayError("something weird");
    assert.equal(result.outcome, "api_error");
  });

  test("17. null thrown → api_error (not a crash)", () => {
    const result = classifyRazorpayError(null);
    assert.equal(result.outcome, "api_error");
  });

  test("18. SDK error with missing error.description → api_error with fallback message", () => {
    const sdkError = { statusCode: 503, error: {} }; // description missing
    const result = classifyRazorpayError(sdkError);
    assert.equal(result.outcome, "api_error");
    // Should not throw or return empty string.
    assert.ok(
      result.outcome === "api_error" && result.message.length > 0,
      "message must not be empty"
    );
  });

  test("19. no credentials/secrets appear in api_error messages", () => {
    const sdkError = {
      statusCode: 401,
      error: { code: "BAD_REQUEST_ERROR", description: "Unauthorized" },
    };
    const result = classifyRazorpayError(sdkError);
    if (result.outcome === "api_error") {
      assert.ok(!result.message.includes("key_id"),     "key_id must not appear in error message");
      assert.ok(!result.message.includes("key_secret"), "key_secret must not appear in error message");
    }
  });

  test("20. cross-contamination: classifying error for payment A never yields payment B data", () => {
    // classifyRazorpayError is stateless — it only reads the thrown error.
    // This test confirms two sequential calls are fully independent.
    const err404 = { statusCode: 404, error: { code: "BAD_REQUEST_ERROR", description: "not found" } };
    const err500 = { statusCode: 500, error: { code: "SERVER_ERROR", description: "server error" } };

    const resultA = classifyRazorpayError(err404);
    const resultB = classifyRazorpayError(err500);

    assert.equal(resultA.outcome, "not_found");
    assert.equal(resultB.outcome, "api_error");
    // The two results must be distinct outcomes.
    assert.notEqual(resultA.outcome, resultB.outcome);
  });

});
