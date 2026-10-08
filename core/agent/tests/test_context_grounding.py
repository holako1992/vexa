"""_context_grounding — the terminal-state context-bundle orchestrator (slice 1).

Prompt = [ambient <schedule> digest (surface-gated)] + [focus fold] + user prompt.
Covers: the ambient gate matrix (explicit toggle beats surface), meeting-focus SERVER-ROW
enrichment (a cold client store must not ground a planned meeting as live — the regression this
slice fixes), workspace focus (fail-closed on unknown slug), today focus (full-day digest
replaces ambient), and back-compat (legacy ``active``-only bodies behave exactly as before;
``context.focus: null`` suppresses grounding).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace


def _soon(hours=2):
    """A stable-by-construction future timestamp: the digest windows rows against the REAL
    clock, so fixture dates must be relative — a literal date rots the day after it is
    written (the 2026-07-09 flake this replaces)."""
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

from control_plane.api import ChatBody, ChatContextBody, _ambient_gated, _context_grounding


def _body(prompt="hi", active=None, context=None):
    return ChatBody(prompt=prompt, active=active,
                    context=ChatContextBody(**context) if context is not None else None)


def _ground(body, *, rows=None, mounts=None, owner=None, redis_url=None):
    return _context_grounding(
        body, "s1", redis_url,
        schedule_rows=lambda: rows or [],
        workspace_mounts=lambda: mounts or [],
        meeting_owner=owner or (lambda _mid: None),
    )


def _sched_row(rid=51, status="scheduled", title="Acme intro", native="abc-defg-hij"):
    return {"id": rid, "status": status, "platform": "google_meet", "native_meeting_id": native,
            "data": {"title": title, "scheduled_at": _soon(),
                     "workspace_id": "acme-deal"},
            "end_time": None, "start_time": None, "updated_at": None}


# ── ambient gate matrix ───────────────────────────────────────────────────────────────

def test_gate_no_context_is_off():
    assert _ambient_gated(None) is False


def test_gate_surface_meetings_list_on_doc_tab_off():
    assert _ambient_gated(ChatContextBody(surface={"list": "meetings"})) is True
    assert _ambient_gated(ChatContextBody(surface={"list": "files", "tab": {"kind": "doc"}})) is False
    for kind in ("today", "meeting", "meetingPrep"):
        assert _ambient_gated(ChatContextBody(surface={"tab": {"kind": kind}})) is True


def test_gate_explicit_toggle_beats_surface():
    on_surface = {"list": "meetings"}
    assert _ambient_gated(ChatContextBody(surface=on_surface, include={"schedule": False})) is False
    assert _ambient_gated(ChatContextBody(surface={"list": "files"}, include={"schedule": True})) is True


# ── ambient digest in the prompt ──────────────────────────────────────────────────────

def test_ambient_digest_prepended_when_gated():
    body = _body(context={"tz": "UTC", "surface": {"list": "meetings"}})
    _c, _t, prompt = _ground(body, rows=[_sched_row()])
    assert prompt.startswith("<schedule ")
    assert '"Acme intro"' in prompt
    assert "my next meeting" in prompt        # the schedule steering line
    assert prompt.endswith("hi")


def test_no_digest_when_gated_off_or_rows_empty():
    off = _body(context={"surface": {"list": "files"}})
    assert _ground(off, rows=[_sched_row()])[2] == "hi"
    on_empty = _body(context={"surface": {"list": "meetings"}})
    assert _ground(on_empty, rows=[])[2] == "hi"


def test_schedule_rows_failure_never_fails_the_turn():
    body = _body(context={"surface": {"list": "meetings"}})

    def boom():
        raise OSError("meeting-api down")

    _c, _t, prompt = _context_grounding(body, "s1", None, schedule_rows=boom,
                                        workspace_mounts=lambda: [],
                                        meeting_owner=lambda _mid: None)
    assert prompt == "hi"


# ── meeting focus: server-row enrichment (the cold-store regression fix) ──────────────

def test_planned_meeting_grounds_prep_even_with_statusless_client_focus():
    # client store was cold: no status/title sent — the SERVER row says scheduled
    focus = {"kind": "meeting", "native_id": "abc-defg-hij", "platform": "google_meet"}
    body = _body(context={"surface": {"tab": {"kind": "meetingPrep"}}, "focus": focus})
    _c, _t, prompt = _ground(body, rows=[_sched_row()])
    assert "PREPARE" in prompt                # prep steering, not the live fold
    assert '"Acme intro"' in prompt
    assert "acme-deal" in prompt


def test_linkless_planned_row_enriches_via_row_id_in_native_slot():
    """The terminal's tab param is the ROW id; a link-less planned meeting has NO native id, so
    the id arrives in native_id — enrichment must still find the row (the live-verify gap)."""
    row = {"id": 76, "status": "scheduled", "platform": "unknown", "native_meeting_id": None,
           "data": {"title": "Context bundle smoke", "scheduled_at": _soon(3)},
           "end_time": None, "start_time": None, "updated_at": None}
    focus = {"kind": "meeting", "native_id": "76", "platform": "google_meet"}
    body = _body(context={"surface": {"tab": {"kind": "meetingPrep"}}, "focus": focus})
    _c, _t, prompt = _ground(body, rows=[row])
    assert "PREPARE" in prompt and "Context bundle smoke" in prompt
    assert "live meeting" not in prompt


def test_client_status_loses_to_server_row():
    focus = {"kind": "meeting", "native_id": "abc-defg-hij", "platform": "google_meet",
             "status": "active"}              # client asserts live; server says scheduled
    body = _body(context={"focus": focus, "surface": {"tab": {"kind": "meeting"}}})
    _c, _t, prompt = _ground(body, rows=[_sched_row()])
    assert "PREPARE" in prompt


def test_meeting_focus_without_rows_falls_back_to_client_fields():
    focus = {"kind": "meeting", "native_id": "abc-defg-hij", "platform": "google_meet",
             "status": "scheduled", "title": "Client title"}
    body = _body(context={"focus": focus})
    _c, _t, prompt = _ground(body, rows=[])
    assert "PREPARE" in prompt and "Client title" in prompt


# ── workspace focus ───────────────────────────────────────────────────────────────────

def test_workspace_focus_folds_purpose_and_readme(tmp_path):
    ws = tmp_path / "acme-deal"
    ws.mkdir()
    (ws / "README.md").write_text("# Acme deal\nEverything about Acme.", encoding="utf-8")
    mount = SimpleNamespace(slug="acme-deal", workspace_id="acme-deal", name="Acme deal",
                            path=str(ws))
    body = _body(context={"focus": {"kind": "workspace", "slug": "acme-deal"}})
    _c, _t, prompt = _ground(body, mounts=[mount])
    assert 'workspace "Acme deal" (acme-deal)' in prompt
    assert "Everything about Acme." in prompt
    assert prompt.endswith("hi")


def test_workspace_focus_unknown_slug_folds_nothing():
    body = _body(context={"focus": {"kind": "workspace", "slug": "not-mine"}})
    assert _ground(body, mounts=[])[2] == "hi"


def test_workspace_focus_no_readme_is_honest(tmp_path):
    ws = tmp_path / "empty-ws"
    ws.mkdir()
    mount = SimpleNamespace(slug="empty-ws", workspace_id="empty-ws", name="Empty", path=str(ws))
    body = _body(context={"focus": {"kind": "workspace", "slug": "empty-ws"}})
    _c, _t, prompt = _ground(body, mounts=[mount])
    assert "no README yet" in prompt


# ── today focus ───────────────────────────────────────────────────────────────────────

def test_today_focus_uses_full_day_digest_and_replaces_ambient():
    body = _body(context={"tz": "UTC", "surface": {"tab": {"kind": "today"}},
                          "focus": {"kind": "today"}})
    row_past = {"id": 1, "status": "completed", "platform": "google_meet",
                "native_meeting_id": "x", "data": {"title": "standup"},
                "end_time": None, "start_time": None, "updated_at": None}
    _c, _t, prompt = _ground(body, rows=[_sched_row(), row_past])
    assert prompt.count("<schedule tz=") == 1  # ONE digest block (full-day), not ambient+focus
    assert "ended today:" not in prompt        # past row has no timestamps -> honest omission


# ── back-compat ───────────────────────────────────────────────────────────────────────

def test_legacy_active_only_body_unchanged():
    active = {"kind": "meeting", "native_id": "abc", "platform": "google_meet",
              "status": "scheduled", "title": "Legacy"}
    body = _body(active=active)               # no context at all
    _c, _t, prompt = _ground(body, rows=[])
    assert "PREPARE" in prompt and "Legacy" in prompt
    assert "<schedule" not in prompt          # legacy clients never get the digest


def test_context_focus_null_suppresses_legacy_active():
    active = {"kind": "meeting", "native_id": "abc", "platform": "google_meet"}
    body = _body(active=active, context={"focus": None, "surface": {"list": "files"}})
    assert _ground(body)[2] == "hi"


def test_file_focus_untouched():
    body = _body(context={"focus": {"kind": "file", "ref": "@file:notes.md"},
                          "surface": {"tab": {"kind": "doc"}}})
    assert _ground(body)[2] == "hi"


# ── authorization: a meeting focus folds only a row the caller may read ───────────────

_SECRET = "Our acquisition price is 42M"


def _seeded(monkeypatch, row_id="9001"):
    import json

    import fakeredis
    import redis

    r = fakeredis.FakeRedis(decode_responses=True)
    r.xadd(f"proc:meeting:{row_id}", {"note": json.dumps({"id": "n1", "speaker": "Alice", "text": _SECRET})})
    r.xadd(f"tc:meeting:{row_id}", {"payload": json.dumps({"type": "transcription", "segments": [
        {"segment_id": "s1", "speaker": "Alice", "text": _SECRET}]})})
    monkeypatch.setattr(redis, "from_url", lambda *a, **k: r)
    return "redis://fake"


def _own_row(rid=5, status="completed", native="bbb-own"):
    return {"id": rid, "status": status, "platform": "google_meet", "native_meeting_id": native,
            "data": {}, "end_time": None, "start_time": None, "updated_at": None}


def _foreign_focus(**over):
    focus = {"kind": "meeting", "meeting_id": "9001", "native_id": "x", "platform": "google_meet",
             "status": "completed"}
    focus.update(over)
    return focus


def test_foreign_row_id_folds_nothing_when_the_owner_lookup_refuses(monkeypatch):
    """Another tenant's row id, absent from the caller's rows and refused by the meetings domain,
    folds nothing — the cross-tenant read this guards."""
    url = _seeded(monkeypatch)
    asked = []
    body = _body(context={"focus": _foreign_focus()})
    _c, _t, prompt = _ground(body, rows=[_own_row()], redis_url=url,
                             owner=lambda mid: asked.append(mid) or None)
    assert _SECRET not in prompt
    assert prompt == "hi"
    assert asked == ["9001"]                  # the meetings domain was asked, and said no


def test_foreign_row_id_in_the_native_slot_folds_nothing(monkeypatch):
    url = _seeded(monkeypatch)
    body = _body(context={"focus": {"kind": "meeting", "native_id": "9001", "status": "active"}})
    assert _SECRET not in _ground(body, rows=[], redis_url=url)[2]


def test_legacy_active_naming_a_foreign_row_folds_nothing(monkeypatch):
    url = _seeded(monkeypatch)
    body = _body(active=_foreign_focus())
    assert _SECRET not in _ground(body, rows=[], redis_url=url)[2]


def test_failed_rows_fetch_and_failed_owner_lookup_fold_nothing(monkeypatch):
    url = _seeded(monkeypatch)
    body = _body(context={"focus": _foreign_focus()})

    def boom(_mid):
        raise OSError("meeting-api down")

    _c, _t, prompt = _context_grounding(
        body, "s1", url, schedule_rows=lambda: (_ for _ in ()).throw(OSError("down")),
        workspace_mounts=lambda: [], meeting_owner=boom)
    assert _SECRET not in prompt and prompt == "hi"


def test_owner_lookup_answering_a_different_row_folds_nothing(monkeypatch):
    url = _seeded(monkeypatch)
    body = _body(context={"focus": _foreign_focus()})
    _c, _t, prompt = _ground(body, rows=[], redis_url=url,
                             owner=lambda _mid: _own_row(rid=5))
    assert _SECRET not in prompt


def test_a_row_the_meetings_domain_confirms_is_folded(monkeypatch):
    """A row outside the bounded schedule window but confirmed by the meetings domain (an old
    meeting the caller owns) still grounds the chat."""
    url = _seeded(monkeypatch)
    body = _body(context={"focus": _foreign_focus()})
    _c, _t, prompt = _ground(body, rows=[], redis_url=url,
                             owner=lambda mid: _own_row(rid=int(mid), native="x"))
    assert _SECRET in prompt and prompt.endswith("hi")


def test_own_native_with_a_foreign_row_id_reads_only_the_own_row(monkeypatch):
    """A focus pairing the caller's own native id with another tenant's row id resolves to the
    caller's row, so only that row's streams are read."""
    url = _seeded(monkeypatch)
    body = _body(context={"focus": _foreign_focus(native_id="bbb-own")})
    _c, _t, prompt = _ground(body, rows=[_own_row(rid=5, status="active")], redis_url=url,
                             owner=lambda _mid: None)
    assert _SECRET not in prompt
