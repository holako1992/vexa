"""The billing domain, built inside identity (DB-70).

`events.py`'s comment on `DEFAULT_SEAT` says identity has no seat model and "a billing domain
that needs tiers reads them from wherever it prices, not from here." This package IS that
domain: `catalog.py` states the plans as data, `entitlements.py` resolves a user's stored
billing fields (`PlatformBillingDataPatch`, in `users.data`) against that catalog into what the
rest of the platform enforces against, and `ports.py` defines the usage seam DB-71's meter
fills in. Nothing here reads from identity's own user/org tables beyond the JSON blob it is
handed — the resolver takes its input as plain data, which is what makes it importable by
DB-72 (spawn-time enforcement) without going anywhere near a request or a session.
"""
