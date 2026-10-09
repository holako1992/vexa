- **The account page shows the name from Google or Microsoft sign-in.** The dashboard now creates
  an account with the sign-in provider's display name, and fills it in on the next sign-in for an
  account that has none; a name already stored is never replaced. `PATCH /admin/users/{id}` accepts
  `name` (trimmed, at most 100 characters, blank refused).
