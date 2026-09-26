"use client";
/** Hidden admin surface — infra observability (workloads + meeting pipeline + probe) plus the
 *  DB-77 user-overrides form.
 *
 *  HIDDEN: nothing registers at import time. The module probes `/api/admin/me` (server-verified
 *  email allowlist — see app/api/admin/gate.ts); only a 200 registers the "Infra" list + the
 *  "adminInfra" tab, and the contributions registry notifies the shell so the switcher entry
 *  appears. Non-admins never see an entry and every /api/admin/* route answers 404 for them.
 *
 *  Layout: a persistent TRANSCRIPTION GOLDEN PROBE strip (gateway → meeting-api → runtime →
 *  redis carriers → transcript relay; run on demand) above three in-panel tabs — Workloads,
 *  Meeting pipeline (both read-only, client-side filters) and Users (DB-77's support-comp form:
 *  look a user up by email, set `plan_override`/`quota_bonus`/`max_concurrent_bots`, save).
 *  Data: GET /api/admin/overview + POST /api/admin/probe → agent-api (internal tier);
 *  GET/PATCH /api/admin/users[/[id]] → admin-api's admin tier.
 */
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { registerList, registerTab } from "../contributions";
import { useService } from "../platform";
import { LayoutServiceId, type TabDescriptor } from "../workbench/layout";
import { Icon } from "../ui-kit";
import { meetingsOnly } from "../app/mode";

// DB-77 admin overrides — the catalog plan ids a support agent may set as `plan_override`.
// Mirrors `core/identity/services/admin-api/src/admin_api/app/billing/catalog.py`'s `PLANS`
// keys; admin-api itself is the source of truth and rejects anything else with 422 — this list
// is only for the dropdown's options, never trusted as validation.
const CATALOG_PLAN_IDS = ["free", "pro", "team"] as const;

interface StreamStat { len?: number; last_id?: string | null; last_type?: string }
interface PipelineRow {
  meeting_id: string;
  row_keyed?: boolean;
  in_active_meetings?: boolean;
  processing_on?: boolean;
  copilot_cursor?: string | null;
  proc_stream?: StreamStat;
  transcript_stream?: StreamStat;
  pending_drain?: { deadline: number; overdue: boolean };
  live?: { native_id?: string; platform?: string; title?: string; status?: string; last_seen?: number };
}
interface Workload {
  workloadId: string;
  kind?: string;
  meeting_id?: string;
  profile?: string;
  state?: string;
  startedAt?: string;
  stoppedAt?: string;
  exitCode?: number | null;
  stopReason?: string | null;
}
interface Overview {
  workloads?: Workload[];
  workloads_error?: string;
  meetings?: PipelineRow[];
  meetings_error?: string;
}
interface ProbeStage { id: string; label: string; status: "pass" | "warn" | "fail"; latency_ms?: number; detail?: string }
interface ProbeResult { status: "pass" | "warn" | "fail"; stages: ProbeStage[]; duration_ms: number; at: number }

const PANEL: TabDescriptor = { id: "admin-infra", title: "Infra", kind: "adminInfra", params: {} };
const POLL_MS = 5000;

