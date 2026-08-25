# RecoverAI — Agent Instructions

## Project

RecoverAI is an AI Revenue Recovery buildathon project built around Razorpay Test Mode.

The core product loop is:

DETECT → DIAGNOSE → SCORE → RECOMMEND → RECOVER → CONFIRM → MEASURE

The goal is to build a small, polished, genuinely working product rather than a large incomplete application.

---

## Critical Development Principle

Prioritize a working end-to-end Razorpay recovery loop over feature count.

Do not build unnecessary pages or features before the core loop works.

The first priority is validating Razorpay Test Mode and Payment Links.

Do not implement AI or polished UI until the underlying Razorpay flow is validated.

---

## MVP

The MVP should eventually:

1. Detect potentially recoverable failed payments.
2. Analyze available transaction evidence.
3. Calculate a transparent recovery probability.
4. Use AI to explain the situation and recommend an action.
5. Generate a Razorpay Test Mode Payment Link.
6. Allow the customer to complete the test payment.
7. Confirm the successful payment through a webhook and/or status check.
8. Track and display recovered revenue.

---

## Environment Setup

Use environment variables for all secrets.

Expected environment variables:

- `RAZORPAY_KEY_ID`
- `RAZORPAY_KEY_SECRET`
- `RAZORPAY_WEBHOOK_SECRET`
- `DATABASE_URL`
- `NEXT_PUBLIC_APP_URL` (used for constructing Payment Link callback/redirect URLs)

Use `.env.local` for local development.

Never commit `.env.local` or any file containing real credentials.

Create and maintain `.env.example` containing placeholder values only:

```text
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
DATABASE_URL=
NEXT_PUBLIC_APP_URL=http://localhost:3000
```

Razorpay client initialization must only happen server-side (API routes / server actions). Never import the Razorpay secret key into any file that ships to the browser.

If a required environment variable is missing at runtime, fail loudly with a clear error message rather than silently falling back to a mocked client.

---

## Verification Commands

Run these before considering any milestone complete:

- Install: `npm install`
- Dev server: `npm run dev`
- Build: `npm run build`
- Lint: `npm run lint`
- Type check: `npx tsc --noEmit` (if not already part of build)

A milestone is not "done" until `npm run build` succeeds with no errors and the specific behavior for that milestone has been manually exercised and observed (see Milestone Verification Requirement below).

If these commands don't match the actual project setup (e.g. a different package manager or framework is used), update this section to reflect the real commands — do not silently substitute different ones without noting the change.

---

## Milestone Verification Requirement

Milestone 1 (and every milestone involving Razorpay) is not complete until a real HTTP request has been made to Razorpay's Test Mode API and a real response has been logged and inspected.

Do not mock, stub, or assume the shape of a Razorpay API response. If a mock is used for early scaffolding, it must be explicitly labeled `TEMP MOCK — replace with real Razorpay call` and removed before the milestone is marked complete.

For each milestone, report back:

- What was actually run (command or request).
- What the actual response/output was (paste real logs/output, not a paraphrase).
- Whether it matched expectations, and if not, what the discrepancy was.

Never report a milestone as working based on code inspection alone.

---

## Escalation Triggers — Stop and Ask

Stop implementation and report back to the user (rather than improvising a workaround) if any of the following occur:

- A Razorpay API returns an undocumented field, unexpected status, or behavior that contradicts the plan in this file.
- Webhook signature verification fails unexpectedly, or the webhook payload shape differs from what was planned for.
- A planned recovery action (e.g. Payment Link creation/completion) turns out to be unsupported or behaves differently in Test Mode than assumed.
- Completing a milestone would require adding a feature/page/dependency not listed in this file.
- Any situation where the only way to "make it work" would involve faking a response, simulating success without a real underlying event, or bypassing signature/webhook verification.

In these cases: describe the discrepancy, propose 1-2 options, and wait for a decision rather than picking a default and continuing.

---

## Directory Structure

Use this as the starting skeleton. Extend only as needed — do not pre-build empty structure for unbuilt features.

```text
/app
  /api
    /payment-link       → create Razorpay Payment Link
    /webhooks/razorpay   → webhook receiver + signature verification
    /recovery-cases      → CRUD/read for recovery case records
  /(dashboard)
    page.tsx              → single MVP screen (metrics + case list + drawer)
/lib
  /razorpay
    client.ts             → server-side Razorpay SDK client init
    payment-links.ts       → payment link creation helpers
    webhooks.ts            → signature verification + event parsing
  /scoring
    recovery-score.ts      → deterministic recovery probability logic
  /ai
    diagnosis.ts            → AI reasoning/explanation layer (calls scoring output, not the reverse)
  /db
    schema.ts / client.ts   → DB models + connection
/components
  RecoveryCaseCard.tsx
  RecoveryCaseDrawer.tsx
  MetricsHeader.tsx
```

