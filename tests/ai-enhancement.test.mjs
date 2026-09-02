/**
 * M7B AI Enhancement — Unit Tests
 *
 * All tests are fully deterministic. The real Gemini API is NEVER called.
 * The AI client is mocked by controlling the GEMINI_API_KEY environment
 * variable and by injecting a mock module via the module's exported interface.
 *
 * We test the enhanceWithAi() function directly by calling it with
 * a well-formed DiagnosisResult and mocking the underlying Gemini import.
 *
 * Since @google/genai is dynamically imported inside callGemini(), we use
 * environment-variable-driven paths and mock the Google GenAI constructor
 * via a small inline approach: we monkey-patch process.env.GEMINI_API_KEY
 * and provide a module mock via a test helper.
 *
 * Testing strategy:
 *   - For "no key" path: unset GEMINI_API_KEY → enhanceWithAi returns unchanged result.
 *   - For "AI success/failure" paths: we directly test the public surface
 *     by calling enhanceWithAi with a wrapped version that uses a provided
 *     mock generateContent function, exposed via the testOnly exports.
 *
 * Run: npm test
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// We import the module under test (ai-enhancement) and use its testOnly exports
// for injection of mock Gemini behaviour.
import {
  enhanceWithAiUsingMockClient,
} from "../lib/payments/ai-enhancement.ts";



// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** A realistic DiagnosisResult representing a BANK_DECLINE. */
const BANK_DECLINE_RESULT = {
  paymentId: "pay_TUJULUouXtIq8y",
  webhookState: "FAILED",
  recoveryScore: 79,
  recoveryTier: "HIGH",
  confidence: "HIGH",
  diagnosis: {
    category: "BANK_DECLINE",
    summary: "The payment was declined by the customer's bank.",
    evidence: [
      "Bank decline detected as the failure source.",
      "Prior successful payment history exists for this contact.",
    ],
  },
  recommendation: {
    action: "RETRY_PAYMENT",
    priority: "HIGH",
    message: "Ask the customer to retry the payment.",
  },
  generation: { mode: "deterministic" },
};

/** A realistic DiagnosisResult representing a captured payment. */
const CAPTURED_RESULT = {
  paymentId: "pay_TUJOzQxoEqFSLU",
  webhookState: "CAPTURED",
  recoveryScore: 73,
  recoveryTier: "HIGH",
  confidence: "HIGH",
  diagnosis: {
    category: "CAPTURED",
    summary: "The payment has already been successfully captured.",
    evidence: ["Payment reached captured state — highest finality."],
  },
  recommendation: {
    action: "NO_ACTION",
    priority: "LOW",
    message: "No further action is required.",
  },
  generation: { mode: "deterministic" },
};

