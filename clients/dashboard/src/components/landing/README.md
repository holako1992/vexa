# `src/components/landing/` — the public landing page

- **`Landing.tsx`** — what a visitor without a session sees at `/` (`app/page.tsx` renders it):
  the header (Features · Pricing · About anchors, **Log in** and **Try for free**, both to
  `/login`), the hero, what the product does, how it works, pricing, about, and a closing call to
  action. A server component with no client JavaScript.

The pricing cards state only the plan sheet `app/page.tsx` read from the core
(`lib/planSheet.ts` → admin-api `GET /internal/billing/plans`): the catalog's limits and Stripe's
prices. A paid plan with no confirmed price says "See pricing after sign-up", and a failed read
says the plans couldn't load — the page never prints a figure the core won't enforce. A paid
plan's button signs in and lands on `/billing`. The product name is `PRODUCT_NAME` (default
"Vexa"); the About section credits the open-source Vexa project either way.

Every feature the page names is one this dashboard ships. Add a line here only with the feature.
