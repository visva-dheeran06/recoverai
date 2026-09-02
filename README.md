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
# Install dependencies
npm install

# Add credentials (copy .env.example and fill in)
cp .env.example .env.local

# Run dev server
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

```
Razorpay Test Mode
    │
    ├─▶ POST /api/webhooks/razorpay   (M2) Webhook intake, signature verification, SQLite persistence
    │
    ├─▶ GET  /api/payment-state       (M3) Canonical state derivation from webhook events
    ├─▶ GET  /api/razorpay-payment-status (M4) On-demand Razorpay API observation
    ├─▶ GET  /api/reconciliation      (M5) M3 vs M4 comparison
    ├─▶ GET  /api/recovery-score      (M6) Deterministic 0–100 recovery score + factor breakdown
    └─▶ GET  /api/diagnosis           (M7A/M7B) Diagnosis category + recommendation + optional AI text

Dashboard (/)  ←  fetches M5, M6, M7 in parallel
```

**Persistence**: SQLite via `better-sqlite3` (`data/recoverai.db`). Zero infrastructure required.

**AI**: If `GEMINI_API_KEY` is set, `gemini-2.0-flash` enhances the three natural-language fields only. All authoritative fields (score, tier, category, action) remain deterministic. If AI is absent or fails, the response is identical — only `generation.mode` differs.

---

## Demo scenarios

Open `http://localhost:3000` and use the **Quick demo** buttons:

| Button | Payment ID | Expected |
|--------|-----------|---------|
| Bank Failure | `pay_TUJULUouXtIq8y` | FAILED · BANK_DECLINE · RETRY_PAYMENT |
| Captured | `pay_TUJOzQxoEqFSLU` | CAPTURED · NO_ACTION |
| Unknown | `pay_DEMOUNKNOWN000` | UNKNOWN · INSUFFICIENT_EVIDENCE · COLLECT_MORE_EVIDENCE |

> **Note on scores**: Recovery scores include a recency factor that changes with time. The displayed score may differ from values in `docs/MILESTONES.md` (which used a fixed reference timestamp). Tier, category, action, and confidence are stable.

---

## Testing

```bash
npm test       # 234 unit + integration tests
npm run build  # Production build (exit 0)
npm run lint   # ESLint (1 pre-existing warning, 0 errors)
```

---

## Project layout

```
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
    client.ts                 Razorpay SDK client (singleton)
    payments.ts               M4 payment fetch + normalization
    webhooks.ts               Signature verification + parsing
  db/
    client.ts                 SQLite connection (better-sqlite3)
tests/                        234 tests across all milestones
docs/MILESTONES.md            Detailed milestone documentation
```