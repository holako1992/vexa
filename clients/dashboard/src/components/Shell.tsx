"use client";
/** The app frame: a skip link, a left rail (a drawer below `md`) and a top bar with the account
 *  menu. Every page but `/login` renders inside this — see `src/app/page.tsx` and
 *  `src/app/meetings/[meetingId]/page.tsx`.
 *
 *  It is a client component only because the account menu, the mobile rail toggle and sign-out
 *  hold state; the identity it renders is resolved on the server and handed down as a prop, so
 *  the browser is never the source of who you are.
 *
 *  DB-44 — global search: the top bar carries a search box, not a nav-rail entry. `nav.ts`'s items
 *  are DESTINATIONS you revisit (Meetings, Billing, eventually Upcoming/Calendar); search is an
 *  ACTION you take from wherever you already are, the way GitHub, Linear and Notion all put it in
 *  a persistent header bar rather than the sidebar. A rail entry would also cost a click to reach
 *  a page whose only job is to hand you straight back to a meeting — worse than typing into a box
 *  that is already on screen. It is reachable from every page because `Shell` renders it, and
 *  `Ctrl+K`/`Cmd+K` focuses it from anywhere without a pointer.
 */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { AudioLines, ChevronDown, LogOut, Menu, Search, X } from "lucide-react";
import clsx from "clsx";
import { VISIBLE_NAV_ITEMS } from "./nav";

export interface ShellUser {
  email: string | null;
  name: string | null;
}

function initials(user: ShellUser): string {
  const source = user.name || user.email || "?";
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

export function Shell({ user, children }: { user: ShellUser; children: React.ReactNode }) {
  const [railOpen, setRailOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  const [searchValue, setSearchValue] = useState("");

  // Ctrl+K / Cmd+K focuses the search box from anywhere in the app, without stealing the
  // shortcut while someone is already typing in another field (a second Ctrl+K there should do
  // whatever that field normally does, not hijack focus mid-edit elsewhere).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function submitSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = searchValue.trim();
    if (!q) return;
    router.push(`/search?q=${encodeURIComponent(q)}`);
  }

  async function signOut() {
    // POST, same-origin — the logout route refuses anything else. A hard navigation afterwards
    // guarantees no stale client cache survives the session.
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  return (
    <div className="flex min-h-screen">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[200] focus:rounded-lg focus:bg-accent focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-accent-ink"
      >
        Skip to content
      </a>

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
          {VISIBLE_NAV_ITEMS.map(({ href, label, icon: Icon }) => {
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
        <header className="flex h-16 items-center gap-3 border-b border-line px-4 md:px-6">
          <button
            type="button"
            onClick={() => setRailOpen(true)}
            className="rounded-lg p-2 text-ink-2 hover:bg-raised md:hidden"
            aria-label="Open navigation"
          >
            <Menu size={18} aria-hidden />
          </button>
          <span className="text-[15px] font-semibold tracking-tight md:hidden">Vexa</span>
          <form onSubmit={submitSearch} role="search" className="ml-2 hidden max-w-sm flex-1 sm:block">
            <label htmlFor="global-search" className="sr-only">
              Search meetings and transcripts
            </label>
            <div className="relative">
              <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              <input
                ref={searchRef}
                id="global-search"
                type="search"
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                placeholder="Search meetings & transcripts"
                className="w-full rounded-lg border border-line bg-raised py-1.5 pl-8 pr-12 text-sm placeholder:text-ink-3 focus:border-accent focus:outline-none"
              />
              <kbd
                aria-hidden
                className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded border border-line bg-card px-1.5 py-0.5 text-[10px] font-medium text-ink-3"
              >
                Ctrl K
              </kbd>
            </div>
          </form>
          {/* Mobile fallback: the inline box above is hidden below `sm` for space, but search must
              still be reachable from every page (DB-44) — a plain link to /search, no query. */}
          <Link
            href="/search"
            aria-label="Open search"
            className="rounded-lg p-2 text-ink-2 hover:bg-raised sm:hidden"
          >
            <Search size={18} aria-hidden />
          </Link>
          <div className="ml-auto">
            <AccountMenu user={user} onSignOut={signOut} />
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 focus:outline-none">
          {children}
        </main>
      </div>
    </div>
  );
}

function AccountMenu({ user, onSignOut }: { user: ShellUser; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-raised"
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-semibold text-ink-2">
          {initials(user)}
        </span>
        <span className="hidden text-left sm:block">
          <span className="block max-w-[10rem] truncate text-sm font-medium">{user.name || "Signed in"}</span>
        </span>
        <ChevronDown size={14} className={clsx("text-ink-3 transition-transform", open && "rotate-180")} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 z-40 mt-2 w-64 rounded-xl border border-line bg-card p-1.5 shadow-2xl"
        >
          <div className="border-b border-line px-3 py-2.5">
            <p className="truncate text-sm font-medium">{user.name || "Signed in"}</p>
            <p className="truncate text-xs text-ink-3">{user.email || ""}</p>
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={onSignOut}
            className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-ink-2 transition-colors hover:bg-raised hover:text-ink"
          >
            <LogOut size={17} aria-hidden />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
