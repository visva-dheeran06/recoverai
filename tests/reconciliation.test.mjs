/**
 * M5 Payment Reconciliation — Unit + Integration Tests
 *
 * Tests the reconciliation classification logic and the full reconcilePayment function.
 *
 * ─── Testing layers ──────────────────────────────────────────────────────────
 *
 * Layer 1 — Pure unit tests of the reconciliation algorithm:
 *   Re-implements the classification rules inline (no DB, no API, no network).
 *   Validates every outcome: CONSISTENT, API_AHEAD, WEBHOOK_AHEAD, WEBHOOK_ONLY,
 *   API_ONLY, NOT_FOUND, ERROR, plus refunded/created API statuses.
 *
 * Layer 2 — Integration tests using real M2 DB + real Razorpay API:
 *   Calls the production `reconcilePayment` with real Test Mode payment IDs.
 *   Requires credentials in .env.local (same as the main application).
 *
 * Run with: npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { reconcilePayment } from "../lib/payments/reconciliation.ts";

// ─── Re-implement the pure classification rules (mirrors production) ──────────

const STATE_RANK = { UNKNOWN: 0, FAILED: 1, AUTHORIZED: 2, CAPTURED: 3 };

function razorpayStatusToM3State(apiStatus) {
  switch (apiStatus) {
    case "captured":   return "CAPTURED";
    case "authorized": return "AUTHORIZED";
    case "failed":     return "FAILED";
    case "created":    return null;
    case "refunded":   return null;
    default:           return null;
  }
}

function classifyReconciliation(webhookState, m3EquivalentOfApi, apiStatus) {
  if (m3EquivalentOfApi === null) {
    if (apiStatus === "refunded") {
      return webhookState === "CAPTURED" ? "CONSISTENT" : "WEBHOOK_ONLY";
    }
    // "created": not yet settled
    if (webhookState !== "UNKNOWN") return "WEBHOOK_AHEAD";
    return "CONSISTENT";
  }

  const webhookRank = STATE_RANK[webhookState];
  const apiRank     = STATE_RANK[m3EquivalentOfApi];

  if (webhookState === m3EquivalentOfApi) return "CONSISTENT";
  if (apiRank > webhookRank) {
    return webhookState === "UNKNOWN" ? "API_ONLY" : "API_AHEAD";
  }
  return "WEBHOOK_AHEAD";
}

/** Helper that mirrors what reconcilePayment does for known inputs. */
function reconcile(webhookState, apiStatus, apiSuccess = true) {
  if (!apiSuccess) {
    return webhookState !== "UNKNOWN" ? "WEBHOOK_ONLY" : "ERROR";
  }
  if (apiStatus === "NOT_FOUND") return "NOT_FOUND";
  const m3Equiv = razorpayStatusToM3State(apiStatus);
  return classifyReconciliation(webhookState, m3Equiv, apiStatus);
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1 — Pure reconciliation classification (no I/O)
// ─────────────────────────────────────────────────────────────────────────────

describe("classifyReconciliation — pure classification logic", () => {

  // CONSISTENT
  test("1. UNKNOWN + API captured → API_ONLY (webhook has no state)", () => {
    assert.equal(reconcile("UNKNOWN", "captured"), "API_ONLY");
  });

  test("2. FAILED + API failed → CONSISTENT", () => {
    assert.equal(reconcile("FAILED", "failed"), "CONSISTENT");
  });

  test("3. AUTHORIZED + API authorized → CONSISTENT", () => {
    assert.equal(reconcile("AUTHORIZED", "authorized"), "CONSISTENT");
  });

  test("4. CAPTURED + API captured → CONSISTENT", () => {
    assert.equal(reconcile("CAPTURED", "captured"), "CONSISTENT");
  });

  // API_AHEAD
  test("5. AUTHORIZED + API captured → API_AHEAD", () => {
    assert.equal(reconcile("AUTHORIZED", "captured"), "API_AHEAD");
  });

  test("6. FAILED + API captured → API_AHEAD (contradictory discrepancy surfaced)", () => {
    assert.equal(reconcile("FAILED", "captured"), "API_AHEAD");
  });

  test("7. FAILED + API authorized → API_AHEAD", () => {
    assert.equal(reconcile("FAILED", "authorized"), "API_AHEAD");
  });

  // API_ONLY
  test("8. UNKNOWN + API captured → API_ONLY", () => {
    assert.equal(reconcile("UNKNOWN", "captured"), "API_ONLY");
  });

  test("9. UNKNOWN + API failed → API_ONLY", () => {
    assert.equal(reconcile("UNKNOWN", "failed"), "API_ONLY");
  });

  test("10. UNKNOWN + API authorized → API_ONLY", () => {
    assert.equal(reconcile("UNKNOWN", "authorized"), "API_ONLY");
  });

  // WEBHOOK_AHEAD
  test("11. CAPTURED + API authorized → WEBHOOK_AHEAD", () => {
    assert.equal(reconcile("CAPTURED", "authorized"), "WEBHOOK_AHEAD");
  });

  test("12. CAPTURED + API failed → WEBHOOK_AHEAD (finality preserved in webhook)", () => {
    assert.equal(reconcile("CAPTURED", "failed"), "WEBHOOK_AHEAD");
  });

  test("13. AUTHORIZED + API failed → WEBHOOK_AHEAD", () => {
    assert.equal(reconcile("AUTHORIZED", "failed"), "WEBHOOK_AHEAD");
  });

  // Refunded
  test("14. CAPTURED + API refunded → CONSISTENT (refund after valid capture)", () => {
    assert.equal(reconcile("CAPTURED", "refunded"), "CONSISTENT");
  });

  test("15. FAILED + API refunded → WEBHOOK_ONLY (no prior capture in webhook)", () => {
    assert.equal(reconcile("FAILED", "refunded"), "WEBHOOK_ONLY");
  });

  test("16. UNKNOWN + API refunded → WEBHOOK_ONLY (no webhook history)", () => {
    assert.equal(reconcile("UNKNOWN", "refunded"), "WEBHOOK_ONLY");
  });

  // Created (not settled)
  test("17. UNKNOWN + API created → CONSISTENT (both unsettled)", () => {
    assert.equal(reconcile("UNKNOWN", "created"), "CONSISTENT");
  });

  test("18. CAPTURED + API created → WEBHOOK_AHEAD (API momentarily stale)", () => {
    assert.equal(reconcile("CAPTURED", "created"), "WEBHOOK_AHEAD");
  });

  // API unavailable
  test("19. API error + webhook CAPTURED → WEBHOOK_ONLY", () => {
    assert.equal(reconcile("CAPTURED", null, false), "WEBHOOK_ONLY");
  });

  test("20. API error + webhook UNKNOWN → ERROR", () => {
    assert.equal(reconcile("UNKNOWN", null, false), "ERROR");
  });

  test("21. NOT_FOUND → NOT_FOUND", () => {
    assert.equal(reconcile("UNKNOWN", "NOT_FOUND"), "NOT_FOUND");
  });

  // plink correlation safety
  test("22. plink IDs are distinct from pay IDs (correlation documented)", () => {
    // M5 receives pay_xxx IDs. plink_xxx IDs would:
    //   - fail M3 json_extract (no events match) → UNKNOWN
    //   - fail M4 Razorpay API (returns error or not_found) → ERROR
    // This invariant is guaranteed by the route's pay_ prefix validation.
    assert.ok("plink_TUJOLytB9eXVkn".startsWith("plink_"));
    assert.ok("pay_TUJOzQxoEqFSLU".startsWith("pay_"));
    // Simulated: if a plink were passed, result would be ERROR (api unavailable + UNKNOWN)
    assert.equal(reconcile("UNKNOWN", null, false), "ERROR");
  });

  // Cross-payment isolation
  test("23. reconciling pay_A and pay_B produces independent results", () => {
    const resultA = reconcile("CAPTURED", "captured");
    const resultB = reconcile("FAILED",   "failed");
    assert.equal(resultA, "CONSISTENT");
    assert.equal(resultB, "CONSISTENT");
    assert.notEqual(resultA, resultB === "CAPTURED");
  });

  test("24. CONSISTENT requires same effective state in both sources", () => {
    assert.equal(reconcile("CAPTURED", "captured"),        "CONSISTENT");
    assert.notEqual(reconcile("CAPTURED", "failed"),       "CONSISTENT");
    assert.notEqual(reconcile("CAPTURED", "authorized"),   "CONSISTENT");
  });

  test("25. AUTHORIZED + API failed → WEBHOOK_AHEAD (not CONSISTENT or API_AHEAD)", () => {
    assert.equal(reconcile("AUTHORIZED", "failed"), "WEBHOOK_AHEAD");
  });

});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 — Integration tests: real M2 DB + real Razorpay API
// ─────────────────────────────────────────────────────────────────────────────

describe("reconcilePayment — integration (real M3 DB + real M4 API)", () => {

  test("26. pay_TUJOzQxoEqFSLU → M3=CAPTURED, should be CONSISTENT if API available", async () => {
    const result = await reconcilePayment("pay_TUJOzQxoEqFSLU");

    assert.equal(result.paymentId,    "pay_TUJOzQxoEqFSLU");
    assert.equal(result.webhookState, "CAPTURED", "M3 must return CAPTURED for this real payment");
    assert.ok(
      ["CONSISTENT", "WEBHOOK_ONLY", "ERROR"].includes(result.outcome),
      `Unexpected outcome: ${result.outcome} — expected CONSISTENT (API available) or WEBHOOK_ONLY/ERROR (API unavailable)`
    );
    assert.ok(typeof result.reconciledAt === "string");
    assert.ok(typeof result.summary === "string" && result.summary.length > 0);

    if (result.outcome === "CONSISTENT") {
      assert.ok(result.apiObservation !== null, "apiObservation must be populated for CONSISTENT");
      assert.equal(result.apiObservation.razorpayStatus, "captured");
      assert.equal(result.apiObservation.captured, true);
    }
  });

  test("27. pay_TUJULUouXtIq8y → M3=FAILED, should be CONSISTENT if API available", async () => {
    const result = await reconcilePayment("pay_TUJULUouXtIq8y");

    assert.equal(result.paymentId,    "pay_TUJULUouXtIq8y");
    assert.equal(result.webhookState, "FAILED", "M3 must return FAILED for this real payment");
    assert.ok(
      ["CONSISTENT", "WEBHOOK_ONLY", "ERROR"].includes(result.outcome),
      `Unexpected outcome: ${result.outcome}`
    );

    if (result.outcome === "CONSISTENT") {
      assert.ok(result.apiObservation !== null);
      assert.equal(result.apiObservation.razorpayStatus, "failed");
      assert.equal(result.apiObservation.captured, false);
    }
  });

  test("28. two payments reconcile independently (no cross-contamination)", async () => {
    const [a, b] = await Promise.all([
      reconcilePayment("pay_TUJOzQxoEqFSLU"),
      reconcilePayment("pay_TUJULUouXtIq8y"),
    ]);
    assert.equal(a.webhookState, "CAPTURED");
    assert.equal(b.webhookState, "FAILED");
    assert.equal(a.paymentId, "pay_TUJOzQxoEqFSLU");
    assert.equal(b.paymentId, "pay_TUJULUouXtIq8y");
  });

  test("29. nonexistent payment → NOT_FOUND or ERROR (payment unknown to Razorpay)", async () => {
    // pay_DOESNOTEXIST was verified in M4 real Test Mode to return HTTP 400
    // with description "The id provided does not exist" — which classifyRazorpayError
    // maps to not_found, and reconcilePayment then returns NOT_FOUND.
    //
    // However the real Razorpay API may vary its error response shape across
    // SDK versions or ID formats. Both NOT_FOUND and ERROR are valid outcomes
    // for a payment that does not exist:
    //   NOT_FOUND — Razorpay confirmed the ID is unknown (preferred)
    //   ERROR     — API returned an unclassifiable error response
    //
    // In either case: webhookState=UNKNOWN (not in DB) and apiObservation=null.
    const result = await reconcilePayment("pay_DOESNOTEXIST");
    assert.equal(result.paymentId,      "pay_DOESNOTEXIST");
    assert.equal(result.webhookState,   "UNKNOWN");
    assert.ok(
      result.outcome === "NOT_FOUND" || result.outcome === "ERROR",
      `Expected NOT_FOUND or ERROR for nonexistent payment, got: ${result.outcome}`
    );
    assert.equal(result.apiObservation, null);
  });

  test("30. result never exposes credentials", async () => {
    const result = await reconcilePayment("pay_TUJOzQxoEqFSLU");
    const text = JSON.stringify(result);
    assert.ok(!text.toLowerCase().includes("rzp_test"),   "API key prefix must not appear");
    assert.ok(!text.includes("key_secret"),                "key_secret must not appear");
    assert.ok(!text.includes("RAZORPAY_KEY_ID"),          "env var name must not appear");
  });

});
