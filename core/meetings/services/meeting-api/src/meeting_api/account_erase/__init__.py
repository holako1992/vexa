"""account_erase — the meetings domain's account erasure (``POST /internal/accounts/{id}/erase``).

Front door (P6): import from here, never a deep module path.

Public surface:
  * ``build_router(eraser)`` — the mountable internal route.
  * ``AccountEraser`` / ``EraseFailed`` — the erasure flow and its staged failure.
  * ``AccountEraseRepo`` — the meeting-store port; ``adapters.SqlAlchemyAccountEraseRepo`` is the
    Postgres implementation, ``fakes.InMemoryAccountEraseRepo`` the offline one.
"""
from __future__ import annotations

from . import fakes
from .ports import AccountEraseRepo
from .router import build_router
from .service import AccountEraser, EraseFailed

__all__ = ["AccountEraser", "AccountEraseRepo", "EraseFailed", "build_router"]
