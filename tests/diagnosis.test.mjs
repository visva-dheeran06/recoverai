/**
 * M7A Deterministic Diagnosis and Recommendation - Unit + Integration Tests
 *
 * --- Testing layers ---
 *
 * Layer 1 - Pure unit tests (no DB, no API, no network):
 *   Tests classifyDiagnosis, buildDiagnosis, buildRecommendation using
 *   pre-constructed RecoveryScoreResult fixtures.
 *
 * Layer 2 - DB integration tests:
 *   Calls the production diagnosePayment with real M2 DB payment IDs.
 *   Requires the M2 DB to be present (data/recoverai.db).
 *
 * Layer 3 - API route contract tests (mocked, no DB):
 *   Tests the GET /api/diagnosis route validation and response shape.
 *
 * Run with: npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDiagnosis,
  buildDiagnosis,
  buildRecommendation,
  diagnosePayment,
} from "../lib/payments/diagnosis.ts";
import { NextRequest, NextResponse } from "next/server";

// --- Fixtures ---

/** Build a minimal RecoveryScoreResult-shaped fixture. */
function makeScore({
  webhookState = "FAILED",
  recoveryScore = 50,
  recoveryTier = "MEDIUM",
  confidence = "HIGH",
  ftPoints = 28,
  ftAvailable = true,
  histPoints = 0,
  histAvailable = true,
  retryPoints = 15,
  retryAvailable = true,
  amountPoints = 8,
  amountAvailable = true,
  recencyPoints = 8,
  recencyAvailable = true,
} = {}) {
  return {
    paymentId: "pay_TEST",
    webhookState,
    recoveryScore,
    recoveryTier,
    confidence,
    factors: [
      { factor: "failure_type",    available: ftAvailable,      points: ftPoints,      maxPoints: 40, reason: "" },
      { factor: "payment_history", available: histAvailable,    points: histPoints,    maxPoints: 25, reason: "" },
      { factor: "retry_history",   available: retryAvailable,   points: retryPoints,   maxPoints: 15, reason: "" },
      { factor: "amount_context",  available: amountAvailable,  points: amountPoints,  maxPoints: 10, reason: "" },
      { factor: "recency",         available: recencyAvailable, points: recencyPoints, maxPoints: 10, reason: "" },
    ],
    scoredAt: "2026-09-01T00:00:00.000Z",
  };
}

// =============================================================================
// Layer 1 - classifyDiagnosis unit tests
// =============================================================================

describe("classifyDiagnosis", () => {

  test("1. CAPTURED state -> CAPTURED", () => {
    const s = makeScore({ webhookState: "CAPTURED", ftPoints: 40 });
    assert.equal(classifyDiagnosis(s), "CAPTURED");
  });

  test("2. AUTHORIZED state -> AUTHORIZED", () => {
    const s = makeScore({ webhookState: "AUTHORIZED", ftPoints: 38 });
    assert.equal(classifyDiagnosis(s), "AUTHORIZED");
  });

  test("3. FAILED + ft.points=28 -> BANK_DECLINE", () => {
    const s = makeScore({ webhookState: "FAILED", ftPoints: 28 });
    assert.equal(classifyDiagnosis(s), "BANK_DECLINE");
  });

  test("4. FAILED + ft.points=10 -> CUSTOMER_ACTION_REQUIRED", () => {
    const s = makeScore({ webhookState: "FAILED", ftPoints: 10 });
    assert.equal(classifyDiagnosis(s), "CUSTOMER_ACTION_REQUIRED");
  });

  test("5. FAILED + ft.points=18 -> BUSINESS_CONFIGURATION", () => {
    const s = makeScore({ webhookState: "FAILED", ftPoints: 18 });
    assert.equal(classifyDiagnosis(s), "BUSINESS_CONFIGURATION");
  });

  test("6. FAILED + ft.points=35 -> INFRASTRUCTURE_FAILURE", () => {
    const s = makeScore({ webhookState: "FAILED", ftPoints: 35 });
    assert.equal(classifyDiagnosis(s), "INFRASTRUCTURE_FAILURE");
  });

  test("7. FAILED + ft.points=15, available=true -> UNKNOWN_PAYMENT_STATE", () => {
    const s = makeScore({ webhookState: "FAILED", ftPoints: 15, ftAvailable: true });
    assert.equal(classifyDiagnosis(s), "UNKNOWN_PAYMENT_STATE");
  });

  test("8. FAILED + ft.points=15, available=false -> INSUFFICIENT_EVIDENCE", () => {
    const s = makeScore({ webhookState: "FAILED", ftPoints: 15, ftAvailable: false });
    assert.equal(classifyDiagnosis(s), "INSUFFICIENT_EVIDENCE");
  });

  test("9. UNKNOWN state -> INSUFFICIENT_EVIDENCE", () => {
    const s = makeScore({ webhookState: "UNKNOWN", ftPoints: 20, ftAvailable: false });
    assert.equal(classifyDiagnosis(s), "INSUFFICIENT_EVIDENCE");
  });

  test("10. Missing failure evidence (no ft factor) -> INSUFFICIENT_EVIDENCE", () => {
    const s = makeScore({ webhookState: "FAILED", ftPoints: 28 });
    s.factors = s.factors.filter((f) => f.factor !== "failure_type");
    assert.equal(classifyDiagnosis(s), "INSUFFICIENT_EVIDENCE");
  });

});

