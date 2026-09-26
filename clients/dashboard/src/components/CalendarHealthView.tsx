"use client";
/** `/calendar` (DB-34): per connection, the health the "Connect your calendar" panel
 *  (`SendBotDialog`'s Calendar tab) has no room to show — last sync time, last error, how many
 *  events the last sync actually touched, and `reconnect_needed` with a real Reconnect action. A
 *  failed feed shows that action rather than going silently stale.
 *
 *  Reads `GET /api/vexa/user/calendars` for the roster (`kind`, `reconnect_needed`, `auto_join`),
 *  then `GET /api/vexa/user/calendars/<id>/sync` per connection for its stamp — meeting-api's own
 *  `{last_sync, last_error, counts}` shape (`calendar_sync/runner.py`'s `run_user_sync`), rendered
 *  as-is: `counts` is `{created, updated, cancelled}` for the LAST sync only (never a running
 *  total this client would have to keep in step with the producer's own retention), and an empty
 *  `{}` — the shape the route answers before any sync has ever run for that connection — reads as
 *  "Never synced yet", not an error.
 *
 *  This page never invents its own connect flow: with no connections at all, it points at the Add
 *  Bot dialog's Calendar tab (DB-31/DB-33's actual connect surface) rather than duplicating
 *  Connect Google Calendar / Connect Microsoft 365 / Other calendar (ICS) here.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Calendar as CalendarIcon, CheckCircle2, RefreshCw } from "lucide-react";
import clsx from "clsx";
import { getJson, mutateJson, presentError } from "@/lib/api";
import { CALENDAR_OAUTH_LABEL, type CalendarOAuthProvider, fetchTrustedAuthorizeUrl } from "@/lib/calendarOAuth";
import { Button, useToast } from "./ui";
import { EmptyState, ErrorState, LoadingState } from "./EmptyState";

interface CalendarConnection {
  id: string;
  kind: "ics" | "google" | "microsoft";
  name: string;
  reconnect_needed?: boolean;
  auto_join: boolean;
  enabled: boolean;
}

/** `GET /user/calendars/<id>/sync`'s stamp — `{}` before any sync has ever run for that
 *  connection. `counts` describes the LAST sync only. */
interface SyncStamp {
  last_sync?: string | null;
  last_error?: string | null;
  counts?: { created?: number; updated?: number; cancelled?: number } | null;
}

interface ConnectionHealth {
  connection: CalendarConnection;
  stamp: SyncStamp | null; // null: the health read itself failed — shown distinct from "never synced"
}

type ViewState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; rows: ConnectionHealth[] };

const KIND_LABEL: Record<CalendarConnection["kind"], string> = {
  ics: "ICS feed",
  google: "Google Calendar",
  microsoft: "Microsoft 365",
};

function eventCount(stamp: SyncStamp | null): number | null {
  if (!stamp?.counts) return null;
  const { created = 0, updated = 0, cancelled = 0 } = stamp.counts;
  return created + updated + cancelled;
}

function formatSyncTime(iso: string | null | undefined): string {
  if (!iso) return "Never synced";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "Never synced";
  return `Last synced ${d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`;
}

