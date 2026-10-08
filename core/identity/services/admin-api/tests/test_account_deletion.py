"""DELETE /admin/users/{id} — immediate account deletion, orchestrated by identity.

Real Postgres + the real FastAPI app. The three downstream erasure endpoints are faked behind an
``httpx.MockTransport`` (the module's single client seam), Stripe is a recording fake, and the
flows publish is recorded. Nothing here touches a network.
"""
import asyncio

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text

from admin_api.app import account_deletion as ad
from admin_api.app import db as app_db
from admin_api.app import events as events_mod
from admin_api.app import main as main_mod
from admin_api.app.billing.stripe_gateway import StripeAPIError
from admin_api.app.main import create_app
from admin_api.schema.models import Base
from admin_api.schema.sync import ensure_schema_sync

from conftest import requires_docker

pytestmark = requires_docker

ADMIN = {"X-Admin-API-Key": "test-admin-token"}
SECRET = "test-internal-secret"
MEETING = "http://meeting-api.test"
AGENT = "http://agent-api.test"
FLOWS = "http://flows-api.test"


class FakeDomains:
    """The three erasure endpoints. ``fail`` holds the domains currently answering 500."""

    def __init__(self):
        self.calls = []
        self.fail = set()

    def handler(self, request: httpx.Request) -> httpx.Response:
        host = request.url.host.split(".")[0]
        name = {"meeting-api": "meetings", "agent-api": "agent", "flows-api": "flows"}[host]
        import json
        body = json.loads(request.content or b"{}")
        self.calls.append((name, request.url.path, request.headers.get("x-internal-secret"), body))
        if name in self.fail:
            return httpx.Response(500, json={"error": "boom", "stage": "storage"})
        return httpx.Response(200, json={"erased": {"rows": 3}})

    def names(self):
        return [c[0] for c in self.calls]


class FakeStripe:
    def __init__(self, subs=None, fail_cancel=False):
        self.subs = subs or []
        self.fail_cancel = fail_cancel
        self.cancelled = []
        self.deleted = []

    async def list_subscriptions(self, customer_id):
        return self.subs

    async def cancel_subscription(self, sid):
        if self.fail_cancel:
            raise StripeAPIError(500, "stripe down")
        self.cancelled.append(sid)
        return {}

    async def delete_customer(self, cid):
        self.deleted.append(cid)
        return {}


@pytest.fixture()
def env(pg_url, pg_async_url, monkeypatch):
    sync_engine = create_engine(pg_url)
    Base.metadata.drop_all(sync_engine)
    ensure_schema_sync(sync_engine, Base)
    monkeypatch.setenv("ADMIN_API_TOKEN", "test-admin-token")
    monkeypatch.setenv("INTERNAL_API_SECRET", SECRET)
    monkeypatch.setenv("DEV_MODE", "false")
    monkeypatch.setenv("VEXA_MEETING_API_URL", MEETING)
    monkeypatch.setenv("VEXA_AGENT_API_URL", AGENT)
    monkeypatch.setenv("VEXA_FLOWS_API_URL", FLOWS)
    monkeypatch.delenv("FLOWS_API_URL", raising=False)
    monkeypatch.delenv("STRIPE_SECRET_KEY", raising=False)

    domains = FakeDomains()
    monkeypatch.setattr(
        ad, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(domains.handler)))
    published = []

    async def fake_publish(event_type, source_id, refs, **kw):
        if event_type != events_mod.EVENT_ONBOARDING_COMPLETED:
            published.append((event_type, source_id, refs))
        return True

    monkeypatch.setattr(events_mod, "publish", fake_publish)

    app_db.configure(pg_async_url)
    with TestClient(create_app()) as c:
        yield c, domains, published, sync_engine, monkeypatch
    try:
        loop = asyncio.new_event_loop()
        loop.run_until_complete(app_db.get_engine().dispose())
        loop.close()
    except Exception:
        pass
    sync_engine.dispose()


def _user(c, email="a@example.com"):
    r = c.post("/admin/users", json={"email": email, "name": "A"}, headers=ADMIN)
    assert r.status_code == 201, r.text
    return r.json()["id"]


def _token(c, uid, scope="bot"):
    r = c.post(f"/admin/users/{uid}/tokens", params={"scope": scope}, headers=ADMIN)
    assert r.status_code == 201, r.text
    return r.json()["token"]