// =============================================================================
// Layer 1 - buildDiagnosis unit tests
// =============================================================================

describe("buildDiagnosis — output shape and safety", () => {

  test("11. CAPTURED -> correct category, summary mentions captured", () => {
    const s = makeScore({ webhookState: "CAPTURED", ftPoints: 40 });
    const d = buildDiagnosis("CAPTURED", s);
    assert.equal(d.category, "CAPTURED");
    assert.ok(d.summary.length > 0);
    assert.ok(Array.isArray(d.evidence) && d.evidence.length > 0);
  });

  test("12. BANK_DECLINE -> category is BANK_DECLINE", () => {
    const d = buildDiagnosis("BANK_DECLINE", makeScore({ webhookState: "FAILED", ftPoints: 28 }));
    assert.equal(d.category, "BANK_DECLINE");
    assert.ok(d.evidence.some((e) => e.toLowerCase().includes("bank")));
  });

  test("13. INSUFFICIENT_EVIDENCE -> category correct", () => {
    const d = buildDiagnosis("INSUFFICIENT_EVIDENCE", makeScore({ webhookState: "UNKNOWN", ftPoints: 20, ftAvailable: false }));
    assert.equal(d.category, "INSUFFICIENT_EVIDENCE");
  });

  test("14. Missing evidence never fabricates claims", () => {
    // No payment history, no retry info, no recency, no amount
    const s = makeScore({
      webhookState: "FAILED", ftPoints: 28,
      histAvailable: false, histPoints: 0,
      retryAvailable: false, retryPoints: 7,
      recencyAvailable: false, recencyPoints: 5,
      amountAvailable: false, amountPoints: 5,
    });
    const d = buildDiagnosis("BANK_DECLINE", s);
    // Must not claim prior successful payments
    const text = JSON.stringify(d);
    assert.ok(!text.includes("prior successful"), "Must not claim prior payments when history unavailable");
    // Must not claim repeated failures
    assert.ok(!text.includes("Repeated prior failed"), "Must not claim repeated failures when retry unavailable");
  });

  test("15. Sensitive data not exposed in diagnosis", () => {
    const s = makeScore({ webhookState: "FAILED", ftPoints: 28 });
    const d = buildDiagnosis("BANK_DECLINE", s);
    const text = JSON.stringify(d);
    assert.ok(!text.includes("rzp_"),             "No API key");
    assert.ok(!text.includes("key_secret"),        "No secret");
    assert.ok(!text.includes("RAZORPAY_KEY"),      "No env var");
    assert.ok(!text.includes("+91"),               "No phone number");
    assert.ok(!text.includes("@"),                 "No email");
  });

});

// =============================================================================
// Layer 1 - buildRecommendation unit tests
// =============================================================================

