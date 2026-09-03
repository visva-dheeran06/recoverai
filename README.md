# RecoverAI — Payment Recovery Console

**Razorpay Buildathon** · Intelligent payment recovery for merchants

RecoverAI combines Razorpay webhook evidence with on-demand API verification to deterministically diagnose failed payments and recommend recovery actions, with optional Gemini AI-enhanced explanations.

---

## What it does

Given a Razorpay payment ID, RecoverAI:

1. **Derives the canonical payment state** from persisted webhook events (M3)
2. **Independently verifies** the state via the Razorpay API (M4)
3. **Reconciles** both sources to detect discrepancies (M5)
4. **Scores recoverability** 0–100 with a breakdown of five factors (M6)
5. **Diagnoses the failure** and recommends a concrete merchant action (M7A)
6. **Optionally enhances** the explanation with Gemini AI (M7B)
7. **Displays everything** in a merchant-facing dashboard (M8)

---

## Quick start

```bash
npm install
cp .env.example .env.local
npm run dev
# → http://localhost:3000
```

### Required environment variables (`.env.local`)

| Variable | Purpose |
|----------|---------|
| `RAZORPAY_KEY_ID` | Razorpay Test Mode key ID |
| `RAZORPAY_KEY_SECRET` | Razorpay Test Mode key secret |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook signature verification secret |
| `GEMINI_API_KEY` | *(Optional)* Enables AI-enhanced explanations |

---

## Architecture

```text
Razorpay Test Mode
    │
    ├─▶ POST /api/webhooks/razorpay       (M2) Webhook intake, signature verification, SQLite persistence
    │
    ├─▶ GET  /api/payment-state           (M3) Canonical state derivation from webhook events
    ├─▶ GET  /api/razorpay-payment-status  (M4) On-demand Razorpay API observation
    ├─▶ GET  /api/reconciliation           (M5) M3 vs M4 comparison
    ├─▶ GET  /api/recovery-score           (M6) Deterministic 0–100 recovery score + factor breakdown
    └─▶ GET  /api/diagnosis                (M7A/M7B) Diagnosis + recommendation + optional AI text

Dashboard (/) ← fetches M5, M6, M7 in parallel
```

**Persistence:** SQLite via `better-sqlite3` (`data/recoverai.db`). Zero infrastructure required.

**AI:** If `GEMINI_API_KEY` is set, Gemini enhances the natural-language explanation fields only. All authoritative fields — score, tier, category, action, priority, and confidence — remain deterministic. If AI is absent or fails, the deterministic result remains available.

---

## Demo scenarios

Open `http://localhost:3000` and use the **Quick demo** buttons:

| Button | Payment ID | Expected |
|--------|------------|----------|
| Bank Failure | `pay_TUJULUouXtIq8y` | FAILED · BANK_DECLINE · RETRY_PAYMENT |
| Captured | `pay_TUJOzQxoEqFSLU` | CAPTURED · NO_ACTION |
| Unknown | `pay_DEMOUNKNOWN000` | UNKNOWN · INSUFFICIENT_EVIDENCE · COLLECT_MORE_EVIDENCE |

> **Note on scores:** Recovery scores include a recency factor that changes with time. The displayed score may differ from values in `docs/MILESTONES.md`, which uses a fixed reference timestamp. Tier, category, action, and confidence are stable for the corresponding evidence.

---

## Testing

```bash
npm test
npm run build
npm run lint
```

Final validation:

- **234 / 234 tests passing**
- **Production build:** PASS
- **Lint:** 0 errors, 1 pre-existing warning

---

## Project layout

```text
app/
  page.tsx                    Dashboard UI (client component)
  globals.css                 Dark fintech design system
  api/
    diagnosis/route.ts        M7A/M7B — diagnosis + AI enhancement
    recovery-score/route.ts   M6 — recovery score
    reconciliation/route.ts   M5 — reconciliation
    payment-state/route.ts    M3 — canonical state
    razorpay-payment-status/  M4 — Razorpay API observation
    webhooks/razorpay/        M2 — webhook intake
    payment-link/             M1 — test payment link creation

lib/
  payments/
    diagnosis.ts              M7A deterministic diagnosis
    ai-enhancement.ts         M7B optional Gemini enhancement
    recovery-score.ts         M6 scoring engine (5 factors)
    reconciliation.ts         M5 reconciliation logic
    state.ts                  M3 state derivation
  razorpay/
    client.ts                 Razorpay SDK client
    payments.ts               M4 payment fetch + normalization
    webhooks.ts               Signature verification + parsing
  db/
    client.ts                 SQLite connection

tests/                         234 tests across the recovery pipeline
docs/MILESTONES.md             Detailed milestone documentation
```

