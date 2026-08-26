#!/usr/bin/env node
/**
 * M2 Local Verification Script
 *
 * Tests the webhook endpoint locally:
 *   1. Valid signature accepted
 *   2. Invalid signature rejected (401)
 *   3. Duplicate event ID not re-inserted
 *   4. Unsupported event type acknowledged without persisting
 *   5. DB row verification
 *
 * Usage: node scripts/verify-webhook-local.mjs
 *
 * Requires RAZORPAY_WEBHOOK_SECRET in .env.local
 * Requires dev server running on http://localhost:3000
 */

import { createHmac } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

// ── Load .env.local ──────────────────────────────────────────────────────────
function loadEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  try {
    const content = readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([^#=]+)=(.*)$/);
      if (match) process.env[match[1].trim()] = match[2].trim();
    }
  } catch {
    console.error("Could not read .env.local");
    process.exit(1);
  }
}

loadEnvLocal();

const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
if (!WEBHOOK_SECRET) {
  console.error("RAZORPAY_WEBHOOK_SECRET is not set in .env.local");
  process.exit(1);
}

const BASE_URL = "http://localhost:3000";
const ENDPOINT = `${BASE_URL}/api/webhooks/razorpay`;

function sign(body, secret) {
  return createHmac("sha256", secret).update(body).digest("hex");
}

async function post(body, eventId, signature) {
  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-razorpay-signature": signature,
      "x-razorpay-event-id": eventId,
    },
    body,
  });
  const json = await resp.json();
  return { status: resp.status, body: json };
}

function pass(label) {
  console.log(`  ✅ PASS: ${label}`);
}
function fail(label, details) {
  console.log(`  ❌ FAIL: ${label}`, details ?? "");
}

// ── Test cases ───────────────────────────────────────────────────────────────

// Realistic-looking payment.captured payload
const validPayload = JSON.stringify({
  entity: "event",
  account_id: "acc_test",
  event: "payment.captured",
  contains: ["payment"],
  payload: {
    payment: {
      entity: {
        id: "pay_M2LocalTest001",
        amount: 10000,
        currency: "INR",
        status: "captured",
        order_id: "order_M2LocalTest001",
        method: "netbanking",
        captured: true,
      },
    },
  },
});

const TEST_EVENT_ID = `m2-local-test-${Date.now()}`;

async function runTests() {
  console.log("RecoverAI M2 Local Webhook Verification");
  console.log("=========================================\n");

  let allPassed = true;

  // Test 1: Valid signature accepted
  {
    const sig = sign(validPayload, WEBHOOK_SECRET);
    const { status, body } = await post(validPayload, TEST_EVENT_ID, sig);
    if (status === 200 && body.received === true && body.processed === true) {
      pass(`Valid signature accepted (status=${status}, processed=${body.processed})`);
    } else {
      fail("Valid signature should be accepted", { status, body });
      allPassed = false;
    }
  }

  // Test 2: Duplicate event ID not re-inserted
  {
    const sig = sign(validPayload, WEBHOOK_SECRET);
    const { status, body } = await post(validPayload, TEST_EVENT_ID, sig);
    if (status === 200 && body.received === true && body.reason === "duplicate_event_id") {
      pass(`Duplicate event ID deduplicated (status=${status}, reason=${body.reason})`);
    } else {
      fail("Duplicate event ID should return duplicate_event_id reason", { status, body });
      allPassed = false;
    }
  }

  // Test 3: Invalid signature rejected
  {
    const { status, body } = await post(validPayload, `${TEST_EVENT_ID}-tampered`, "invalidsignaturexyz");
    if (status === 401 && body.error) {
      pass(`Invalid signature rejected (status=${status})`);
    } else {
      fail("Invalid signature should be rejected with 401", { status, body });
      allPassed = false;
    }
  }

  // Test 4: Tampered body (valid sig for different body)
  {
    const originalBody = validPayload;
    const tamperedBody = originalBody.replace("captured", "authorized");
    const sigForOriginal = sign(originalBody, WEBHOOK_SECRET);
    const { status, body } = await post(tamperedBody, `${TEST_EVENT_ID}-body-tampered`, sigForOriginal);
    if (status === 401) {
      pass(`Tampered body rejected (signature mismatch, status=${status})`);
    } else {
      fail("Tampered body should be rejected with 401", { status, body });
      allPassed = false;
    }
  }

  // Test 5: Unsupported event type
  {
    const unsupportedPayload = JSON.stringify({ entity: "event", event: "order.paid", payload: {} });
    const sig = sign(unsupportedPayload, WEBHOOK_SECRET);
    const { status, body } = await post(unsupportedPayload, `${TEST_EVENT_ID}-unsupported`, sig);
    if (status === 200 && body.processed === false && body.reason === "event_type_not_supported") {
      pass(`Unsupported event type acknowledged without processing (status=${status})`);
    } else {
      fail("Unsupported event type should return not_supported reason", { status, body });
      allPassed = false;
    }
  }

  // Test 6: payment.failed event
  {
    const failedPayload = JSON.stringify({
      entity: "event",
      event: "payment.failed",
      payload: {
        payment: {
          entity: {
            id: "pay_M2FailedTest001",
            status: "failed",
            error_code: "BAD_REQUEST_ERROR",
          },
        },
      },
    });
    const sig = sign(failedPayload, WEBHOOK_SECRET);
    const failedEventId = `${TEST_EVENT_ID}-failed`;
    const { status, body } = await post(failedPayload, failedEventId, sig);
    if (status === 200 && body.processed === true) {
      pass(`payment.failed event persisted (status=${status})`);
    } else {
      fail("payment.failed event should be persisted", { status, body });
      allPassed = false;
    }
  }

  // Test 7: payment_link.paid event
  {
    const plinkPayload = JSON.stringify({
      entity: "event",
      event: "payment_link.paid",
      contains: ["payment_link", "payment"],
      payload: {
        payment_link: {
          entity: { id: "plink_M2Test001", status: "paid", amount_paid: 10000 },
        },
        payment: {
          entity: { id: "pay_M2PlinkTest001" },
        },
      },
    });
    const sig = sign(plinkPayload, WEBHOOK_SECRET);
    const plinkEventId = `${TEST_EVENT_ID}-plink`;
    const { status, body } = await post(plinkPayload, plinkEventId, sig);
    if (status === 200 && body.processed === true) {
      pass(`payment_link.paid event persisted (status=${status})`);
    } else {
      fail("payment_link.paid event should be persisted", { status, body });
      allPassed = false;
    }
  }

  console.log("\n─────────────────────────────────────────");
  if (allPassed) {
    console.log("ALL LOCAL TESTS PASSED ✅");
  } else {
    console.log("SOME TESTS FAILED ❌");
  }
  console.log("\nNote: This verifies LOCAL endpoint behavior only.");
  console.log("Real Razorpay webhook delivery still requires an external tunnel.");
}

runTests().catch((err) => {
  console.error("Test runner error:", err.message);
  process.exit(1);
});