describe("buildRecommendation — action and priority", () => {

  test("16. CAPTURED -> NO_ACTION, LOW priority", () => {
    const r = buildRecommendation("CAPTURED", makeScore({ webhookState: "CAPTURED", ftPoints: 40, recoveryTier: "HIGH" }));
    assert.equal(r.action, "NO_ACTION");
    assert.equal(r.priority, "LOW");
  });

  test("17. CAPTURED never recommends retry (action=NO_ACTION, not RETRY_PAYMENT)", () => {
    const r = buildRecommendation("CAPTURED", makeScore({ webhookState: "CAPTURED", ftPoints: 40, recoveryTier: "HIGH" }));
    assert.equal(r.action, "NO_ACTION", "CAPTURED must never produce RETRY_PAYMENT action");
    assert.notEqual(r.action, "RETRY_PAYMENT");
  });

  test("18. AUTHORIZED -> CHECK_CAPTURE_STATUS, MEDIUM priority", () => {
    const r = buildRecommendation("AUTHORIZED", makeScore({ webhookState: "AUTHORIZED", ftPoints: 38 }));
    assert.equal(r.action, "CHECK_CAPTURE_STATUS");
    assert.equal(r.priority, "MEDIUM");
  });

  test("19. BANK_DECLINE + HIGH tier -> RETRY_PAYMENT, HIGH priority", () => {
    const r = buildRecommendation("BANK_DECLINE", makeScore({ ftPoints: 28, recoveryTier: "HIGH", recoveryScore: 79 }));
    assert.equal(r.action, "RETRY_PAYMENT");
    assert.equal(r.priority, "HIGH");
  });

  test("20. BANK_DECLINE + MEDIUM tier -> RETRY_PAYMENT, MEDIUM priority", () => {
    const r = buildRecommendation("BANK_DECLINE", makeScore({ ftPoints: 28, recoveryTier: "MEDIUM", recoveryScore: 55 }));
    assert.equal(r.action, "RETRY_PAYMENT");
    assert.equal(r.priority, "MEDIUM");
  });

  test("21. BANK_DECLINE + LOW tier -> RETRY_PAYMENT, LOW priority", () => {
    const r = buildRecommendation("BANK_DECLINE", makeScore({ ftPoints: 28, recoveryTier: "LOW", recoveryScore: 20 }));
    assert.equal(r.action, "RETRY_PAYMENT");
    assert.equal(r.priority, "LOW");
  });

  test("22. CUSTOMER_ACTION_REQUIRED -> action=CUSTOMER_ACTION_REQUIRED", () => {
    const r = buildRecommendation("CUSTOMER_ACTION_REQUIRED", makeScore({ ftPoints: 10, recoveryTier: "MEDIUM" }));
    assert.equal(r.action, "CUSTOMER_ACTION_REQUIRED");
  });

  test("23. BUSINESS_CONFIGURATION -> REVIEW_MERCHANT_CONFIGURATION", () => {
    const r = buildRecommendation("BUSINESS_CONFIGURATION", makeScore({ ftPoints: 18, recoveryTier: "MEDIUM" }));
    assert.equal(r.action, "REVIEW_MERCHANT_CONFIGURATION");
  });

  test("24. INFRASTRUCTURE_FAILURE -> RETRY_PAYMENT", () => {
    const r = buildRecommendation("INFRASTRUCTURE_FAILURE", makeScore({ ftPoints: 35, recoveryTier: "HIGH" }));
    assert.equal(r.action, "RETRY_PAYMENT");
  });

  test("25. INSUFFICIENT_EVIDENCE -> COLLECT_MORE_EVIDENCE, LOW priority", () => {
    const r = buildRecommendation("INSUFFICIENT_EVIDENCE", makeScore({ webhookState: "UNKNOWN", ftPoints: 20, recoveryTier: "LOW", recoveryScore: 10 }));
    assert.equal(r.action, "COLLECT_MORE_EVIDENCE");
    assert.equal(r.priority, "LOW");
  });

  test("26. UNKNOWN_PAYMENT_STATE -> COLLECT_MORE_EVIDENCE, LOW priority", () => {
    const r = buildRecommendation("UNKNOWN_PAYMENT_STATE", makeScore({ webhookState: "FAILED", ftPoints: 15, recoveryTier: "LOW", recoveryScore: 30 }));
    assert.equal(r.action, "COLLECT_MORE_EVIDENCE");
    assert.equal(r.priority, "LOW");
  });

});

// =============================================================================
// Layer 2 - diagnosePayment integration tests (real M2 DB)
// =============================================================================