/** A valid AI response JSON string. */
const VALID_AI_JSON = JSON.stringify({
  summary: "Your customer's bank declined this payment — likely a temporary issue with their account or card limit.",
  evidence: [
    "Bank decline detected as the failure source.",
    "Customer has previously completed payments successfully.",
  ],
  message: "Send a payment retry link to your customer and suggest trying a different payment method if the decline persists.",
});

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("enhanceWithAi — M7B", () => {

  // ── 1. AI success path ─────────────────────────────────────────────────────

  test("1. AI success: generation.mode = 'ai'", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.generation.mode, "ai");
  });

  test("2. AI success: AI summary is used", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    const parsed = JSON.parse(VALID_AI_JSON);
    assert.equal(result.diagnosis.summary, parsed.summary);
  });

  test("3. AI success: AI evidence is used", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    const parsed = JSON.parse(VALID_AI_JSON);
    assert.deepEqual(result.diagnosis.evidence, parsed.evidence);
  });

  test("4. AI success: AI message is used", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    const parsed = JSON.parse(VALID_AI_JSON);
    assert.equal(result.recommendation.message, parsed.message);
  });

  // ── 2. Authoritative fields must never change ──────────────────────────────

  test("5. AI success: paymentId is unchanged", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.paymentId, BANK_DECLINE_RESULT.paymentId);
  });

  test("6. AI success: webhookState is unchanged", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.webhookState, BANK_DECLINE_RESULT.webhookState);
  });

  test("7. AI success: recoveryScore is unchanged", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.recoveryScore, BANK_DECLINE_RESULT.recoveryScore);
  });

  test("8. AI success: recoveryTier is unchanged", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.recoveryTier, BANK_DECLINE_RESULT.recoveryTier);
  });

  test("9. AI success: confidence is unchanged", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.confidence, BANK_DECLINE_RESULT.confidence);
  });

  test("10. AI success: diagnosis.category is unchanged", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.diagnosis.category, BANK_DECLINE_RESULT.diagnosis.category);
  });

  test("11. AI success: recommendation.action is unchanged", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.recommendation.action, BANK_DECLINE_RESULT.recommendation.action);
  });

  test("12. AI success: recommendation.priority is unchanged", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    assert.equal(result.recommendation.priority, BANK_DECLINE_RESULT.recommendation.priority);
  });

  // ── 3. Fallback scenarios ──────────────────────────────────────────────────

  test("13. AI returns null (provider failure) → deterministic fallback", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => null
    );
    assert.equal(result.generation.mode, "deterministic");
    assert.equal(result.diagnosis.summary, BANK_DECLINE_RESULT.diagnosis.summary);
  });

  test("14. AI throws (network failure) → deterministic fallback", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => { throw new Error("Network failure"); }
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("15. AI returns invalid JSON → deterministic fallback", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => "this is not JSON at all :-)"
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("16. AI returns empty string → deterministic fallback", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => ""
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("17. AI returns JSON missing 'summary' → deterministic fallback", async () => {
    const bad = JSON.stringify({ evidence: ["ok"], message: "ok" });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("18. AI returns JSON missing 'evidence' → deterministic fallback", async () => {
    const bad = JSON.stringify({ summary: "ok", message: "ok" });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("19. AI returns JSON missing 'message' → deterministic fallback", async () => {
    const bad = JSON.stringify({ summary: "ok", evidence: ["ok"] });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("20. AI returns empty evidence array → deterministic fallback", async () => {
    const bad = JSON.stringify({ summary: "ok", evidence: [], message: "ok" });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("21. AI returns non-string evidence item → deterministic fallback", async () => {
    const bad = JSON.stringify({ summary: "ok", evidence: [42, "ok"], message: "ok" });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("22. AI returns prohibited key 'category' → deterministic fallback", async () => {
    const bad = JSON.stringify({
      summary: "ok", evidence: ["ok"], message: "ok",
      category: "SOME_OTHER_CATEGORY"
    });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("23. AI returns prohibited key 'recoveryScore' → deterministic fallback", async () => {
    const bad = JSON.stringify({
      summary: "ok", evidence: ["ok"], message: "ok",
      recoveryScore: 0
    });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("24. AI returns credential pattern in summary → deterministic fallback", async () => {
    const bad = JSON.stringify({
      summary: "Your key rzp_test_XXXXXXXX is exposed",
      evidence: ["ok"],
      message: "ok"
    });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("25. AI returns phone-number-like pattern in evidence → deterministic fallback", async () => {
    const bad = JSON.stringify({
      summary: "ok",
      evidence: ["Contact +919080279704 was found"],
      message: "ok"
    });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("26. AI returns GEMINI_API_KEY in message → deterministic fallback", async () => {
    const bad = JSON.stringify({
      summary: "ok",
      evidence: ["ok"],
      message: "Check GEMINI_API_KEY for details"
    });
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => bad
    );
    assert.equal(result.generation.mode, "deterministic");
  });

  test("27. AI wraps JSON in markdown fences → accepted if valid after stripping", async () => {
    const fenced = "```json\n" + VALID_AI_JSON + "\n```";
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => fenced
    );
    assert.equal(result.generation.mode, "ai");
  });

  // ── 4. No API key path ─────────────────────────────────────────────────────

  test("28. No API key: enhanceWithAi returns deterministic result unchanged", async () => {
    // Import the real enhanceWithAi (no mock client) and ensure no key is set
    const { enhanceWithAi } = await import("../lib/payments/ai-enhancement.ts");
    const savedKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const result = await enhanceWithAi(BANK_DECLINE_RESULT);
      assert.equal(result.generation.mode, "deterministic");
      assert.equal(result.diagnosis.summary, BANK_DECLINE_RESULT.diagnosis.summary);
      assert.deepEqual(result.diagnosis.evidence, BANK_DECLINE_RESULT.diagnosis.evidence);
      assert.equal(result.recommendation.message, BANK_DECLINE_RESULT.recommendation.message);
    } finally {
      if (savedKey !== undefined) process.env.GEMINI_API_KEY = savedKey;
    }
  });

  // ── 5. PII / security in prompt ───────────────────────────────────────────

  test("29. Prompt does not include paymentId's raw contact/email fields", async () => {
    // We verify that the prompt builder only uses DiagnosisResult fields,
    // not raw DB/webhook content. This is a structural test — the prompt
    // must not include phone numbers or email addresses.
    //
    // We do this by capturing what is sent to the mock client.
    let capturedText = null;

    const sensitiveResult = {
      ...BANK_DECLINE_RESULT,
      // The DiagnosisResult itself does not contain PII — that's enforced by M7A.
      // We verify the mock client receives only the authoritative fields, not
      // raw numbers like phone/email from the DB layer.
    };

    await enhanceWithAiUsingMockClient(
      sensitiveResult,
      async (text) => {
        capturedText = text;
        return VALID_AI_JSON;
      }
    );

    // The text sent to the AI must not contain phone-like patterns
    assert.ok(capturedText !== null, "mock client should have been called");
    const text = capturedText;
    assert.ok(
      !/\+91\d{10}/.test(text),
      "AI prompt must not contain phone numbers"
    );
    assert.ok(
      !/void@razorpay\.com/.test(text),
      "AI prompt must not contain email addresses"
    );
    assert.ok(
      !/RAZORPAY_KEY/i.test(text),
      "AI prompt must not contain credential env var names"
    );
  });

  // ── 6. Fallback preserves full original result ─────────────────────────────

  test("30. Fallback preserves ALL original DiagnosisResult fields exactly", async () => {
    const result = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => null
    );
    // All authoritative fields
    assert.equal(result.paymentId,              BANK_DECLINE_RESULT.paymentId);
    assert.equal(result.webhookState,           BANK_DECLINE_RESULT.webhookState);
    assert.equal(result.recoveryScore,          BANK_DECLINE_RESULT.recoveryScore);
    assert.equal(result.recoveryTier,           BANK_DECLINE_RESULT.recoveryTier);
    assert.equal(result.confidence,             BANK_DECLINE_RESULT.confidence);
    assert.equal(result.diagnosis.category,     BANK_DECLINE_RESULT.diagnosis.category);
    assert.equal(result.diagnosis.summary,      BANK_DECLINE_RESULT.diagnosis.summary);
    assert.deepEqual(result.diagnosis.evidence, BANK_DECLINE_RESULT.diagnosis.evidence);
    assert.equal(result.recommendation.action,  BANK_DECLINE_RESULT.recommendation.action);
    assert.equal(result.recommendation.priority,BANK_DECLINE_RESULT.recommendation.priority);
    assert.equal(result.recommendation.message, BANK_DECLINE_RESULT.recommendation.message);
    assert.equal(result.generation.mode,        "deterministic");
  });

  test("31. Different payments are enhanced independently (no contamination)", async () => {
    const r1 = await enhanceWithAiUsingMockClient(
      BANK_DECLINE_RESULT,
      async () => VALID_AI_JSON
    );
    const r2 = await enhanceWithAiUsingMockClient(
      CAPTURED_RESULT,
      async () => null  // Captured → deterministic fallback
    );
    assert.equal(r1.paymentId, "pay_TUJULUouXtIq8y");
    assert.equal(r2.paymentId, "pay_TUJOzQxoEqFSLU");
    assert.equal(r1.generation.mode, "ai");
    assert.equal(r2.generation.mode, "deterministic");
  });

  // ── 7. Existing M7A behavior still works ──────────────────────────────────

  test("32. diagnosePayment deterministic output still works (M7A regression)", async () => {
    const { diagnosePayment } = await import("../lib/payments/diagnosis.ts");

    const r1 = diagnosePayment("pay_TUJOzQxoEqFSLU");
    assert.equal(r1.webhookState,        "CAPTURED");
    assert.equal(r1.diagnosis.category,  "CAPTURED");
    assert.equal(r1.recommendation.action, "NO_ACTION");
    assert.equal(r1.generation.mode,     "deterministic");

    const r2 = diagnosePayment("pay_TUJULUouXtIq8y");
    assert.equal(r2.webhookState,        "FAILED");
    assert.equal(r2.diagnosis.category,  "BANK_DECLINE");
    assert.equal(r2.recommendation.action, "RETRY_PAYMENT");
    assert.equal(r2.generation.mode,     "deterministic");

    const r3 = diagnosePayment("pay_UNKNOWN000000");
    assert.equal(r3.webhookState,        "UNKNOWN");
    assert.equal(r3.diagnosis.category,  "INSUFFICIENT_EVIDENCE");
    assert.equal(r3.recommendation.action, "COLLECT_MORE_EVIDENCE");
    assert.equal(r3.generation.mode,     "deterministic");
  });

});
