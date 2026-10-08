"use client";
/** `/settings/account`: who the account is, how it signs in, and where it is signed in.
 *
 *  Everything comes from `GET /api/account`, which the server answers for the session's own user
 *  and nobody else. The one write is **Sign out everywhere** → a confirmation →
 *  `DELETE /api/account/sessions`, after which every `dashboard-login` token is revoked (a second
 *  browser's next request is refused) and this browser lands on `/login` with a plain notice.
 *
 *  The other write is **Delete account**: a danger section, then a dialog that asks for the
 *  account's own email typed out. The button stays disabled until it matches (a convenience; the
 *  server checks again). Deletion is immediate and cannot be undone. On success this browser
 *  lands on `/login` with a plain notice; if the core could only finish part of it, the dialog
 *  says so in plain words and the session is already gone.
 *
 *  Name and email are shown, not edited: the email is the account's key, and the name comes from
 *  the sign-in provider.
 */
import { useEffect, useRef, useState } from "react";
import { LogOut, Trash2 } from "lucide-react";
import { ApiError, getJson, mutateJson, presentError } from "@/lib/api";
import {
  ACCOUNT_DELETED,
  DELETE_FAILURE_TEXT,
  SIGNED_OUT_EVERYWHERE,
  describeProvider,
  emailMatches,
  formatWhen,
  initialsOf,
  type AccountView as Account,
} from "@/lib/account";
import { Button, Dialog, Input, useToast } from "./ui";
import { ErrorState, LoadingState } from "./EmptyState";