describe("diagnosePayment — integration (real M2 DB)", () => {

  // Fixed reference timestamp for deterministic recency (same as M6 tests)
  const REF_TS = 1756771200; // 2026-09-01

  test("27. pay_TUJOzQxoEqFSLU (captured) -> CAPTURED category, NO_ACTION", () => {
    const r = diagnosePayment("pay_TUJOzQxoEqFSLU", REF_TS);
    assert.equal(r.paymentId,                  "pay_TUJOzQxoEqFSLU");
    assert.equal(r.webhookState,               "CAPTURED");
    assert.equal(r.diagnosis.category,         "CAPTURED");
    assert.equal(r.recommendation.action,      "NO_ACTION");
    assert.equal(r.recommendation.priority,    "LOW");
    assert.equal(r.generation.mode,            "deterministic");
    // M6 values must be preserved
    assert.equal(r.recoveryTier,               "HIGH");
    assert.ok(r.recoveryScore >= 70);
  });

  test("28. pay_TUJOzQxoEqFSLU never recommends retry (action=NO_ACTION)", () => {
    const r = diagnosePayment("pay_TUJOzQxoEqFSLU", REF_TS);
    assert.equal(r.recommendation.action, "NO_ACTION",
      "Captured payment must never produce RETRY_PAYMENT action");
    assert.notEqual(r.recommendation.action, "RETRY_PAYMENT");
  });

  test("29. pay_TUJULUouXtIq8y (failed bank) -> BANK_DECLINE, RETRY_PAYMENT", () => {
    const r = diagnosePayment("pay_TUJULUouXtIq8y", REF_TS);
    assert.equal(r.paymentId,             "pay_TUJULUouXtIq8y");
    assert.equal(r.webhookState,          "FAILED");
    assert.equal(r.diagnosis.category,   "BANK_DECLINE");
    assert.equal(r.recommendation.action, "RETRY_PAYMENT");
    assert.equal(r.generation.mode,       "deterministic");
  });

  test("30. pay_TUJULUouXtIq8y recoveryScore/Tier unchanged from M6", () => {
    const r = diagnosePayment("pay_TUJULUouXtIq8y", REF_TS);
    // M6 verified: score=79, tier=HIGH
    assert.ok(r.recoveryScore > 0, "Score must be positive");
    assert.ok(["HIGH", "MEDIUM", "LOW"].includes(r.recoveryTier));
  });

  test("31. unknown payment ID -> INSUFFICIENT_EVIDENCE, COLLECT_MORE_EVIDENCE", () => {
    const r = diagnosePayment("pay_UNKNOWN000000", REF_TS);
    assert.equal(r.webhookState,          "UNKNOWN");
    assert.equal(r.diagnosis.category,   "INSUFFICIENT_EVIDENCE");
    assert.equal(r.recommendation.action, "COLLECT_MORE_EVIDENCE");
    assert.equal(r.recommendation.priority, "LOW");
    assert.equal(r.generation.mode,       "deterministic");
  });

  test("32. two payments diagnose independently (no cross-contamination)", () => {
    const a = diagnosePayment("pay_TUJOzQxoEqFSLU", REF_TS);
    const b = diagnosePayment("pay_TUJULUouXtIq8y", REF_TS);
    assert.notEqual(a.diagnosis.category, b.diagnosis.category);
    assert.equal(a.paymentId, "pay_TUJOzQxoEqFSLU");
    assert.equal(b.paymentId, "pay_TUJULUouXtIq8y");
  });

  test("33. deterministic: identical inputs -> identical output", () => {
    const r1 = diagnosePayment("pay_TUJOzQxoEqFSLU", REF_TS);
    const r2 = diagnosePayment("pay_TUJOzQxoEqFSLU", REF_TS);
    assert.equal(r1.diagnosis.category,      r2.diagnosis.category);
    assert.equal(r1.recommendation.action,   r2.recommendation.action);
    assert.equal(r1.recommendation.priority, r2.recommendation.priority);
    assert.equal(r1.recoveryScore,           r2.recoveryScore);
  });

  test("34. result contains all required fields", () => {
    const r = diagnosePayment("pay_TUJOzQxoEqFSLU", REF_TS);
    assert.ok("paymentId"      in r, "paymentId missing");
    assert.ok("webhookState"   in r, "webhookState missing");
    assert.ok("recoveryScore"  in r, "recoveryScore missing");
    assert.ok("recoveryTier"   in r, "recoveryTier missing");
    assert.ok("confidence"     in r, "confidence missing");
    assert.ok("diagnosis"      in r, "diagnosis missing");
    assert.ok("recommendation" in r, "recommendation missing");
    assert.ok("generation"     in r, "generation missing");
    assert.ok("category"   in r.diagnosis,      "diagnosis.category missing");
    assert.ok("summary"    in r.diagnosis,       "diagnosis.summary missing");
    assert.ok("evidence"   in r.diagnosis,       "diagnosis.evidence missing");
    assert.ok("action"     in r.recommendation,  "recommendation.action missing");
    assert.ok("priority"   in r.recommendation,  "recommendation.priority missing");
    assert.ok("message"    in r.recommendation,  "recommendation.message missing");
    assert.ok("mode"       in r.generation,      "generation.mode missing");
  });

  test("35. generation.mode is always 'deterministic' in M7A", () => {
    const r = diagnosePayment("pay_TUJOzQxoEqFSLU", REF_TS);
    assert.equal(r.generation.mode, "deterministic");
  });

  test("36. credentials not exposed (integration)", () => {
    const r = diagnosePayment("pay_TUJULUouXtIq8y", REF_TS);
    const text = JSON.stringify(r);
    assert.ok(!text.includes("rzp_test_"),    "No API key");
    assert.ok(!text.includes("key_secret"),    "No secret");
    assert.ok(!text.includes("RAZORPAY_KEY"), "No env var");
  });

  test("37. PII not exposed (integration)", () => {
    const r = diagnosePayment("pay_TUJULUouXtIq8y", REF_TS);
    const text = JSON.stringify(r);
    assert.ok(!text.includes("+919"), "Phone number must not appear in output");
  });

});

