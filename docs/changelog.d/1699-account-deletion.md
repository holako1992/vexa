- **Delete an account, immediately (#1699).** `DELETE /admin/users/{user_id}` (admin key) erases an
  account end to end: its keys, meetings, transcripts and recordings, calendar connections (Google
  tokens revoked), agent workspace, flows data and Stripe customer. A live subscription is cancelled
  at once with no refund. The account is locked while it runs and a failed stage answers `502
  partial` so the same call resumes. The instance's only admin cannot be deleted. See
  [Deleting an account](/api/settings#deleting-an-account).
