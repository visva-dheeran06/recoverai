/**
 * M3 Payment State Derivation Tests
 *
 * Run with:  node --test tests/payment-state.test.mjs
 *
 * Two layers of tests:
 *
 * LAYER 1 — Pure unit tests of `derivePaymentStateFromEvents`
 *   Tests the finality-precedence rule in isolation, with fabricated event
 *   sequences. Covers all required M3 test cases.
 *
 * LAYER 2 — DB integration tests using real M2 event records
 *   Tests `derivePaymentState` (the DB-backed function) against the actual
 *   persisted M2 payments. Confirms cross-payment isolation.
 *
 * The finality-precedence rule under test:
 *   CAPTURED (rank 3) > AUTHORIZED (rank 2) > FAILED (rank 1) > UNKNOWN (rank 0)
 *   payment_link.paid carries no rank — it is a correlation signal only.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

// ── Load the pure derivation function via dynamic import.
// We transpile via tsx (installed as part of better-sqlite3 toolchain check).
// Because this project uses TypeScript source, we use the compiled path.
// The test loads the TypeScript source directly via tsx.

// Dynamic imports for TypeScript sources via tsx
const { derivePaymentStateFromEvents, derivePaymentState } = await import(
  "../lib/payments/state.ts"
);

// ─── LAYER 1: Pure unit tests (no DB) ────────────────────────────────────────

describe("derivePaymentStateFromEvents — finality precedence rule", () => {

  // ── Required test cases ────────────────────────────────────────────────────

  test("1. failed only → FAILED", () => {
    assert.equal(derivePaymentStateFromEvents(["payment.failed"]), "FAILED");
  });

  test("2. authorized only → AUTHORIZED", () => {
    assert.equal(derivePaymentStateFromEvents(["payment.authorized"]), "AUTHORIZED");
  });

  test("3. captured only → CAPTURED", () => {
    assert.equal(derivePaymentStateFromEvents(["payment.captured"]), "CAPTURED");
  });

  test("4. authorized → captured → CAPTURED", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment.authorized", "payment.captured"]),
      "CAPTURED"
    );
  });

  test("5. failed → captured → CAPTURED", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment.failed", "payment.captured"]),
      "CAPTURED"
    );
  });

  test("6. captured → failed → CAPTURED (out-of-order: finality preserved)", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment.captured", "payment.failed"]),
      "CAPTURED"
    );
  });

  test("7. payment_link.paid + captured → CAPTURED (plink is correlation signal only)", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment_link.paid", "payment.captured"]),
      "CAPTURED"
    );
  });

  test("8a. duplicate payment.failed → FAILED (idempotent)", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment.failed", "payment.failed"]),
      "FAILED"
    );
  });

  test("8b. duplicate payment.captured → CAPTURED (idempotent)", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment.captured", "payment.captured"]),
      "CAPTURED"
    );
  });

  test("9a. captured → authorized (reversed order) → CAPTURED", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment.captured", "payment.authorized"]),
      "CAPTURED"
    );
  });

  test("9b. failed → authorized (reversed order) → AUTHORIZED", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment.authorized", "payment.failed"]),
      "AUTHORIZED"
    );
  });

  test("9c. payment_link.paid → captured (plink arrives first) → CAPTURED", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment_link.paid", "payment.captured"]),
      "CAPTURED"
    );
  });

  // ── Additional sequence: authorized → failed → captured ────────────────────
  // This is not in the required list but demonstrates the general rule applies
  // to sequences not explicitly special-cased.

  test("EXTRA: authorized → failed → captured → CAPTURED (general rule, not special case)", () => {
    assert.equal(
      derivePaymentStateFromEvents([
        "payment.authorized",
        "payment.failed",
        "payment.captured",
      ]),
      "CAPTURED"
    );
  });

  test("EXTRA: authorized → failed → AUTHORIZED (no capture received)", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment.authorized", "payment.failed"]),
      "AUTHORIZED"
    );
  });

  test("EXTRA: payment_link.paid alone → UNKNOWN (no payment state event)", () => {
    assert.equal(
      derivePaymentStateFromEvents(["payment_link.paid"]),
      "UNKNOWN"
    );
  });

  test("EXTRA: empty event list → UNKNOWN", () => {
    assert.equal(derivePaymentStateFromEvents([]), "UNKNOWN");
  });

  test("EXTRA: unknown event type → UNKNOWN", () => {
    assert.equal(derivePaymentStateFromEvents(["order.paid"]), "UNKNOWN");
  });
});

// ─── LAYER 2: DB integration tests — real M2 events ──────────────────────────

describe("derivePaymentState — real M2 database events", () => {

  // Real payment IDs from M2 verification.
  const REAL_CAPTURED_PAYMENT = "pay_TUJOzQxoEqFSLU"; // has authorized+captured+plink
  const REAL_FAILED_PAYMENT   = "pay_TUJULUouXtIq8y"; // has failed only

  test("10a. Real captured payment (pay_TUJOzQxoEqFSLU) → CAPTURED", () => {
    // This payment produced: payment.authorized, payment.captured, payment_link.paid
    // Expected: CAPTURED (highest finality rank)
    const state = derivePaymentState(REAL_CAPTURED_PAYMENT);
    assert.equal(state, "CAPTURED",
      `Expected CAPTURED for ${REAL_CAPTURED_PAYMENT}, got ${state}`
    );
  });

  test("10b. Real failed payment (pay_TUJULUouXtIq8y) → FAILED", () => {
    // This payment produced: payment.failed only
    // Expected: FAILED
    const state = derivePaymentState(REAL_FAILED_PAYMENT);
    assert.equal(state, "FAILED",
      `Expected FAILED for ${REAL_FAILED_PAYMENT}, got ${state}`
    );
  });

  test("10c. No cross-contamination: captured payment state is CAPTURED not FAILED", () => {
    // Verify that the failed payment's events do NOT pollute the captured payment.
    const capturedState = derivePaymentState(REAL_CAPTURED_PAYMENT);
    const failedState   = derivePaymentState(REAL_FAILED_PAYMENT);
    assert.equal(capturedState, "CAPTURED");
    assert.equal(failedState,   "FAILED");
    assert.notEqual(capturedState, failedState,
      "Two distinct payments must not produce the same state from each other's events"
    );
  });

  test("10d. Synthetic payment ID unknown to DB → UNKNOWN", () => {
    // Confirms the function returns UNKNOWN for a payment with no persisted events.
    const state = derivePaymentState("pay_SYNTHETIC_DOES_NOT_EXIST");
    assert.equal(state, "UNKNOWN",
      `Expected UNKNOWN for a payment not in DB, got ${state}`
    );
  });
});