def _validate(c, token):
    return c.post("/internal/validate", json={"token": token},
                  headers={"X-Internal-Secret": SECRET})


def _count(engine, table, uid=None):
    q = f"select count(*) from {table}" + (f" where {'id' if table == 'users' else 'user_id'}={uid}" if uid else "")
    with engine.connect() as conn:
        return conn.execute(text(q)).scalar()


def test_full_success_path(env):
    c, domains, published, engine, mp = env
    keep = _user(c, "other@example.com")
    keep_token = _token(c, keep)
    uid = _user(c)
    t1, t2 = _token(c, uid, "bot"), _token(c, uid, "tx")
    assert _validate(c, t1).status_code == 200

    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "deleted" and body["user_id"] == uid
    assert set(body["erased"]) == {"identity", "meetings", "agent", "flows"}
    assert body["erased"]["identity"]["tokens_revoked"] == 2
    assert body["erased"]["meetings"] == {"rows": 3}

    # every downstream called once, with this id and the internal secret
    assert sorted(domains.names()) == ["agent", "flows", "meetings"]
    for _, path, secret, _body in domains.calls:
        assert path == f"/internal/accounts/{uid}/erase"
        assert secret == SECRET
    flows_body = [b for n, _, _, b in domains.calls if n == "flows"][0]
    assert flows_body == {"emails": ["a@example.com"]}

    # row and tokens gone; the other user untouched
    assert _count(engine, "users", uid) == 0
    assert _count(engine, "api_tokens", uid) == 0
    assert _validate(c, t1).status_code == 401
    assert _validate(c, keep_token).status_code == 200
    assert c.get(f"/admin/users/{keep}", headers=ADMIN).status_code == 200

    # the fact: id only, no address
    assert published == [("account.deleted", f"account-deleted-{uid}", {"subject": str(uid)})]
    assert "example.com" not in repr(published)

    # a repeat call is harmless
    assert c.delete(f"/admin/users/{uid}", headers=ADMIN).status_code == 404


def test_downstream_failure_is_partial_locked_and_resumable(env):
    c, domains, published, engine, mp = env
    uid = _user(c)
    token = _token(c, uid)
    domains.fail.add("agent")

    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 502
    assert r.json()["error"] == "partial" and r.json()["pending"] == ["agent"]
    assert published == []

    # locked: the row is still there, but nothing gets in
    assert _count(engine, "users", uid) == 1
    assert _count(engine, "api_tokens", uid) == 0
    assert _validate(c, token).status_code == 401
    assert c.post("/admin/users", json={"email": "a@example.com"}, headers=ADMIN).status_code == 409
    assert c.get("/admin/users/email/a@example.com", headers=ADMIN).status_code == 409
    assert c.post(f"/admin/users/{uid}/tokens", headers=ADMIN).status_code == 409
    assert c.post("/internal/validate", json={"token": token},
                  headers={"X-Internal-Secret": SECRET}).status_code == 401

    # retry after the domain recovers: finished parts are skipped
    domains.fail.clear()
    domains.calls.clear()
    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 200, r.text
    assert domains.names() == ["agent"]
    assert r.json()["erased"]["meetings"] == {"rows": 3}   # remembered from the first pass
    assert _count(engine, "users", uid) == 0
    assert len(published) == 1


def test_missing_meeting_url_is_pending_not_silent(env):
    c, domains, published, engine, mp = env
    mp.delenv("VEXA_MEETING_API_URL")
    uid = _user(c)
    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 502 and r.json()["pending"] == ["meetings"]
    assert _count(engine, "users", uid) == 1


def test_flows_erase_url_erases_flows_even_with_the_publish_edge_off(env):
    """An empty publish edge means "publish no facts", not "no flows data": the erase URL still
    reaches flows, with the address in the body."""
    c, domains, published, engine, mp = env
    mp.delenv("VEXA_FLOWS_API_URL")
    mp.setenv("VEXA_FLOWS_ERASE_URL", FLOWS)
    uid = _user(c)
    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 200
    flows_calls = [call for call in domains.calls if call[0] == "flows"]
    assert len(flows_calls) == 1
    assert flows_calls[0][1] == f"/internal/accounts/{uid}/erase"
    assert flows_calls[0][2] == SECRET
    assert flows_calls[0][3] == {"emails": ["a@example.com"]}