type ViewState = { kind: "loading" } | { kind: "error"; message: string } | { kind: "loaded"; account: Account };

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-card p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      {hint && <p className="mt-0.5 text-sm text-ink-3">{hint}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

function Field({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-ink-3">{label}</dt>
      <dd className="mt-0.5 break-words text-[15px] text-ink-2" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

export function AccountView() {
  const toast = useToast();
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typedEmail, setTypedEmail] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletePartial, setDeletePartial] = useState(false);

  // The dialog puts focus on its close button when it opens; the field to type in is where the
  // person needs to be. This effect lives above the dialog, so it runs after the dialog's own.
  const emailRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!confirmDelete || deletePartial) return;
    const t = setTimeout(() => emailRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [confirmDelete, deletePartial]);

  useEffect(() => {
    let cancelled = false;
    getJson<Account>("/api/account")
      .then((account) => {
        if (!cancelled) setState({ kind: "loaded", account });
      })
      .catch((e) => {
        if (!cancelled) setState({ kind: "error", message: presentError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  async function signOutEverywhere() {
    setSigningOut(true);
    try {
      await mutateJson("DELETE", "/api/account/sessions");
      // A hard navigation: nothing from the revoked session survives in client state.
      window.location.href = `/login?notice=${SIGNED_OUT_EVERYWHERE}`;
    } catch (e) {
      setSigningOut(false);
      setConfirmSignOut(false);
      toast.push({ tone: "error", title: "Couldn't sign out everywhere", description: presentError(e) });
    }
  }

  function openDelete() {
    setTypedEmail("");
    setDeleteError(null);
    setDeletePartial(false);
    setConfirmDelete(true);
  }

  async function deleteAccount(email: string) {
    setDeleting(true);
    setDeleteError(null);
    try {
      await mutateJson("DELETE", "/api/account", { confirmEmail: email });
      // A hard navigation: nothing from the deleted account survives in client state.
      window.location.href = `/login?notice=${ACCOUNT_DELETED}`;
    } catch (e) {
      setDeleting(false);
      if (e instanceof ApiError && e.status === 502) {
        setDeletePartial(true);
      } else if (e instanceof ApiError && e.status === 409) {
        const outcome = (e.body as { outcome?: unknown } | undefined)?.outcome;
        setDeleteError(outcome === "last_admin" ? DELETE_FAILURE_TEXT.last_admin : DELETE_FAILURE_TEXT.blocked);
      } else if (e instanceof ApiError && e.status === 400) {
        setDeleteError("That doesn't match your account's email address.");
      } else if (e instanceof ApiError && (e.status === 0 || e.status === 503)) {
        setDeleteError(DELETE_FAILURE_TEXT.unavailable);
      } else {
        setDeleteError(presentError(e));
      }
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-6 text-xl font-semibold">Account</h1>
        <LoadingState label="Loading your account…" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <h1 className="mb-6 text-xl font-semibold">Account</h1>
        <ErrorState message={state.message} onRetry={() => { setState({ kind: "loading" }); setReloadKey((k) => k + 1); }} />
      </div>
    );
  }

  const { account } = state;
  const provider = describeProvider(account.provider);
  const count = account.sessions.length;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5 p-6">
      <h1 className="text-xl font-semibold">Account</h1>

      <Section title="Profile">
        <div className="flex items-center gap-4">
          <span
            aria-hidden
            className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-raised text-lg font-semibold text-ink-2"
            data-testid="avatar-initials"
          >
            {initialsOf(account.name, account.email)}
          </span>
          <dl className="grid min-w-0 flex-1 gap-3">
            <Field label="Name" value={account.name || "Not set"} testId="account-name" />
            <Field label="Email" value={account.email} testId="account-email" />
          </dl>
        </div>
      </Section>

      <Section title="Sign-in method" hint="How this account proved its email address.">
        <dl className="grid gap-3">
          <Field label="Provider" value={provider.label} testId="account-provider" />
          <Field label="Status" value={provider.detail} testId="account-provider-detail" />
        </dl>
      </Section>

      <Section
        title="Active sessions"
        hint="Each browser or device signed in to this dashboard."
      >
        {count === 0 ? (
          <p className="text-sm text-ink-2">No active sessions.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Active sessions" data-testid="session-list">
            {account.sessions.map((s, i) => (
              <li key={`${s.createdAt ?? "unknown"}-${i}`} className="flex flex-wrap justify-between gap-x-6 gap-y-1 py-2.5 text-sm">
                <span className="text-ink-2">Signed in {formatWhen(s.createdAt)}</span>
                <span className="text-ink-3">Last used {formatWhen(s.lastUsedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-4">
          <Button variant="danger" icon={<LogOut size={15} aria-hidden />} onClick={() => setConfirmSignOut(true)}>
            Sign out everywhere
          </Button>
        </div>
      </Section>

      <section className="rounded-card border border-live/40 bg-card p-5" aria-labelledby="delete-account-heading">
        <h2 id="delete-account-heading" className="text-sm font-semibold">Delete account</h2>
        <p className="mt-0.5 text-sm text-ink-3">
          Permanently erases your account and everything in it: meetings, transcripts, recordings,
          summaries and notes, calendar connections, API keys and chat history. A paid subscription is
          cancelled immediately, with no refund. This cannot be undone.
        </p>
        <div className="mt-4">
          <Button variant="danger" icon={<Trash2 size={15} aria-hidden />} onClick={openDelete}>
            Delete account
          </Button>
        </div>
      </section>

      {confirmDelete && (
        <Dialog
          open
          onClose={() => {
            if (deleting) return;
            if (deletePartial) window.location.href = "/login";
            else setConfirmDelete(false);
          }}
          title="Delete your account?"
          icon={<Trash2 size={16} aria-hidden />}
        >
          {deletePartial ? (
            <div className="flex flex-col gap-4 p-6 pt-4">
              <p role="alert" className="text-sm text-ink-2" data-testid="delete-partial">
                {DELETE_FAILURE_TEXT.partial}
              </p>
              <div className="flex justify-end">
                <Button variant="secondary" onClick={() => { window.location.href = "/login"; }}>
                  Go to sign in
                </Button>
              </div>
            </div>
          ) : (
            <form
              className="flex flex-col gap-4 p-6 pt-4"
              onSubmit={(ev) => {
                ev.preventDefault();
                if (emailMatches(typedEmail, account.email) && !deleting) void deleteAccount(typedEmail);
              }}
            >
              <p className="text-sm text-ink-2">
                This deletes everything right now and cannot be undone. Type{" "}
                <strong className="break-all font-semibold">{account.email}</strong> to confirm.
              </p>
              <Input
                label="Your email address"
                type="email"
                ref={emailRef}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={typedEmail}
                onChange={(ev) => setTypedEmail(ev.target.value)}
                disabled={deleting}
                error={deleteError ?? undefined}
              />
              <div className="flex justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setConfirmDelete(false)} disabled={deleting}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  variant="danger"
                  loading={deleting}
                  disabled={!emailMatches(typedEmail, account.email)}
                >
                  Delete my account
                </Button>
              </div>
            </form>
          )}
        </Dialog>
      )}

      {confirmSignOut && (
        <Dialog
          open
          onClose={() => !signingOut && setConfirmSignOut(false)}
          title="Sign out everywhere?"
          icon={<LogOut size={16} aria-hidden />}
        >
          <div className="flex flex-col gap-4 p-6 pt-4">
            <p className="text-sm text-ink-2">
              Every browser and device signed in to this dashboard will be signed out, including this one. API
              keys you created yourself are not affected.
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setConfirmSignOut(false)} disabled={signingOut}>
                Stay signed in
              </Button>
              <Button variant="danger" onClick={() => void signOutEverywhere()} loading={signingOut}>
                Sign out everywhere
              </Button>
            </div>
          </div>
        </Dialog>
      )}
    </div>
  );
}