function ago(t?: number): string {
  if (!t) return "—";
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
const isoAgo = (iso?: string) => (iso ? `${ago(Date.parse(iso))} ago` : "—");
/** redis stream ids are `{ms}-{seq}` — the ms half is a wall-clock timestamp. */
const idMs = (id?: string | null): number | null => {
  const ms = id ? Number(id.split("-")[0]) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

type Tone = "ok" | "warn" | "danger";
const TONE: Record<Tone, { fg: string; bg: string }> = {
  ok: { fg: "var(--green)", bg: "var(--greenbg)" },
  warn: { fg: "var(--warn)", bg: "var(--warnbg)" },
  danger: { fg: "var(--danger)", bg: "var(--dangerbg)" },
};

/** One health verdict per meeting row, most severe first (ADR-0027 Train-2-aware):
 *  native keying (S2) → a processed_pending member past its drain deadline (the run-46 S1
 *  signature, LIVE and exact) → still-draining (in the zset, within deadline — expected for
 *  ~2 db-writer ticks after a stop) → the undrained-tail approximation (proc entries newer
 *  than the bot's stop with no view_end marker and out of the sweep) → ok. A proc tail that IS
 *  the worker's view_end marker completed cleanly, so it suppresses the approximation. */
function healthOf(m: PipelineRow, botStopMs: number | null): { label: string; tone: Tone } {
  if (m.row_keyed === false) return { label: "native key (S2)", tone: "danger" };
  if (m.pending_drain) {
    return m.pending_drain.overdue
      ? { label: "stuck drain (S1)", tone: "danger" }
      : { label: "draining…", tone: "warn" };
  }
  const procMs = idMs(m.proc_stream?.last_id);
  if (m.proc_stream?.last_type !== "view_end" &&
      botStopMs && procMs && procMs > botStopMs && !m.in_active_meetings) {
    return { label: "undrained tail?", tone: "warn" };
  }
  return { label: "ok", tone: "ok" };
}

const th: CSSProperties = { textAlign: "left", fontSize: 11, color: "var(--t3)", textTransform: "uppercase", letterSpacing: ".04em", padding: "4px 8px", borderBottom: "1px solid var(--line)", whiteSpace: "nowrap", fontWeight: 500 };
const td: CSSProperties = { fontSize: 12.5, color: "var(--t1)", padding: "5px 8px", borderBottom: "1px solid var(--line)", fontFamily: "var(--mono)", whiteSpace: "nowrap" };
const segBtn = (on: boolean): CSSProperties => ({ fontSize: 12, padding: "3px 10px", borderRadius: 6, border: "1px solid var(--line)", cursor: "pointer", background: on ? "var(--panel2)" : "transparent", color: on ? "var(--t1)" : "var(--t2)" });
const searchStyle: CSSProperties = { width: 210, height: 28, fontSize: 12.5, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel)", color: "var(--t1)", outline: "none" };

function Pill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span style={{ fontSize: 11.5, fontFamily: "var(--sans)", background: TONE[tone].bg, color: TONE[tone].fg, padding: "2px 8px", borderRadius: 999, whiteSpace: "nowrap" }}>
      {label}
    </span>
  );
}

function StateDot({ on }: { on: boolean }) {
  return <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: on ? "var(--green)" : "var(--t3)", marginRight: 6 }} />;
}

function SectionError({ error }: { error?: string | null }) {
  if (!error) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--accent)", fontSize: 12, padding: "6px 14px" }}>
      <Icon name="alert" size={13} />{error}
    </div>
  );
}

