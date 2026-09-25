"use client";
/** The sign-in card.
 *
 *  Which providers exist is decided on the server (the OAuth secrets never reach the browser) and
 *  handed down as props. The email form appears only where the deployment opened that debug door.
 *
 *  `next` is where the visitor was heading before the gate sent them here. It is accepted ONLY as
 *  a same-site path — a value that is not a single leading slash is dropped, so this cannot become
 *  an open redirect no matter what a link puts in the query string.
 */
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { signIn } from "next-auth/react";
import { AudioLines } from "lucide-react";
import { safeNext } from "@/lib/security";
import { Button, Input } from "./ui";

export interface LoginOptions {
  google: boolean;
  microsoft: boolean;
  emailLogin: boolean;
}

export function LoginForm({ options }: { options: LoginOptions }) {
  const params = useSearchParams();
  const next = safeNext(params.get("next"));
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function emailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy("email");
    setError(null);
    try {
      const r = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setError(body.error || `Sign-in failed (${r.status}).`);
        setBusy(null);
        return;
      }
      window.location.href = next;
    } catch {
      setError("Couldn't reach the dashboard server.");
      setBusy(null);
    }
  }

  const noProvider = !options.google && !options.microsoft && !options.emailLogin;

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <span className="mx-auto mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-accent text-accent-ink">
            <AudioLines size={22} aria-hidden />
          </span>
          <h1 className="text-xl font-semibold tracking-tight">Sign in to Vexa</h1>
          <p className="mt-1 text-sm text-ink-2">Your meetings and transcripts.</p>
        </div>

        <div className="rounded-card border border-line bg-card p-6">
          {noProvider && (
            <p className="text-sm text-ink-2">
              No sign-in method is configured on this deployment. An operator sets{" "}
              <code className="rounded bg-raised px-1 py-0.5 text-xs">GOOGLE_CLIENT_ID</code> /{" "}
              <code className="rounded bg-raised px-1 py-0.5 text-xs">MICROSOFT_CLIENT_ID</code> to enable one.
            </p>
          )}

          {options.google && (
            <ProviderButton
              label="Continue with Google"
              busy={busy === "google"}
              onClick={() => {
                setBusy("google");
                void signIn("google", { callbackUrl: next });
              }}
            />
          )}
          {options.microsoft && (
            <ProviderButton
              label="Continue with Microsoft"
              busy={busy === "microsoft"}
              onClick={() => {
                setBusy("microsoft");
                void signIn("microsoft", { callbackUrl: next });
              }}
            />
          )}

          {options.emailLogin && (
            <>
              {(options.google || options.microsoft) && (
                <div className="my-5 flex items-center gap-3 text-xs text-ink-3">
                  <span className="h-px flex-1 bg-line" />
                  or
                  <span className="h-px flex-1 bg-line" />
                </div>
              )}
              <form onSubmit={emailSubmit}>
                <Input
                  id="email"
                  label="Email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="bg-canvas"
                />
                <Button type="submit" variant="primary" loading={busy === "email"} disabled={busy !== null} className="mt-3 w-full">
                  Continue
                </Button>
              </form>
              <p className="mt-3 text-xs text-ink-3">
                Email sign-in is a development door — it proves no ownership of the address. Production
                deployments use Google or Microsoft.
              </p>
            </>
          )}

          {error && (
            <p className="mt-4 rounded-lg bg-live-soft px-3 py-2 text-sm text-live" role="alert">
              {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <Button type="button" variant="secondary" loading={busy} onClick={onClick} className="mb-2 w-full">
      {label}
    </Button>
  );
}
