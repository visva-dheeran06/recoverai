# RecoverAI Milestones

## Milestone 1 — Razorpay Test Mode Payment Link

**Status: COMPLETE**

### What was built

- Next.js + TypeScript project scaffolded with the App Router.
- Server-side Razorpay integration via a dedicated client module.
- `POST /api/payment-link` API route that creates a Standard Payment Link.
- Integration runs in **Razorpay Test Mode** — no real money is processed.

### Verified behaviour

- Rs.100 test amount used for all test payment link creation.
- A real HTTP request is made to the Razorpay API.
- The response contains real fields: `id`, `short_url`, `status`, `amount`, and `reference_id`.
- The Test Mode checkout was manually opened in a browser and visually verified.

### Build and lint status

- `npm run build` passes cleanly.
- `npm run lint` passes with one currently known, non-blocking warning (not described here).

### Environment

- `.env.local` is listed in `.gitignore` and is **not tracked** by Git.
- No credentials, secrets, or private URLs are committed to the repository.

### Milestone commit

```
d37b704  feat: add razorpay test payment link integration
```

---

## Milestone 2 — Payment Verification

**Status: NOT STARTED**

### Intended objective

- Successfully complete a Razorpay Test Mode payment through the existing Payment Link created in M1.
- Verify the resulting payment state using real Razorpay Test Mode behaviour (e.g. confirm `captured` status).
- Deliberately test a failure case if the Test Mode flow permits it (e.g. simulate a declined payment).
- Record the actual observed behaviour before implementing any webhook or recovery logic.

> **M2 has not been completed.** No verification logic has been written yet.

---

## Upcoming Milestones

| Milestone | Title |
|-----------|-------|
| M3 | Razorpay webhook and signature verification |
| M4 | Payment status fallback |
| M5 | Recovery state and recovered revenue tracking |
| M6 | Deterministic recovery scoring |
| M7 | AI diagnosis and recommendation |
| M8 | Merchant dashboard |
| M9 | End-to-end demo and polish |

Implementation details for M3–M9 are not yet defined.
