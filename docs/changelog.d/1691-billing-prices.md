- **The billing page shows each plan's price, read from Stripe.** `GET /billing/prices` returns
  every configured `STRIPE_PRICE_*` as Stripe itself states it — amount (minor units), currency,
  interval — cached for five minutes, so a price edited in Stripe reaches the page without a
  redeploy. A price Stripe won't return, or one billed on a different interval than the env var
  it was configured under, is logged and left out rather than shown wrong. The dashboard's plan
  cards show it ("$5 / month"), and on the Yearly tab the saving over twelve monthly payments
  ("$50 / year · save 17%"). See [Subscribe, manage billing, and receive plan changes](/how-to/billing#show-the-prices).
