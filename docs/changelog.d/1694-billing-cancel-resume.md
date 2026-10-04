- **Cancel and resume a subscription from the billing page.** `POST /billing/cancel` ends the
  caller's subscription when its paid period ends — the plan stays in force until then, nothing
  more is charged, and any pending plan switch is called off — and `POST /billing/resume` calls it
  off. The billing page's "Manage subscription" button is replaced by "Cancel subscription" (with a
  confirmation stating the end date) or "Resume subscription", plus a small "Payment method &
  invoices" link to the Stripe portal. See [Cancel, and resume](/how-to/billing#cancel-and-resume).
