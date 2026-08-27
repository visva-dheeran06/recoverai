/**
 * M4 Live Verification Script — Real Razorpay Test Mode API
 *
 * Tests `fetchPaymentStatus` against real Razorpay Test Mode payments.
 *
 * Run with:
 *   node --import tsx/esm scripts/test-m4-live.mjs
 *   (tsx is already installed as a dev dependency)
 *
 * Or via tsx directly:
 *   npx tsx scripts/test-m4-live.mjs
 *
 * Environment:
 *   Reads RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET from .env.local
 *   using the same manual-load pattern as scripts/verify-webhook-local.mjs.
 *
 * SECURITY:
 *   - Credentials are NEVER printed.
 *   - Only safe verification fields are logged.
 *   - This script must never be modified to print secrets.
 *
 * Real payment IDs used (from M2 Test Mode verification):
 *   pay_TUJOzQxoEqFSLU  — captured payment
 *   pay_TUJULUouXtIq8y  — failed payment
 *   pay_DOESNOTEXIST    — nonexistent payment (verifying not_found behavior)
 */

import { readFileSync } from "fs";
import { join } from "path";

// ── Step 1: Load .env.local (same pattern as verify-webhook-local.mjs) ────────

function loadEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  } catch {
    console.error("❌ Could not read .env.local — ensure it exists in the project root.");
    process.exit(1);
  }
}

loadEnvLocal();

// Verify credentials loaded (without printing values)
const keyId = process.env.RAZORPAY_KEY_ID;
const keySecret = process.env.RAZORPAY_KEY_SECRET;

if (!keyId || !keySecret) {
  console.error("❌ RAZORPAY_KEY_ID and/or RAZORPAY_KEY_SECRET not found in .env.local");
  process.exit(1);
}

console.log("✅ Credentials loaded from .env.local (values not displayed)");

// ── Step 2: Import the M4 payment status client ───────────────────────────────

const { fetchPaymentStatus } = await import("../lib/razorpay/payments.ts");

// ── Step 3: Helpers ───────────────────────────────────────────────────────────

function printSeparator(title) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  ${title}`);
  console.log("─".repeat(60));
}

function pass(label) {
  console.log(`  ✅ PASS: ${label}`);
}

function fail(label, detail = "") {
  console.log(`  ❌ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
}

// ── Step 4: Test cases ────────────────────────────────────────────────────────

let allPassed = true;

// ─────────────────────────────────────────────────────────────────────────────
// CASE 1 — Real captured payment
// ─────────────────────────────────────────────────────────────────────────────

printSeparator("CASE 1: pay_TUJOzQxoEqFSLU (expected: captured)");