---

## Recovery scoring

RecoverAI calculates a deterministic recovery score from **0–100** using five explainable factors:

| Factor | Maximum |
|--------|--------:|
| Failure Type | 40 |
| Payment History | 25 |
| Retry History | 15 |
| Amount / Context | 10 |
| Recency | 10 |
| **Total** | **100** |

### Recovery tiers

```text
70–100  → HIGH
40–69   → MEDIUM
0–39    → LOW
```

Every scoring factor can be traced back to defined payment evidence.

---

## Diagnosis and recommendation

RecoverAI classifies payments into structured diagnosis categories including:

- `CAPTURED`
- `AUTHORIZED`
- `BANK_DECLINE`
- `CUSTOMER_ACTION_REQUIRED`
- `BUSINESS_CONFIGURATION`
- `INFRASTRUCTURE_FAILURE`
- `UNKNOWN_PAYMENT_STATE`
- `INSUFFICIENT_EVIDENCE`

Recommendations include:

- `NO_ACTION`
- `CHECK_CAPTURE_STATUS`
- `RETRY_PAYMENT`
- `CUSTOMER_ACTION_REQUIRED`
- `REVIEW_MERCHANT_CONFIGURATION`
- `COLLECT_MORE_EVIDENCE`

This prevents the system from treating every failed payment as an automatic retry candidate.

---

## Security

- Razorpay webhook signatures are verified using the raw request body.
- Webhook events are deduplicated using the Razorpay event ID.
- Credentials are loaded through environment variables.
- Secrets are not committed to the repository.
- AI receives structured authoritative fields rather than raw webhook payloads or credentials.
- AI output is validated before being accepted.
- If AI is unavailable, the deterministic recovery pipeline continues to function.

Use **Razorpay Test Mode** credentials for local development and demonstrations.

---

## Current limitations

RecoverAI is a **payment recovery intelligence prototype** built for the Razorpay Buildathon.

The current implementation focuses on:

```text
Detect
  ↓
Verify
  ↓
Reconcile
  ↓
Score
  ↓
Diagnose
  ↓
Recommend
```

It does **not** claim production-scale automated revenue recovery or measured recovered revenue across a production batch.

Automated recovery execution, stopping rules, and batch-level recovered-revenue measurement are planned extensions.

---

## Future work

### Bounded recovery execution

```text
Recommendation
      ↓
Policy Check
      ↓
Merchant Approval / Allowed Rule
      ↓
Recovery Action
```

### Stopping rules

Potential controls include:

- Maximum retry attempts
- Minimum time between retries
- Maximum recovery window
- Payment-state checks before execution

### Batch recovery measurement

```text
At-risk payments
       ↓
Eligible payments
       ↓
Recovery attempts
       ↓
Successful recoveries
       ↓
Recovered revenue
```

This would allow RecoverAI to measure actual recovery performance across a batch.

---

## Design principle

> **Don't just identify that a payment failed. Determine what happened, evaluate whether recovery makes sense, and recommend the right next action.**

The system deliberately separates:

```text
Evidence
   ↓
Verification
   ↓
Reconciliation
   ↓
Scoring
   ↓
Diagnosis
   ↓
Recommendation
```

The deterministic core makes the recovery decision explainable and auditable, while AI is used to improve the human-readable explanation rather than replace the decision engine.

---

## Status

**M1–M9 complete.**

- ✓ Razorpay Test Mode integration
- ✓ Payment Link
- ✓ Webhook ingestion
- ✓ Webhook signature verification
- ✓ SQLite event persistence
- ✓ Canonical payment state
- ✓ Independent Razorpay API verification
- ✓ Evidence reconciliation
- ✓ Deterministic recovery scoring
- ✓ Recovery tiers and confidence
- ✓ Failure diagnosis
- ✓ Recovery recommendation
- ✓ Optional Gemini AI enhancement
- ✓ Deterministic AI fallback
- ✓ Merchant dashboard
- ✓ End-to-end Test Mode demonstration
- ✓ 234 automated tests
- ✓ Production build
- ✓ Lint validation with 0 errors

---

## Built for the Razorpay Buildathon

RecoverAI turns payment failures into **verified, explainable, and actionable recovery decisions**.

> **A failed payment is an event. Lost revenue is the outcome we're trying to prevent.**
