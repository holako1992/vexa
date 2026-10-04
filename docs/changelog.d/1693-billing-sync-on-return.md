- **The billing page confirms a purchase the moment Stripe sends the person back.** New
  `POST /billing/sync` records the caller's subscription as Stripe holds it right now (the
  webhook's own re-read); the dashboard calls it on `?checkout=success` and shows "Payment
  received — you're on Pro monthly", or, if Stripe hasn't finished after about half a minute, that
  the plan is still activating. `?checkout=cancelled` says nothing was charged. A Stripe customer
  deleted in the Stripe dashboard is replaced on the next checkout instead of failing it, and a
  Stripe refusal now shows Stripe's reason in the dashboard rather than "backend unreachable".
  See [Confirm a purchase on return from Checkout](/how-to/billing#confirm-a-purchase-on-return-from-checkout).
