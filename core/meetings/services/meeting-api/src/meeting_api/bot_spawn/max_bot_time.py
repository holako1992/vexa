"""Per-plan per-meeting minute cap — the pure resolution the spawn path applies to
``automatic_leave.max_bot_time`` before it reaches the bot.

Three independent ceilings can bound how long a single bot may stay active:

  * the **deployment** knob ``BOT_MAX_ACTIVE_MS`` (env, default 4h) — read by the BOT ITSELF
    (``deriveMaxActiveMs`` in ``services/bot/src/index.ts``), never by meeting-api;
  * the **plan**'s ``max_minutes_per_meeting`` (Free 60, Pro/Team 240 — ``billing/catalog.py``,
    core/identity), surfaced to meeting-api on the SAME best-effort ``bot_context`` fetch
    ``request_bot`` already makes for the monthly-meeting quota (no second admin-api call);
  * the **caller**'s own ``automatic_leave.max_bot_time`` on ``POST /bots`` (or an auto-joined
    occurrence's stored override).

This module resolves the second and third into ONE number — the ``automaticLeave.maxBotTime`` the
invocation carries — by taking their MINIMUM: a plan's cap is a ceiling nobody may raise by asking
nicely, but a caller may always ask for something SHORTER. The bot then takes the min of THAT and
its own deployment env cap (``deriveMaxActiveMs``), so the effective ceiling ends up being the min
of all three without meeting-api ever needing to read the bot's env var.

``None`` at either input means "no ceiling from that source" (the plan is unlimited, or the caller
named none) — never coerced to 0, which would forbid the bot from ever going active at all.
"""
from __future__ import annotations

from typing import Optional

MS_PER_MINUTE = 60_000


def resolve_max_bot_time_ms(
    *,
    caller_max_bot_time_ms: Optional[int],
    plan_max_minutes_per_meeting: Optional[int],
) -> Optional[int]:
    """``min(plan cap, caller cap)`` in ms, or ``None`` when NEITHER names one.

    ``plan_max_minutes_per_meeting`` is the resolved plan's own field (``PlanLimits
    .max_minutes_per_meeting`` — ``None`` means that plan is unlimited; an unrecognized plan id
    resolves to Free's 60 BEFORE this function ever sees it — ``billing.catalog.get_plan``'s own
    contract, core/identity). ``caller_max_bot_time_ms`` is already in ms (api.v1's
    ``automatic_leave.max_bot_time`` — the wire unit for every ``automatic_leave`` field).

    A ``None`` result means the bot's own deployment-wide ``BOT_MAX_ACTIVE_MS`` (default 4h)
    applies alone — this function never invents a cap where both sources are silent."""
    plan_ms = (
        plan_max_minutes_per_meeting * MS_PER_MINUTE
        if plan_max_minutes_per_meeting is not None
        else None
    )
    candidates = [v for v in (caller_max_bot_time_ms, plan_ms) if v is not None]
    return min(candidates) if candidates else None