def test_no_flows_domain_is_a_profile_not_a_failure(env):
    c, domains, published, engine, mp = env
    mp.delenv("VEXA_FLOWS_API_URL")
    mp.delenv("VEXA_FLOWS_ERASE_URL", raising=False)
    uid = _user(c)
    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 200
    assert "flows" not in domains.names()


def test_stripe_live_subscription_cancelled_immediately_and_customer_deleted(env):
    c, domains, published, engine, mp = env
    mp.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    fake = FakeStripe(subs=[{"id": "sub_live", "status": "active"},
                            {"id": "sub_old", "status": "canceled"}])
    mp.setattr(main_mod, "_stripe_client", lambda: fake)
    uid = _user(c)
    with engine.begin() as conn:
        conn.execute(text("update users set data = data || '{\"stripe_customer_id\": \"cus_1\"}'::jsonb "
                          "where id=:i"), {"i": uid})
    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 200, r.text
    assert fake.cancelled == ["sub_live"]
    assert fake.deleted == ["cus_1"]
    assert r.json()["erased"]["identity"]["billing"] == {
        "subscriptions_cancelled": 1, "customer_deleted": True}


def test_stripe_failure_is_a_pending_billing_partial(env):
    c, domains, published, engine, mp = env
    mp.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    fake = FakeStripe(subs=[{"id": "sub_live", "status": "active"}], fail_cancel=True)
    mp.setattr(main_mod, "_stripe_client", lambda: fake)
    uid = _user(c)
    with engine.begin() as conn:
        conn.execute(text("update users set data = data || '{\"stripe_customer_id\": \"cus_1\"}'::jsonb "
                          "where id=:i"), {"i": uid})
    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 502 and r.json()["pending"] == ["billing"]
    assert fake.deleted == []
    assert _count(engine, "users", uid) == 1
    # the other domains were still erased in the same pass
    assert sorted(domains.names()) == ["agent", "flows", "meetings"]

    fake.fail_cancel = False
    domains.calls.clear()
    assert c.delete(f"/admin/users/{uid}", headers=ADMIN).status_code == 200
    assert fake.deleted == ["cus_1"] and domains.names() == []


def test_google_refresh_token_is_revoked_best_effort(env):
    c, domains, published, engine, mp = env
    from admin_api.app import google_oauth, token_cipher
    uid = _user(c)
    revoked = []

    async def fake_revoke(*, token, timeout_s=10.0):
        revoked.append(token)
        return True

    mp.setattr(google_oauth, "revoke_token", fake_revoke)
    mp.setattr(token_cipher, "decrypt", lambda blob, **kw: "refresh-" + blob)
    import json
    conns = [{"id": "g1", "kind": "google", "google_refresh_token_enc": "enc1"},
             {"id": "m1", "kind": "microsoft", "microsoft_refresh_token_enc": "enc2"}]
    with engine.begin() as conn:
        conn.execute(text("update users set data = data || cast(:d as jsonb) where id=:i"),
                     {"d": json.dumps({"calendar_connections": conns}), "i": uid})
    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 200
    assert revoked == ["refresh-enc1"]
    assert r.json()["erased"]["identity"]["calendar"]["microsoft_not_revocable"] == 1


