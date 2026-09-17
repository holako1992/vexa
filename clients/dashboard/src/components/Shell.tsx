"use client";
/** The app frame: a fixed left rail and the scrolling work area beside it.
 *
 *  It is a client component only because the sign-out button and the mobile rail toggle hold
 *  state; the identity it renders is resolved on the server and handed down as a prop, so the
 *  browser is never the source of who you are.
 */
import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AudioLines, LayoutGrid, LogOut, Menu, X } from "lucide-react";
import clsx from "clsx";

export interface ShellUser {
  email: string | null;
  name: string | null;
}

const NAV = [{ href: "/", label: "Meetings", icon: LayoutGrid }];

function initials(user: ShellUser): string {
  const source = user.name || user.email || "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Shell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const [railOpen, setRailOpen] = useState(false);
  const pathname = usePathname();

  async function signOut() {
    // POST, same-origin — the logout route refuses anything else. A hard navigation afterwards
    // guarantees no stale client cache survives the session.
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-screen">
      <aside
        className={clsx(
          "fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-line bg-rail transition-transform md:static md:translate-x-0",
          railOpen ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-16 items-center gap-2 px-5">
          <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent text-accent-ink">
            <AudioLines size={18} aria-hidden />
          </span>
          <span className="text-[15px] font-semibold tracking-tight">Vexa</span>
          <button
            type="button"
            onClick={() => setRailOpen(false)}
            className="ml-auto rounded-lg p-1.5 text-ink-2 hover:bg-raised md:hidden"
            aria-label="Close navigation"
          >
            <X size={18} aria-hidden />
          </button>
        </div>

        <nav className="flex-1 px-3 py-2" aria-label="Main">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || (href !== "/" && pathname.startsWith(href));
            return (
              <Link
                key={href}
                href={href}
                onClick={() => setRailOpen(false)}
                aria-current={active ? "page" : undefined}
                className={clsx(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                  active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-raised hover:text-ink",
                )}
              >
                <Icon size={17} aria-hidden />
                {label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-line p-3">
          <div className="flex items-center gap-3 rounded-lg px-2 py-2">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-semibold text-ink-2">
              {initials(user)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{user.name || "Signed in"}</span>
              <span className="block truncate text-xs text-ink-3">{user.email || ""}</span>
            </span>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          >
            <LogOut size={17} aria-hidden />
            Sign out
          </button>
        </div>
      </aside>

      {railOpen && (
        <button
          type="button"
          aria-label="Close navigation"
          onClick={() => setRailOpen(false)}
          className="fixed inset-0 z-20 bg-black/30 md:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 items-center gap-3 border-b border-line px-4 md:hidden">
          <button
            type="button"
            onClick={() => setRailOpen(true)}
            className="rounded-lg p-2 text-ink-2 hover:bg-raised"
            aria-label="Open navigation"
          >
            <Menu size={18} aria-hidden />
          </button>
          <span className="text-[15px] font-semibold tracking-tight">Vexa</span>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
