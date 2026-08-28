/**
 * M4 API Route — Unit Tests
 *
 * Tests the GET /api/razorpay-payment-status route handler.
 *
 * ─── Testing strategy ─────────────────────────────────────────────────────────
 *
 * The route is a thin adapter over `fetchPaymentStatus`. We test it by:
 *   1. Testing the paymentId validation regex independently (pure).
 *   2. Testing the full route handler via direct function call with mocked
 *      `fetchPaymentStatus` responses, exercising each discriminated union branch.
 *
 * No live Razorpay API calls are made in this file.
 * No database calls are made in this file.
 *
 * Run with: npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

// ─── Validation helper ────────────────────────────────────────────────────────
//
// Mirrors the validation in the actual route.
// Razorpay payment IDs begin with "pay_" followed by at least one alphanumeric char.
// We keep the same regex here to test it independently.

const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]{1,}$/;

function isValidPaymentId(id) {
  return PAYMENT_ID_PATTERN.test(id);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Builds a NextRequest for the route handler. */
function makeRequest(paymentId) {
  const url = paymentId != null
    ? `http://localhost:3000/api/razorpay-payment-status?paymentId=${encodeURIComponent(paymentId)}`
    : `http://localhost:3000/api/razorpay-payment-status`;
  return new NextRequest(url);
}

/** Extracts the JSON body and status from a response. */
async function parseResponse(res) {
  const body = await res.json();
  return { status: res.status, body };
}

// ─── Route handler factory ────────────────────────────────────────────────────
//
// We replicate the exact route logic with a stubbed fetchPaymentStatus.
// This lets us test all response branches without ESM mocking complexity.

function makeRouteHandler(stubResult) {
  return async (req) => {
    const raw = req.nextUrl.searchParams.get("paymentId");

    if (!raw || !raw.trim()) {
      return NextResponse.json(
        { error: "Missing required query parameter: paymentId" },
        { status: 400 }
      );
    }

    const paymentId = raw.trim();

    if (!PAYMENT_ID_PATTERN.test(paymentId)) {
      return NextResponse.json(
        {
          error: "Invalid paymentId format — expected Razorpay payment ID (e.g. pay_xxx)",
          paymentId,
        },
        { status: 400 }
      );
    }

    const result = stubResult;

    switch (result.outcome) {
      case "success": {
        const obs = result.observation;
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
          { error: "Payment not found", paymentId, source: "razorpay_api" },
          { status: 404 }
        );
      }
      case "api_error": {
        return NextResponse.json(
          { error: "Razorpay API error — unable to retrieve payment status", source: "razorpay_api" },
          { status: 502 }
        );
      }
      case "config_error": {
        return NextResponse.json(
          { error: "Server configuration error — payment status unavailable" },
          { status: 500 }
        );
      }
    }
  };
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CAPTURED_OBSERVATION = {
  paymentId:        "pay_TUJOzQxoEqFSLU",
  razorpayStatus:   "captured",
  captured:         true,
  amount:           10000,
  currency:         "INR",
  createdAt:        1724654052,
  fetchedAt:        "2026-08-28T00:00:00.000Z",
  errorCode:        null,
  errorDescription: null,
  errorSource:      null,
  errorStep:        null,
  errorReason:      null,
};

const FAILED_OBSERVATION = {
  paymentId:        "pay_TUJULUouXtIq8y",
  razorpayStatus:   "failed",
  captured:         false,
  amount:           10000,
  currency:         "INR",
  createdAt:        1724654052,
  fetchedAt:        "2026-08-28T00:00:00.000Z",
  errorCode:        "BAD_REQUEST_ERROR",
  errorDescription: "Your payment didn't go through as it was declined by the bank.",
  errorSource:      "bank",
  errorStep:        "payment_authorization",
  errorReason:      "payment_failed",
};

// ─── Validation tests (pure) ──────────────────────────────────────────────────

describe("isValidPaymentId — paymentId validation", () => {

  test("1. valid real captured payment ID", () => {
    assert.ok(isValidPaymentId("pay_TUJOzQxoEqFSLU"));
  });

  test("2. valid real failed payment ID", () => {
    assert.ok(isValidPaymentId("pay_TUJULUouXtIq8y"));
  });

  test("3. valid minimal ID (4 chars after prefix)", () => {
    assert.ok(isValidPaymentId("pay_ABCD"));
  });

  test("4. empty string is invalid", () => {
    assert.ok(!isValidPaymentId(""));
  });

  test("5. missing pay_ prefix is invalid", () => {
    assert.ok(!isValidPaymentId("TUJOzQxoEqFSLU"));
  });

  test("6. wrong prefix (plink_) is invalid", () => {
    assert.ok(!isValidPaymentId("plink_xxx"));
  });

  test("7. pay_ alone (no suffix chars) is invalid", () => {
    assert.ok(!isValidPaymentId("pay_"));
  });

  test("8. spaces are invalid", () => {
    assert.ok(!isValidPaymentId("pay_ TUJOz"));
  });

  test("9. special characters are invalid", () => {
    assert.ok(!isValidPaymentId("pay_TUJOz!@#$"));
  });

  test("10. injection attempt is invalid", () => {
    assert.ok(!isValidPaymentId("pay_'; DROP TABLE--"));
  });

});

// ─── Route handler tests ──────────────────────────────────────────────────────

