# data — vendored reference data admin-api ships with its image

- `disposable_email_domains.txt` — DB-76 trial-abuse floor: the disposable/throwaway
  email-domain blocklist `disposable_domains.py` matches sign-ups against. Vendored verbatim
  from https://github.com/disposable-email-domains/disposable-email-domains (CC0 1.0 — ADR-0004
  Category A, no `license-exceptions.json` entry needed). One domain per line, lowercase; lines
  starting with `#` and blank lines are ignored by the parser. Do not hand-edit for an
  operator-specific addition — that is what `SIGNUP_DISPOSABLE_EXTRA_DOMAINS` exists to avoid;
  this file only changes on a deliberate re-vendor of the upstream list.

_Governed by `docs/docs/governance/architecture.mdx` (P1–P12). This folder owns one concern; its public surface is its `index`/contract; it may depend only on what the dependency-rules allow._