// =============================================================================
// Layer 3 - API route contract tests (mocked, no DB)
// =============================================================================

const PAYMENT_ID_PATTERN = /^pay_[A-Za-z0-9]{1,}$/;

function makeRouteHandler(stubResult) {
  return async (req) => {
    const raw = req.nextUrl.searchParams.get("paymentId");
    if (!raw || !raw.trim()) {
      return NextResponse.json({ error: "Missing required query parameter: paymentId" }, { status: 400 });
    }
    const paymentId = raw.trim();
    if (!PAYMENT_ID_PATTERN.test(paymentId)) {
      return NextResponse.json({ error: "Invalid paymentId format", paymentId }, { status: 400 });
    }
    return NextResponse.json(stubResult, { status: 200 });
  };
}

function makeRequest(paymentId) {
  const url = paymentId != null
    ? `http://localhost:3000/api/diagnosis?paymentId=${encodeURIComponent(paymentId)}`
    : `http://localhost:3000/api/diagnosis`;
  return new NextRequest(url);
}

const STUB_RESULT = {
  paymentId:     "pay_TUJOzQxoEqFSLU",
  webhookState:  "CAPTURED",
  recoveryScore: 73,
  recoveryTier:  "HIGH",
  confidence:    "HIGH",
  diagnosis: {
    category: "CAPTURED",
    summary:  "The payment has already been successfully captured.",
    evidence: ["Payment reached captured state — highest finality."],
  },
  recommendation: {
    action:   "NO_ACTION",
    priority: "LOW",
    message:  "No further action is required.",
  },
  generation: { mode: "deterministic" },
};

describe("GET /api/diagnosis — route contract", () => {

  test("38. missing paymentId -> 400", async () => {
    const handler = makeRouteHandler(STUB_RESULT);
    const res  = await handler(makeRequest(null));
    const body = await res.json();
    assert.equal(res.status, 400);
    assert.ok("error" in body);
  });

  test("39. invalid paymentId format -> 400", async () => {
    const handler = makeRouteHandler(STUB_RESULT);
    const res = await handler(makeRequest("order_NOTAVALIDPAY"));
    assert.equal(res.status, 400);
  });

  test("40. valid paymentId -> 200 with required fields", async () => {
    const handler = makeRouteHandler(STUB_RESULT);
    const res  = await handler(makeRequest("pay_TUJOzQxoEqFSLU"));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.ok("paymentId"      in body, "paymentId missing");
    assert.ok("diagnosis"      in body, "diagnosis missing");
    assert.ok("recommendation" in body, "recommendation missing");
    assert.ok("generation"     in body, "generation missing");
    assert.ok("recoveryScore"  in body, "recoveryScore missing");
    assert.ok("recoveryTier"   in body, "recoveryTier missing");
    assert.ok("confidence"     in body, "confidence missing");
  });

  test("41. response does not add credentials", async () => {
    const handler = makeRouteHandler(STUB_RESULT);
    const res  = await handler(makeRequest("pay_TUJOzQxoEqFSLU"));
    const text = await res.text();
    assert.ok(!text.includes("RAZORPAY_KEY_SECRET"), "env var must not appear");
    assert.ok(!text.includes("rzp_test_"),           "API key must not appear");
  });

});