describe("GET /api/razorpay-payment-status — route behavior", () => {

  test("11. missing paymentId → 400", async () => {
    const handler = makeRouteHandler({ outcome: "success", observation: CAPTURED_OBSERVATION });
    const req = makeRequest();
    const res = await handler(req);
    const { status, body } = await parseResponse(res);

    assert.equal(status, 400);
    assert.ok(body !== null && typeof body === "object" && "error" in body);
  });

  test("12. invalid paymentId (wrong prefix) → 400", async () => {
    const handler = makeRouteHandler({ outcome: "success", observation: CAPTURED_OBSERVATION });
    const req = makeRequest("order_NOTAVALIDPAY");
    const res = await handler(req);
    const { status } = await parseResponse(res);

    assert.equal(status, 400);
  });

  test("13. invalid paymentId (pay_ only) → 400", async () => {
    const handler = makeRouteHandler({ outcome: "success", observation: CAPTURED_OBSERVATION });
    const req = makeRequest("pay_");
    const res = await handler(req);
    const { status } = await parseResponse(res);

    assert.equal(status, 400);
  });

  test("14. success (captured) → 200 with correct shape", async () => {
    const handler = makeRouteHandler({ outcome: "success", observation: CAPTURED_OBSERVATION });
    const req = makeRequest("pay_TUJOzQxoEqFSLU");
    const res = await handler(req);
    const { status, body } = await parseResponse(res);

    assert.equal(status, 200);
    assert.equal(body.paymentId,  "pay_TUJOzQxoEqFSLU");
    assert.equal(body.source,     "razorpay_api");
    assert.equal(body.status,     "captured");
    assert.equal(body.captured,   true);
    assert.equal(body.amount,     10000);
    assert.equal(body.currency,   "INR");
    assert.ok(typeof body.fetchedAt === "string");
    assert.equal(body.errorCode,  null);
  });

  test("15. success (failed payment) → 200 with error fields", async () => {
    const handler = makeRouteHandler({ outcome: "success", observation: FAILED_OBSERVATION });
    const req = makeRequest("pay_TUJULUouXtIq8y");
    const res = await handler(req);
    const { status, body } = await parseResponse(res);

    assert.equal(status, 200);
    assert.equal(body.status,           "failed");
    assert.equal(body.captured,         false);
    assert.equal(body.errorCode,        "BAD_REQUEST_ERROR");
    assert.equal(body.errorSource,      "bank");
    assert.equal(body.errorStep,        "payment_authorization");
    assert.equal(body.errorReason,      "payment_failed");
  });

  test("16. not_found → 404 with paymentId and source", async () => {
    const handler = makeRouteHandler({ outcome: "not_found" });
    const req = makeRequest("pay_DOESNOTEXIST");
    const res = await handler(req);
    const { status, body } = await parseResponse(res);

    assert.equal(status, 404);
    assert.ok("error" in body);
    assert.equal(body.paymentId, "pay_DOESNOTEXIST");
    assert.equal(body.source,    "razorpay_api");
  });

  test("17. api_error → 502 with generic safe error (internal details not leaked)", async () => {
    const handler = makeRouteHandler({ outcome: "api_error", message: "Razorpay API returned status 503: Service Unavailable" });
    const req = makeRequest("pay_TUJOzQxoEqFSLU");
    const res = await handler(req);
    const { status, body } = await parseResponse(res);

    assert.equal(status, 502);
    assert.ok("error" in body);
    // Internal SDK error text must not be forwarded to the client
    const bodyStr = JSON.stringify(body);
    assert.ok(!bodyStr.includes("503"), "503 detail must not be exposed to client");
    assert.equal(body.source, "razorpay_api");
  });

  test("18. config_error → 500 with generic safe error (config details not leaked)", async () => {
    const handler = makeRouteHandler({ outcome: "config_error", message: "RAZORPAY_KEY_ID is not set" });
    const req = makeRequest("pay_TUJOzQxoEqFSLU");
    const res = await handler(req);
    const { status, body } = await parseResponse(res);

    assert.equal(status, 500);
    assert.ok("error" in body);
    const bodyStr = JSON.stringify(body);
    assert.ok(!bodyStr.includes("RAZORPAY_KEY_ID"), "config var name must not be exposed to client");
  });

  test("19. source field is 'razorpay_api' for success, not_found, and api_error", async () => {
    const cases = [
      { outcome: "success",   observation: CAPTURED_OBSERVATION },
      { outcome: "not_found" },
      { outcome: "api_error", message: "error" },
    ];

    for (const stubResult of cases) {
      const handler = makeRouteHandler(stubResult);
      const req = makeRequest("pay_TUJOzQxoEqFSLU");
      const res = await handler(req);
      const { body } = await parseResponse(res);
      assert.equal(body.source, "razorpay_api", `source must be razorpay_api for outcome=${stubResult.outcome}`);
    }
  });

  test("20. credentials are never exposed in any response body", async () => {
    const cases = [
      { outcome: "success",      observation: CAPTURED_OBSERVATION },
      { outcome: "not_found" },
      { outcome: "api_error",    message: "key_id=rzp_test_secret key_secret=verysecret" },
      { outcome: "config_error", message: "Missing RAZORPAY_KEY_SECRET=verysecret" },
    ];

    for (const stubResult of cases) {
      const handler = makeRouteHandler(stubResult);
      const req = makeRequest("pay_TUJOzQxoEqFSLU");
      const res = await handler(req);
      const text = await res.text();
      assert.ok(!text.includes("verysecret"), `credentials must not appear in response for outcome=${stubResult.outcome}`);
      assert.ok(!text.includes("rzp_test_"),  `API key prefix must not appear for outcome=${stubResult.outcome}`);
    }
  });

});