export function CalendarHealthView() {
  const toast = useToast();
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [reconnecting, setReconnecting] = useState<string | null>(null); // connection id
  const [syncingId, setSyncingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await getJson<{ calendars?: CalendarConnection[] }>("/api/vexa/user/calendars");
      const connections = d.calendars ?? [];
      const rows = await Promise.all(
        connections.map(async (connection): Promise<ConnectionHealth> => {
          try {
            const stamp = await getJson<SyncStamp>(`/api/vexa/user/calendars/${encodeURIComponent(connection.id)}/sync`);
            return { connection, stamp };
          } catch {
            return { connection, stamp: null };
          }
        }),
      );
      setState({ kind: "loaded", rows });
    } catch (e) {
      setState({ kind: "error", message: presentError(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncNow = useCallback(
    async (id: string) => {
      setSyncingId(id);
      try {
        await mutateJson("POST", `/api/vexa/user/calendars/${encodeURIComponent(id)}/sync`);
        await load();
        toast.push({ tone: "success", title: "Calendar synced." });
      } catch (e) {
        toast.push({ tone: "error", title: "Couldn't sync the calendar", description: presentError(e) });
      } finally {
        setSyncingId(null);
      }
    },
    [load, toast],
  );

  const reconnect = useCallback(
    async (connection: CalendarConnection) => {
      const provider: CalendarOAuthProvider = connection.kind === "microsoft" ? "microsoft" : "google";
      setReconnecting(connection.id);
      try {
        const authorizeUrl = await fetchTrustedAuthorizeUrl(provider);
        window.location.assign(authorizeUrl);
        // Navigating away — leave `reconnecting` set for the page's brief remaining life.
      } catch (e) {
        toast.push({
          tone: "error",
          title: `Couldn't reconnect ${CALENDAR_OAUTH_LABEL[provider]}`,
          description: presentError(e),
        });
        setReconnecting(null);
      }
    },
    [toast],
  );

  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="mb-1 text-xl font-semibold">Calendar</h1>
      <p className="mb-6 text-sm text-ink-3">
        Health for every connected calendar — last sync, errors, and events touched.
      </p>

      {state.kind === "loading" && <LoadingState label="Loading calendar health…" />}

      {state.kind === "error" && <ErrorState message={state.message} onRetry={() => void load()} />}

      {state.kind === "loaded" && state.rows.length === 0 && (
        <EmptyState
          title="No calendars connected"
          hint={"Connect one from the \"Add Bot\" dialog's Calendar tab, then come back here to watch its health."}
        />
      )}

      {state.kind === "loaded" && state.rows.length > 0 && (
        <div className="flex flex-col gap-3">
          {state.rows.map(({ connection, stamp }) => {
            const needsReconnect =
              (connection.kind === "google" || connection.kind === "microsoft") && !!connection.reconnect_needed;
            const failed = !needsReconnect && (stamp === null || !!stamp.last_error);
            const count = eventCount(stamp);
            return (
              <div
                key={connection.id}
                role="group"
                aria-label={connection.name}
                className={clsx(
                  "rounded-xl border bg-card p-4",
                  needsReconnect || failed ? "border-warn/40" : "border-line",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <CalendarIcon size={15} className="text-ink-2" aria-hidden />
                      <p className="truncate text-sm font-medium">{connection.name}</p>
                    </div>
                    <p className="mt-0.5 text-xs text-ink-3">
                      {KIND_LABEL[connection.kind]}
                      {" · "}
                      {connection.enabled ? (connection.auto_join ? "Auto-join on" : "Auto-join off") : "Paused"}
                    </p>
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-ink-3">
                      {stamp?.last_error ? (
                        <AlertTriangle size={11} className="text-warn" aria-hidden />
                      ) : (
                        <CheckCircle2 size={11} className="text-ok" aria-hidden />
                      )}
                      {stamp === null ? "Couldn't read this calendar's sync status" : formatSyncTime(stamp.last_sync)}
                      {count !== null && !stamp?.last_error && ` · ${count} event${count === 1 ? "" : "s"} touched`}
                    </p>
                    {stamp?.last_error && (
                      <p role="alert" className="mt-1 text-xs font-medium text-warn">
                        {stamp.last_error}
                      </p>
                    )}
                    {needsReconnect && (
                      <p className="mt-1 flex items-center gap-1 text-xs font-medium text-warn">
                        <AlertTriangle size={11} aria-hidden /> Reconnect needed —{" "}
                        {connection.kind === "microsoft" ? "Microsoft" : "Google"} access was revoked or expired.
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {needsReconnect ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void reconnect(connection)}
                        loading={reconnecting === connection.id}
                        disabled={reconnecting === connection.id}
                      >
                        Reconnect
                      </Button>
                    ) : (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void syncNow(connection.id)}
                        loading={syncingId === connection.id}
                        disabled={syncingId === connection.id}
                        icon={<RefreshCw size={13} aria-hidden />}
                      >
                        Sync now
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
