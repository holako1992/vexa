"""``POST /internal/accounts/{user_id}/erase`` — the service-to-service erasure route.

Auth is the internal tier: ``X-Internal-Secret`` must equal ``INTERNAL_API_SECRET``. An unset secret
closes the route (503) and a wrong or missing header is refused (403) — the same convention as
admin-api's ``/internal/*`` routes. The gateway has no route to this path.
"""
from __future__ import annotations

import hmac
import os
from typing import Optional

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import JSONResponse

from .service import AccountEraser, EraseFailed


def build_router(eraser: AccountEraser) -> APIRouter:
    router = APIRouter()

    @router.post("/internal/accounts/{user_id}/erase", include_in_schema=False)
    async def erase_account(user_id: str, x_internal_secret: Optional[str] = Header(default=None)):
        secret = os.getenv("INTERNAL_API_SECRET")
        if not secret:
            raise HTTPException(status_code=503, detail="Internal API secret not configured")
        if not x_internal_secret or not hmac.compare_digest(x_internal_secret, secret):
            raise HTTPException(status_code=403, detail="Invalid internal secret")
        if not user_id.isdigit() or int(user_id) <= 0:
            raise HTTPException(status_code=422, detail="user_id must be a positive integer")
        try:
            return JSONResponse(content=await eraser.erase(int(user_id)))
        except EraseFailed as e:
            return JSONResponse(status_code=500, content={"error": e.message, "stage": e.stage})

    return router