def test_late_stripe_webhook_for_a_deleting_account_writes_and_emits_nothing(env):
    import hashlib
    import hmac
    import json
    import time
    c, domains, published, engine, mp = env
    mp.setenv("STRIPE_SECRET_KEY", "sk_test_x")
    mp.setenv("STRIPE_WEBHOOK_SECRET", "whsec_test_only_deletion")
    mp.setenv("STRIPE_PRICE_PRO_MONTHLY", "price_pro_m")
    for k in ("STRIPE_CHECKOUT_SUCCESS_URL", "STRIPE_CHECKOUT_CANCEL_URL", "STRIPE_PORTAL_RETURN_URL"):
        mp.setenv(k, "https://app.example.com/billing")
    sub = {"id": "sub_1", "customer": "cus_1", "status": "active", "cancel_at_period_end": False,
           "current_period_start": 1_700_000_000, "current_period_end": 1_702_592_000,
           "items": {"data": [{"price": {"id": "price_pro_m"}}]}}
    from admin_api.app.billing.stripe_gateway import StripeClient
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=sub))
    # meetings fails below, so the account stays locked when the late webhook arrives
    mp.setattr(main_mod, "_stripe_client", lambda: StripeClient(secret_key="sk", transport=transport))
    uid = _user(c)
    with engine.begin() as conn:
        conn.execute(text("update users set data = data || '{\"stripe_customer_id\": \"cus_1\"}'::jsonb "
                          "where id=:i"), {"i": uid})
    domains.fail.add("meetings")
    assert c.delete(f"/admin/users/{uid}", headers=ADMIN).status_code == 502   # locked, row kept
    published.clear()

    payload = json.dumps({"id": "evt_late", "type": "customer.subscription.updated",
                          "data": {"object": {"id": "sub_1", "customer": "cus_1"}}}).encode()
    ts = int(time.time())
    v1 = hmac.new(b"whsec_test_only_deletion", f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    r = c.post("/billing/webhook", content=payload,
               headers={"Stripe-Signature": f"t={ts},v1={v1}", "Content-Type": "application/json"})
    assert r.status_code == 200 and r.json()["handled"] is False
    assert published == []
    with engine.connect() as conn:
        data = conn.execute(text("select data from users where id=:i"), {"i": uid}).scalar()
    assert "updated_by_webhook" not in data


def test_stripe_client_cancels_without_proration_and_deletes_the_customer():
    from admin_api.app.billing.stripe_gateway import StripeClient
    seen = []

    def handler(request):
        seen.append((request.method, request.url.path, request.content.decode()))
        return httpx.Response(200, json={})

    client = StripeClient(secret_key="sk", transport=httpx.MockTransport(handler))
    asyncio.run(client.cancel_subscription("sub_1"))
    asyncio.run(client.delete_customer("cus_1"))
    assert seen[0][0] == "DELETE" and seen[0][1] == "/v1/subscriptions/sub_1"
    assert "prorate=false" in seen[0][2] and "invoice_now=false" in seen[0][2]
    assert seen[1][:2] == ("DELETE", "/v1/customers/cus_1")


def test_unknown_user_404_and_admin_auth_required(env):
    c, *_ = env
    assert c.delete("/admin/users/99999", headers=ADMIN).status_code == 404
    uid = _user(c)
    assert c.delete(f"/admin/users/{uid}").status_code == 403
    assert c.delete(f"/admin/users/{uid}", headers={"X-Admin-API-Key": "nope"}).status_code == 403
    assert c.get(f"/admin/users/{uid}", headers=ADMIN).status_code == 200


def test_a_token_that_survives_a_race_is_still_refused_by_validate(env):
    c, domains, published, engine, mp = env
    domains.fail.add("agent")
    uid = _user(c)
    assert c.delete(f"/admin/users/{uid}", headers=ADMIN).status_code == 502
    with engine.begin() as conn:
        conn.execute(text("insert into api_tokens (token, user_id, scopes) "
                          "values ('vxa_raced', :i, '{bot}')"), {"i": uid})
    assert _validate(c, "vxa_raced").status_code == 401
    assert c.get("/user/webhook", headers={"X-API-Key": "vxa_raced"}).status_code == 403
    # the resumed deletion removes the straggler too
    domains.fail.clear()
    assert c.delete(f"/admin/users/{uid}", headers=ADMIN).status_code == 200
    assert _count(engine, "api_tokens", uid) == 0


def test_the_only_admin_cannot_be_deleted(env):
    c, domains, published, engine, mp = env
    uid = _user(c)
    with engine.begin() as conn:
        conn.execute(text("update users set data = data || '{\"is_admin\": true}'::jsonb where id=:i"),
                     {"i": uid})
    r = c.delete(f"/admin/users/{uid}", headers=ADMIN)
    assert r.status_code == 409 and r.json()["error"] == "last_admin"
    assert domains.calls == [] and _count(engine, "users", uid) == 1
    # with a second admin it goes through
    other = _user(c, "second@example.com")
    with engine.begin() as conn:
        conn.execute(text("update users set data = data || '{\"is_admin\": true}'::jsonb where id=:i"),
                     {"i": other})
    assert c.delete(f"/admin/users/{uid}", headers=ADMIN).status_code == 200
