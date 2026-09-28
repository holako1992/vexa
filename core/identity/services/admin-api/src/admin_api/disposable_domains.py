"""The trial-abuse floor: the disposable-email-domain check for `POST /admin/users`.

Refuses sign-up (never an existing account — see `main.py:create_user`) when the address's
registrable domain, or any of its subdomains, is a known disposable/throwaway mail provider. This
is the ONE place a person is created (`main.py:create_user`'s "the one point a person enters"),
so this is the point of introduction for the block — never a dashboard-side filter the core has
no way to enforce for a caller that skips the dashboard.

**The list** (`data/disposable_email_domains.txt`) is vendored verbatim from
https://github.com/disposable-email-domains/disposable-email-domains (commit
`0655284b6a0b5c674789756ce8b6b35441b800bc`, 2026-09-27), licensed CC0 1.0 Universal — ADR-0004
lists `CC0-1.0` as Category A (auto-allowed), so this needs no `license-exceptions.json` entry.
~9.2k actively-maintained entries, one domain per line, `#`-comments and blank lines ignored.

**Matching** is registrable-domain-and-subdomains, case-insensitive: `Foo@Mailinator.com` and
`user@sub.mailinator.com` both match a listed `mailinator.com`. It does NOT match `notmailinator.com`
(no dot boundary) or a domain that merely CONTAINS a listed one as a substring.

**Operator escape hatches**, both read at call time (never cached across a boot the way
`config_preflight`'s capability probes are — see its module docstring for why: an env-level
kill switch must observe the truth on every request, not a snapshot):

  * `SIGNUP_ALLOW_DISPOSABLE=true` — disables the block entirely. For a self-host that wants no
    such gate (e.g. an internal deployment with no public sign-up), or during an incident where
    the list is producing false positives and a fix is more valuable than a hard stop.
  * `SIGNUP_DISPOSABLE_EXTRA_DOMAINS` — a comma-separated list of additional domains to treat as
    disposable, ADDED to the vendored list rather than replacing it. For an operator who has seen
    an abuse pattern the upstream list has not caught up to yet, with no code change or redeploy.

Existing users are NEVER affected: this module is consulted only by the create path, never by
`GET /admin/users/email/{email}` or `/internal/validate` — a person who already has an account
keeps it even if their domain is added to the list later.
"""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import FrozenSet

_DATA_PATH = Path(__file__).resolve().parent / "data" / "disposable_email_domains.txt"


def _parse(text: str) -> FrozenSet[str]:
    domains = set()
    for line in text.splitlines():
        line = line.strip().lower()
        if not line or line.startswith("#"):
            continue
        domains.add(line)
    return frozenset(domains)


@lru_cache(maxsize=1)
def _vendored_domains() -> FrozenSet[str]:
    """The vendored list, parsed once — it is a static file shipped with the service, not
    something a deployment edits in place. `SIGNUP_DISPOSABLE_EXTRA_DOMAINS` is the operator's
    way to add entries without touching this file or the image."""
    return _parse(_DATA_PATH.read_text(encoding="utf-8"))


def _extra_domains() -> FrozenSet[str]:
    """Read at call time, deliberately uncached: an operator's edit to the env must take effect
    on the next request, the same posture `config_preflight` takes for its capability reads."""
    raw = os.environ.get("SIGNUP_DISPOSABLE_EXTRA_DOMAINS", "")
    return frozenset(
        d.strip().lower() for d in raw.split(",") if d.strip()
    )


def signup_block_disabled() -> bool:
    """`SIGNUP_ALLOW_DISPOSABLE=true` — the operator override. Any other value (unset, empty,
    a typo) leaves the block ON: same fail-safe posture as `_as_flag`'s callers elsewhere in this
    service — an unrecognized value is never treated as an explicit opt-out."""
    return os.environ.get("SIGNUP_ALLOW_DISPOSABLE", "").strip().lower() == "true"


def _domain_of(email: str) -> str:
    return (email or "").strip().lower().rsplit("@", 1)[-1]


def is_disposable_domain(email: str) -> bool:
    """True when `email`'s domain, or any parent of it, is in the vendored list or the operator's
    extra list. `sub.mailinator.com` matches a listed `mailinator.com`; `notmailinator.com` does
    not (dot-boundary walk, never a substring test)."""
    domain = _domain_of(email)
    if not domain:
        return False
    blocked = _vendored_domains() | _extra_domains()
    labels = domain.split(".")
    for i in range(len(labels) - 1):
        if ".".join(labels[i:]) in blocked:
            return True
    return False