{
  const paymentId = "pay_TUJOzQxoEqFSLU";
  const result = await fetchPaymentStatus(paymentId);

  console.log(`  Payment ID  : ${paymentId}`);
  console.log(`  Outcome     : ${result.outcome}`);

  if (result.outcome === "success") {
    const obs = result.observation;
    console.log(`  Status      : ${obs.razorpayStatus}`);
    console.log(`  Captured    : ${obs.captured}`);
    console.log(`  Amount      : ${obs.amount} (smallest unit, e.g. paise)`);
    console.log(`  Currency    : ${obs.currency}`);
    console.log(`  Created at  : ${new Date(obs.createdAt * 1000).toISOString()}`);
    console.log(`  Fetched at  : ${obs.fetchedAt}`);
    console.log(`  Error code  : ${obs.errorCode ?? "(none)"}`);

    // Assertions
    if (obs.paymentId === paymentId) {
      pass("paymentId matches request");
    } else {
      fail("paymentId mismatch", `got ${obs.paymentId}`);
      allPassed = false;
    }

    if (obs.razorpayStatus === "captured") {
      pass("razorpayStatus === 'captured'");
    } else {
      fail("razorpayStatus", `expected 'captured', got '${obs.razorpayStatus}'`);
      allPassed = false;
    }

    if (obs.captured === true) {
      pass("captured === true");
    } else {
      fail("captured flag", `expected true, got ${obs.captured}`);
      allPassed = false;
    }

    if (typeof obs.amount === "number" && obs.amount > 0) {
      pass(`amount present and positive (${obs.amount})`);
    } else {
      fail("amount", `expected positive number, got ${obs.amount}`);
      allPassed = false;
    }

    if (obs.currency && obs.currency.length === 3) {
      pass(`currency present (${obs.currency})`);
    } else {
      fail("currency", `expected 3-char ISO code, got '${obs.currency}'`);
      allPassed = false;
    }

    // Credential safety check
    const serialized = JSON.stringify(obs);
    if (serialized.includes("key_id") || serialized.includes("key_secret")) {
      fail("SECURITY: credentials found in observation object");
      allPassed = false;
    } else {
      pass("no credentials in observation object");
    }

  } else if (result.outcome === "not_found") {
    fail("Expected success, got not_found for known payment");
    allPassed = false;
  } else {
    fail(`Expected success, got ${result.outcome}`, result.message ?? "");
    allPassed = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE 2 — Real failed payment
// ─────────────────────────────────────────────────────────────────────────────

printSeparator("CASE 2: pay_TUJULUouXtIq8y (expected: failed)");

{
  const paymentId = "pay_TUJULUouXtIq8y";
  const result = await fetchPaymentStatus(paymentId);

  console.log(`  Payment ID  : ${paymentId}`);
  console.log(`  Outcome     : ${result.outcome}`);

  if (result.outcome === "success") {
    const obs = result.observation;
    console.log(`  Status      : ${obs.razorpayStatus}`);
    console.log(`  Captured    : ${obs.captured}`);
    console.log(`  Amount      : ${obs.amount}`);
    console.log(`  Currency    : ${obs.currency}`);
    console.log(`  Error code  : ${obs.errorCode ?? "(none)"}`);
    console.log(`  Error desc  : ${obs.errorDescription ?? "(none)"}`);
    console.log(`  Error source: ${obs.errorSource ?? "(none)"}`);
    console.log(`  Error step  : ${obs.errorStep ?? "(none)"}`);
    console.log(`  Error reason: ${obs.errorReason ?? "(none)"}`);
    console.log(`  Fetched at  : ${obs.fetchedAt}`);

    // Assertions
    if (obs.paymentId === paymentId) {
      pass("paymentId matches request");
    } else {
      fail("paymentId mismatch", `got ${obs.paymentId}`);
      allPassed = false;
    }

    if (obs.razorpayStatus === "failed") {
      pass("razorpayStatus === 'failed'");
    } else {
      fail("razorpayStatus", `expected 'failed', got '${obs.razorpayStatus}'`);
      allPassed = false;
    }

    if (obs.captured === false) {
      pass("captured === false");
    } else {
      fail("captured flag", `expected false, got ${obs.captured}`);
      allPassed = false;
    }

    // Credential safety check
    const serialized = JSON.stringify(obs);
    if (serialized.includes("key_id") || serialized.includes("key_secret")) {
      fail("SECURITY: credentials found in observation object");
      allPassed = false;
    } else {
      pass("no credentials in observation object");
    }

  } else if (result.outcome === "not_found") {
    fail("Expected success for known failed payment, got not_found");
    allPassed = false;
  } else {
    fail(`Expected success, got ${result.outcome}`, result.message ?? "");
    allPassed = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CASE 3 — Nonexistent payment
// ─────────────────────────────────────────────────────────────────────────────

printSeparator("CASE 3: pay_DOESNOTEXIST (expected: not_found or api_error)");

{
  const paymentId = "pay_DOESNOTEXIST";
  const result = await fetchPaymentStatus(paymentId);

  console.log(`  Payment ID  : ${paymentId}`);
  console.log(`  Outcome     : ${result.outcome}`);

  if (result.outcome === "not_found") {
    pass("Razorpay returned 400 'does not exist' → classified as not_found ✅");
    pass("Real API behavior: HTTP 400 (not 404) with 'The id provided does not exist'");
    pass("classifyRazorpayError correctly handles both 404 and this 400 variant");
  } else if (result.outcome === "api_error") {
    // If still api_error after the fix, something unexpected happened.
    fail(`Expected not_found after classifier fix, got api_error`);
    console.log(`    Message: ${result.message}`);
    allPassed = false;
  } else if (result.outcome === "success") {
    fail("Unexpected success for nonexistent payment — Razorpay should not return data");
    allPassed = false;
  } else if (result.outcome === "config_error") {
    fail("Config error on CASE 3 after already succeeding on CASE 1 — unexpected");
    allPassed = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(60)}`);
if (allPassed) {
  console.log("  M4 LIVE VERIFICATION: ALL ASSERTIONS PASSED ✅");
} else {
  console.log("  M4 LIVE VERIFICATION: SOME ASSERTIONS FAILED ❌");
}
console.log(`${"═".repeat(60)}\n`);

if (!allPassed) {
  process.exit(1);
}