// ── the golden probe strip ────────────────────────────────────────────────────────
function ProbeStrip() {
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setErr(null);
    try {
      const r = await fetch("/api/admin/probe", { method: "POST", cache: "no-store" });
      if (!r.ok) { setErr(`probe failed (${r.status})`); return; }
      const body = (await r.json()) as ProbeResult;
      setProbe({ ...body, at: Date.now() / 1000 });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const tone: Tone = probe ? (probe.status === "pass" ? "ok" : probe.status === "warn" ? "warn" : "danger") : "ok";
  return (
    <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--line)", background: "var(--panel)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: "var(--t2)", whiteSpace: "nowrap" }}>Transcription golden probe</span>
        {probe && <Pill label={`${probe.status} · ${(probe.duration_ms / 1000).toFixed(1)}s`} tone={tone} />}
        {probe && <span style={{ fontSize: 12, color: "var(--t3)" }}>ran {ago(probe.at * 1000)} ago</span>}
        {err && <span style={{ fontSize: 12, color: "var(--danger)" }}>{err}</span>}
        <button onClick={() => void run()} disabled={running}
          style={{ marginLeft: "auto", ...segBtn(false), display: "flex", alignItems: "center", gap: 5, opacity: running ? 0.6 : 1 }}>
          <Icon name="zap" size={12} />{running ? "Running…" : "Run probe"}
        </button>
      </div>
      {probe && (
        <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>
          {probe.stages.map((s) => (
            <span key={s.id} title={s.detail}
              style={{ fontSize: 11.5, fontFamily: "var(--mono)", background: TONE[s.status === "pass" ? "ok" : s.status === "warn" ? "warn" : "danger"].bg, color: TONE[s.status === "pass" ? "ok" : s.status === "warn" ? "warn" : "danger"].fg, padding: "3px 8px", borderRadius: 6, cursor: s.detail ? "help" : "default" }}>
              {s.label}{s.latency_ms != null ? ` ${s.latency_ms}ms` : ""}{s.status !== "pass" && s.detail ? ` — ${s.detail}` : ""}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── workloads tab ─────────────────────────────────────────────────────────────────
function WorkloadsTab({ workloads, error }: { workloads: Workload[]; error?: string }) {
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "bot" | "agent-worker">("all");
  // default = all kinds, RUNNING only — the admin's first question is "what's up right now";
  // stopped/exited history is one click away (Any state)
  const [state, setState] = useState<"all" | "running" | "stopped">("running");
  const shown = useMemo(() => workloads.filter((w) =>
    (kind === "all" || w.kind === kind) &&
    (state === "all" || w.state === state) &&
    (!q || `${w.workloadId} ${w.meeting_id ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  ), [workloads, q, kind, state]);
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 14px", flexWrap: "wrap" }}>
        <input placeholder="Filter by id or meeting…" value={q} onChange={(e) => setQ(e.target.value)} style={searchStyle} />
        <div style={{ display: "flex", gap: 4 }}>
          {(["all", "bot", "agent-worker"] as const).map((k) => (
            <button key={k} style={segBtn(kind === k)} onClick={() => setKind(k)}>{k === "all" ? "All" : k === "bot" ? "Bots" : "Workers"}</button>
          ))}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["all", "running", "stopped"] as const).map((s) => (
            <button key={s} style={segBtn(state === s)} onClick={() => setState(s)}>{s === "all" ? "Any state" : s[0].toUpperCase() + s.slice(1)}</button>
          ))}
        </div>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t3)" }}>{shown.length} shown</span>
      </div>
      <SectionError error={error} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={{ ...th, paddingLeft: 14 }}>workload</th><th style={th}>kind</th><th style={th}>state</th>
            <th style={th}>meeting</th><th style={th}>started</th><th style={th}>exit</th>
          </tr></thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.workloadId} style={{ opacity: w.state === "running" ? 1 : 0.75 }}>
                <td style={{ ...td, paddingLeft: 14 }}>{w.workloadId}</td>
                <td style={{ ...td, fontFamily: "var(--sans)", color: "var(--t2)" }}>{w.kind ?? "—"}</td>
                <td style={td}><StateDot on={w.state === "running"} />{w.state ?? "—"}</td>
                <td style={td}>{w.meeting_id ?? "—"}</td>
                <td style={{ ...td, color: "var(--t2)" }} title={w.startedAt}>{isoAgo(w.startedAt)}</td>
                <td style={{ ...td, color: "var(--t3)" }}>{w.exitCode ?? w.stopReason ?? "—"}</td>
              </tr>
            ))}
            {shown.length === 0 && !error && (
              <tr><td style={{ ...td, color: "var(--t3)", paddingLeft: 14 }} colSpan={6}>
                {workloads.length === 0 ? "no managed containers"
                  : state === "running" && !q && kind === "all" ? "nothing running — Any state shows stopped containers"
                    : "nothing matches the filters"}
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── meeting pipeline tab ──────────────────────────────────────────────────────────
function PipelineTab({ meetings, botStops, error }: { meetings: PipelineRow[]; botStops: Record<string, number>; error?: string }) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"all" | "on" | "live" | "issues">("all");
  const rows = useMemo(() => meetings.map((m) => ({ m, health: healthOf(m, botStops[m.meeting_id] ?? null) })), [meetings, botStops]);
  const shown = useMemo(() => rows.filter(({ m, health }) =>
    (mode === "all" || (mode === "on" && m.processing_on) || (mode === "live" && m.live?.status === "live") || (mode === "issues" && health.tone !== "ok")) &&
    (!q || `${m.meeting_id} ${m.live?.native_id ?? ""} ${m.live?.title ?? ""}`.toLowerCase().includes(q.toLowerCase())),
  ), [rows, q, mode]);
  const stat = (s?: StreamStat) =>
    s ? `${s.len} @ …${(s.last_id ?? "").slice(-6) || "—"}${s.last_type === "view_end" ? " · view_end" : ""}` : "—";
  return (
    <div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 14px", flexWrap: "wrap" }}>
        <input placeholder="Filter by meeting id…" value={q} onChange={(e) => setQ(e.target.value)} style={searchStyle} />
        <div style={{ display: "flex", gap: 4 }}>
          {([["all", "All"], ["on", "Processing on"], ["live", "Live only"], ["issues", "Issues"]] as const).map(([k, label]) => (
            <button key={k} style={{ ...segBtn(mode === k), ...(k === "issues" ? { color: mode === k ? "var(--danger)" : "var(--t2)" } : {}) }} onClick={() => setMode(k)}>{label}</button>
          ))}
        </div>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--t3)" }}>{shown.length} shown</span>
      </div>
      <SectionError error={error} />
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead><tr>
            <th style={{ ...th, paddingLeft: 14 }}>meeting</th><th style={th}>live</th><th style={th}>processing</th>
            <th style={th}>proc stream</th><th style={th}>transcript</th><th style={th}>cursor</th>
            <th style={th}>active set</th><th style={th}>health</th>
          </tr></thead>
          <tbody>
            {shown.map(({ m, health }) => (
              <tr key={m.meeting_id}>
                <td style={{ ...td, paddingLeft: 14 }} title={m.live?.title}>{m.meeting_id}{m.live?.native_id ? <span style={{ color: "var(--t3)" }}> ({m.live.native_id})</span> : null}</td>
                <td style={td} title={m.live?.last_seen ? "registry last_seen — re-stamped every segment batch; silent entries self-demote after 60s" : undefined}>
                  {m.live ? <><StateDot on={m.live.status === "live"} />{m.live.status}{m.live.last_seen ? <span style={{ color: "var(--t3)" }}> · {ago(m.live.last_seen * 1000)}</span> : null}</> : "—"}
                </td>
                <td style={{ ...td, color: m.processing_on ? "var(--t1)" : "var(--t2)" }}>{m.processing_on ? "ON" : "off"}</td>
                <td style={td}>{stat(m.proc_stream)}</td>
                <td style={td}>{stat(m.transcript_stream)}</td>
                <td style={{ ...td, color: "var(--t2)" }}>{m.copilot_cursor ? `…${m.copilot_cursor.slice(-6)}` : "—"}</td>
                <td style={{ ...td, color: "var(--t2)" }}>{m.in_active_meetings ? "yes" : "no"}</td>
                <td style={td}><Pill label={health.label} tone={health.tone} /></td>
              </tr>
            ))}
            {shown.length === 0 && !error && (
              <tr><td style={{ ...td, color: "var(--t3)", paddingLeft: 14 }} colSpan={8}>{meetings.length ? "nothing matches the filters" : "no pipeline carriers in redis"}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── users tab: DB-77 admin overrides (comp a user) ─────────────────────────────────
interface AdminUserRecord {
  id: string | number;
  email: string;
  max_concurrent_bots?: number;
  data?: {
    plan_override?: string | null;
    quota_bonus?: number | null;
    subscription_tier?: string | null;
    subscription_status?: string | null;
  };
}

const label: CSSProperties = { fontSize: 12, color: "var(--t2)", display: "block", marginBottom: 4 };
const field: CSSProperties = { width: "100%", height: 30, fontSize: 13, padding: "0 8px", borderRadius: 6, border: "1px solid var(--line)", background: "var(--panel)", color: "var(--t1)", outline: "none" };
const primaryBtn: CSSProperties = { fontSize: 12.5, padding: "6px 14px", borderRadius: 6, border: "1px solid var(--accent)", background: "var(--accent)", color: "var(--on-accent)", cursor: "pointer" };

function UsersTab() {
  const [emailQuery, setEmailQuery] = useState("");
  const [user, setUser] = useState<AdminUserRecord | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [maxConcurrentBots, setMaxConcurrentBots] = useState("");
  const [planOverride, setPlanOverride] = useState<string>("");
  const [quotaBonus, setQuotaBonus] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; tone: Tone } | null>(null);

  const loadUser = async () => {
    const email = emailQuery.trim();
    if (!email) return;
    setLoading(true);
    setLoadErr(null);
    setSaveMsg(null);
    try {
      const r = await fetch(`/api/admin/users?email=${encodeURIComponent(email)}`, { cache: "no-store" });
      const body = await r.json();
      if (!r.ok) { setUser(null); setLoadErr(body?.error || `lookup failed (${r.status})`); return; }
      const u = body as AdminUserRecord;
      setUser(u);
      setMaxConcurrentBots(String(u.max_concurrent_bots ?? ""));
      setPlanOverride(u.data?.plan_override ?? "");
      setQuotaBonus(u.data?.quota_bonus != null ? String(u.data.quota_bonus) : "");
    } catch (e) {
      setUser(null);
      setLoadErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!user) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const body: Record<string, unknown> = {};
      if (maxConcurrentBots.trim() !== "") {
        const n = Number(maxConcurrentBots);
        if (Number.isFinite(n)) body.max_concurrent_bots = n;
      }
      // Always sent (never omitted): "" means "clear the override", matching admin-api's
      // require-explicit-null semantics for plan_override/quota_bonus (see UserAdminPatch).
      body.plan_override = planOverride === "" ? null : planOverride;
      body.quota_bonus = quotaBonus.trim() === "" ? null : Number(quotaBonus);

      const r = await fetch(`/api/admin/users/${encodeURIComponent(String(user.id))}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const respBody = await r.json();
      if (!r.ok) {
        setSaveMsg({ text: respBody?.error || `save failed (${r.status})`, tone: "danger" });
        return;
      }
      const u = respBody as AdminUserRecord;
      setUser(u);
      setMaxConcurrentBots(String(u.max_concurrent_bots ?? ""));
      setPlanOverride(u.data?.plan_override ?? "");
      setQuotaBonus(u.data?.quota_bonus != null ? String(u.data.quota_bonus) : "");
      setSaveMsg({ text: "Saved", tone: "ok" });
    } catch (e) {
      setSaveMsg({ text: (e as Error).message, tone: "danger" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: "14px", maxWidth: 460 }}>
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        <input
          placeholder="user email…"
          value={emailQuery}
          onChange={(e) => setEmailQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void loadUser(); }}
          style={{ ...searchStyle, width: 260 }}
        />
        <button onClick={() => void loadUser()} disabled={loading || !emailQuery.trim()} style={{ ...segBtn(false), opacity: loading ? 0.6 : 1 }}>
          {loading ? "Loading…" : "Load"}
        </button>
      </div>
      {loadErr && <div style={{ fontSize: 12.5, color: "var(--danger)", marginBottom: 10 }}>{loadErr}</div>}
      {user && (
        <div>
          <div style={{ fontSize: 12.5, color: "var(--t2)", marginBottom: 12 }}>
            {user.email} — plan: {user.data?.subscription_tier ?? "—"} ({user.data?.subscription_status ?? "no subscription"})
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={label}>Max concurrent bots</label>
            <input type="number" min={0} value={maxConcurrentBots} onChange={(e) => setMaxConcurrentBots(e.target.value)} style={field} />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={label}>Plan override (comp)</label>
            <select value={planOverride} onChange={(e) => setPlanOverride(e.target.value)} style={field}>
              <option value="">— none (use billed plan) —</option>
              {CATALOG_PLAN_IDS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>

          <div style={{ marginBottom: 16 }}>
            <label style={label}>Quota bonus (extra meetings this period)</label>
            <input type="number" min={0} placeholder="0" value={quotaBonus} onChange={(e) => setQuotaBonus(e.target.value)} style={field} />
            <span style={{ fontSize: 11, color: "var(--t3)" }}>
              Applies to the CURRENT billing/calendar period only — it does not carry over next period.
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button onClick={() => void save()} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.6 : 1 }}>
              {saving ? "Saving…" : "Save"}
            </button>
            {saveMsg && <Pill label={saveMsg.text} tone={saveMsg.tone} />}
          </div>
        </div>
      )}
    </div>
  );
}

// ── the panel: probe strip + tab bar + tables ─────────────────────────────────────
function AdminPanel({ active }: { id: string; params: Record<string, unknown>; active: boolean }) {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ts, setTs] = useState(0);
  const [tab, setTab] = useState<"w" | "p" | "u">("w");

  useEffect(() => {
    if (!active) return;
    let on = true;
    const poll = async () => {
      if (document.hidden) return;
      try {
        const r = await fetch("/api/admin/overview", { cache: "no-store" });
        if (!on) return;
        if (!r.ok) { setErr(`overview fetch failed (${r.status})`); return; }
        setData((await r.json()) as Overview);
        setErr(null);
        setTs(Date.now());
      } catch (e) {
        if (on) setErr((e as Error).message);
      }
    };
    void poll();
    const iv = setInterval(() => void poll(), POLL_MS);
    return () => { on = false; clearInterval(iv); };
  }, [active]);

  const workloads = data?.workloads ?? [];
  const meetings = data?.meetings ?? [];
  const botStops = useMemo(() => {
    const out: Record<string, number> = {};
    for (const w of workloads) {
      if (w.kind === "bot" && w.meeting_id && w.stoppedAt) {
        const t = Date.parse(w.stoppedAt);
        if (Number.isFinite(t)) out[w.meeting_id] = Math.max(out[w.meeting_id] ?? 0, t);
      }
    }
    return out;
  }, [workloads]);

  const tabBtn = (on: boolean): CSSProperties => ({ border: "none", borderBottom: on ? "2px solid var(--accent)" : "2px solid transparent", borderRadius: 0, background: "none", fontSize: 13, fontWeight: on ? 600 : 400, color: on ? "var(--t1)" : "var(--t2)", padding: "6px 12px", cursor: "pointer" });
  return (
    <div style={{ height: "100%", overflowY: "auto", background: "var(--bg)" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "14px 14px 8px" }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, color: "var(--t1)", margin: 0 }}>Infra</h2>
        <span style={{ fontSize: 11.5, color: "var(--t3)" }}>read-only · refreshes every {POLL_MS / 1000}s{ts ? ` · updated ${ago(ts)} ago` : ""}</span>
      </div>
      {err && <SectionError error={err} />}
      <ProbeStrip />
      <div style={{ display: "flex", gap: 2, padding: "8px 14px 0", borderBottom: "1px solid var(--line)" }}>
        <button style={tabBtn(tab === "w")} onClick={() => setTab("w")}>Workloads <span style={{ color: "var(--t3)", fontWeight: 400 }}>{workloads.length}</span></button>
        <button style={tabBtn(tab === "p")} onClick={() => setTab("p")}>Meeting pipeline <span style={{ color: "var(--t3)", fontWeight: 400 }}>{meetings.length}</span></button>
        <button style={tabBtn(tab === "u")} onClick={() => setTab("u")}>Users</button>
      </div>
      {tab === "w"
        ? <WorkloadsTab workloads={workloads} error={data?.workloads_error} />
        : tab === "p"
          ? <PipelineTab meetings={meetings} botStops={botStops} error={data?.meetings_error} />
          : <UsersTab />}
    </div>
  );
}

// ── left launcher — opens the panel, shows a one-line summary ─────────────────────
function AdminLeft() {
  const layout = useService(LayoutServiceId);
  useEffect(() => { layout.openTab(PANEL); }, [layout]);
  return (
    <div style={{ padding: "10px 12px", fontSize: 12, color: "var(--t3)" }}>
      Infrastructure panel: transcription golden probe, running bots, agent workers, per-meeting pipeline state, and per-user plan overrides.
    </div>
  );
}

// Nothing registers unless the server confirms the caller is an allowlisted admin (404 for
// everyone else — see app/api/admin/*). Absent in meetings-only mode like the other agent surfaces.
if (!meetingsOnly() && typeof window !== "undefined") {
  void fetch("/api/admin/me", { cache: "no-store" })
    .then((r) => {
      if (!r.ok) return;
      registerTab("adminInfra", AdminPanel);
      registerList({ id: "admin", label: "Infra", icon: "radio", order: 90, component: AdminLeft });
    })
    .catch(() => { /* hidden — a failed probe just means no entry */ });
}
