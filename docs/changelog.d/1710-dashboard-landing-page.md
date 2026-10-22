- **A public landing page at `/`.** A visitor without a session now gets a front page instead of a
  redirect: what the product does, how it works, pricing, about, and **Log in** / **Try for free**
  (both to `/login`); a signed-in person at `/` still gets their meetings. Pricing is the core's own
  plan sheet — admin-api's new internal `GET /internal/billing/plans` returns the catalog's limits and
  the prices Stripe confirms — so the page never states a limit or amount the core doesn't; a paid
  plan with no configured price reads "See pricing after sign-up". `PRODUCT_NAME` sets the name the
  page and the sign-in card show (default "Vexa").
