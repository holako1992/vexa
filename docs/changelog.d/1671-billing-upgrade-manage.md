- **The billing page can now upgrade and manage a subscription, not just read one (#1671).**
  `/billing` grows two write controls on top of DB-74's read-only view: an **Upgrade** button on
  each paid plan card (with a monthly/yearly toggle) starts a Stripe Checkout session
  (`POST /billing/checkout {plan, interval}`) and redirects there; a **Manage subscription**
  button opens the Stripe Customer Portal (`POST /billing/portal`) the same way. Both routes were
  already fronted by the gateway (DB-73) — this only adds them to the dashboard's own closed write
  allowlist, with an exact `{plan, interval}` body shape check (a real paid plan id, `month` or
  `year`, nothing else) rather than forwarding an arbitrary body. A `{url}` response is checked
  against Stripe's own Checkout/Portal hosts before the browser is ever redirected there, so a
  malformed or wrong-shaped response fails closed instead of taking a signed-in user's browser to
  an arbitrary origin. An account with no Stripe customer yet gets a 409 from the portal — the
  page shows a toast explaining there's nothing to manage yet, pointing at the Upgrade buttons
  already on the same page, never a generic error.