Business logic (scoring, Razorpay calls, webhook parsing) belongs in `/lib`, not inline in API routes or components. API routes should stay thin — validate input, call `/lib` functions, return response.

---

## Razorpay Safety

Use Razorpay Test Mode only.

Never expose Razorpay credentials in frontend code.

Never commit `.env` files or secrets.

Never fabricate Razorpay API responses.

Never claim a payment succeeded without verified evidence.

Never claim revenue was recovered without verified evidence.

Never assume undocumented Razorpay functionality.

Verify Razorpay behavior against official documentation before implementation.

Clearly distinguish:

- Razorpay Test Mode data
- Synthetic/demo data
- Simulated UI states

---

## Webhooks

Webhook implementation must:

- Verify webhook signatures.
- Validate payloads.
- Handle duplicate events safely.
- Be idempotent.
- Store relevant event identifiers.
- Handle delayed webhook delivery.

A payment-status/API polling fallback should be implemented for demo reliability.

---

## Financial Integrity

Financial calculations must be deterministic.

Backend logic should calculate:

- transaction amounts
- revenue totals
- revenue at risk
- recoverable revenue
- recovered revenue
- percentages
- recovery rates

AI may handle:

- contextual reasoning
- diagnosis
- explanation
- recommendation

AI must not directly execute arbitrary financial operations.

---

## AI

Do not ask an LLM to randomly generate recovery probabilities.

Recovery probability should be based on transparent signals such as:

- previous successful payments
- customer history
- failure type
- payment method
- recent failure patterns
- retry count
- transaction value
- recency

The AI should explain the evidence behind the score.

Never invent evidence.

If evidence is insufficient, say so.

---

## Initial Development Order

Build in small, independently verified milestones.

### Milestone 1
Validate Razorpay Test Mode and Payment Link creation. (Real API call required — see Milestone Verification Requirement.)

### Milestone 2
Complete a Test Mode Payment Link payment.

### Milestone 3
Receive and verify the relevant Razorpay webhook.

### Milestone 4
Implement payment-status polling fallback.

### Milestone 5
Connect payment confirmation to a recovery record and recovered-revenue calculation.

### Milestone 6
Implement deterministic recovery scoring.

### Milestone 7
Add AI diagnosis and recommendation.

### Milestone 8
Build the minimal polished dashboard.

### Milestone 9
Create the final end-to-end demo.

Do not skip ahead without approval.

---

## Scope Restrictions

Do NOT initially build:

- Real-money payments
- Real bank transfers
- Fraud detection
- Full subscription recovery
- SMS infrastructure
- Email infrastructure
- Multi-merchant architecture
- Mobile application
- Complex authentication
- Large analytics suite
- Multiple recovery strategies
- Complex ML models
- Unnecessary pages
- Unnecessary dependencies

One excellent recovery workflow is more valuable than many incomplete features.

---

## Git

GitHub is the source of truth.

Use meaningful commits.

Examples:

- `chore: initialize project`
- `feat: add razorpay test client`
- `feat: create payment link endpoint`
- `feat: add webhook verification`
- `feat: add recovery tracking`
- `feat: add recovery scoring`
- `feat: add ai diagnosis`
- `feat: build recovery dashboard`

Before committing:

1. Test the change.
2. Check the diff.
3. Check for secrets.
4. Ensure the application still runs.

Never commit secrets.

Never commit broken experimental work merely to create a checkpoint.

---

## Code Quality

Prefer:

- TypeScript
- clear module boundaries
- small functions
- explicit types
- server-side Razorpay operations
- reusable components
- clear error handling

Avoid:

- giant components
- giant API routes
- duplicated business logic
- magic numbers
- hardcoded credentials
- unnecessary abstractions
- premature optimization

---

## UI

The final product should feel like a premium fintech SaaS product.

Prioritize:

- clean layout
- strong typography
- excellent spacing
- clear hierarchy
- restrained colors
- useful visualizations
- subtle animations
- responsive design
- accessibility

Avoid:

- generic AI chatbot aesthetics
- excessive gradients
- excessive rounded cards
- unnecessary AI sparkle icons
- clutter
- meaningless animations

Do not spend significant time polishing UI until the core payment/recovery loop works.

---

## Agent Behavior

Before substantial changes:

1. Inspect the existing code.
2. Understand the current architecture.
3. Identify relevant files.
4. Make the smallest reasonable change.
5. Run relevant tests/build/lint (see Verification Commands).
6. Inspect the result.
7. Fix errors.
8. Report what was actually verified.

Never claim something works merely because the code looks correct.

If a requirement depends on Razorpay behavior, verify it using official Razorpay documentation or an actual Test Mode request.

If an API capability is uncertain, flag the uncertainty instead of guessing (see Escalation Triggers).

Do not expand scope without approval.