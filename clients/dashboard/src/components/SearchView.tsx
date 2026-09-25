"use client";
/** DB-44 — global search results: `GET /transcripts/search`, grouped by meeting, snippets
 *  highlighted.
 *
 *  Three distinct states other than "here are your results" (`components/README.md`'s rule,
 *  already enforced elsewhere by `EmptyState`/`ErrorState`/`LoadingState`): loading, failed, and
 *  genuinely no hits — a failure must never render as "nothing matched". A fourth, `idle`, covers
 *  the page with no query yet (reached via the mobile search link rather than a submitted term).
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import { getJson, presentError } from "@/lib/api";
import { formatClock, platformLabel } from "@/lib/meetings";
import { groupHitsByMeeting, highlightSnippet, type SearchResponseDTO } from "@/lib/search";
import { EmptyState, ErrorState, LoadingState } from "./EmptyState";
import { Input } from "./ui";

const SEARCH_LIMIT = 40;

export function SearchView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const q = (searchParams.get("q") || "").trim();

  const [inputValue, setInputValue] = useState(q);
  const [result, setResult] = useState<SearchResponseDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Bumped by `retry()` below to re-run the fetch effect without changing `q` itself.
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => setInputValue(q), [q]);

  useEffect(() => {
    if (!q) {
      setResult(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getJson<SearchResponseDTO>(`/api/vexa/transcripts/search?q=${encodeURIComponent(q)}&limit=${SEARCH_LIMIT}`)
      .then((body) => {
        if (cancelled) return;
        setResult(body);
      })
      .catch((e) => {
        if (cancelled) return;
        console.warn("search failed", e);
        setError(presentError(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [q, retryTick]);

  const groups = useMemo(() => groupHitsByMeeting(result?.hits ?? []), [result]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const next = inputValue.trim();
    if (!next) return;
    router.push(`/search?q=${encodeURIComponent(next)}`);
  }

  function retry() {
    setError(null);
    setRetryTick((n) => n + 1);
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8 md:py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Search</h1>
        <p className="mt-1 text-sm text-ink-2">Across everything Vexa has transcribed for you.</p>
      </header>

      <form onSubmit={onSubmit} className="mb-6">
        <Input
          type="search"
          value={inputValue}
          onChange={(e) => setInputValue(e.target.value)}
          placeholder="Search meetings & transcripts"
          aria-label="Search meetings and transcripts"
          icon={<Search size={16} aria-hidden />}
          className="bg-card py-2.5"
          autoFocus
        />
      </form>

      {!q && <EmptyState title="Search across every meeting you've sent a bot to." hint="Try a word or phrase someone said." />}

      {q && loading && <LoadingState label={`Searching for "${q}"…`} />}

      {q && !loading && error && <ErrorState message={error} onRetry={retry} />}

      {q && !loading && !error && groups.length === 0 && (
        <EmptyState title={`No matches for "${q}".`} hint="Try fewer or different words." />
      )}

      {q && !loading && !error && groups.length > 0 && (
        <ul className="space-y-5">
          {groups.map((group) => (
            <li key={group.meetingDbId} className="rounded-card border border-line bg-card p-4">
              <h2 className="mb-2 text-sm font-medium">
                <Link href={`/meetings/${group.meetingDbId}`} className="hover:underline">
                  {platformLabel(group.platform)} · {group.nativeMeetingId}
                </Link>
              </h2>
              <ul className="space-y-2.5">
                {group.hits.map((hit, i) => (
                  <li key={`${hit.meeting_db_id}-${i}-${hit.start}`}>
                    <Link
                      href={`/meetings/${group.meetingDbId}?t=${Math.floor(hit.start)}`}
                      className="block rounded-lg px-2 py-1.5 text-sm text-ink-2 transition-colors hover:bg-raised hover:text-ink"
                    >
                      <span className="mr-2 text-xs tabular-nums text-ink-3">{formatClock(hit.start)}</span>
                      {hit.speaker && <span className="mr-1 font-medium text-ink">{hit.speaker}:</span>}
                      {highlightSnippet(hit.snippet, q).map((seg, si) =>
                        seg.matched ? (
                          <mark key={si} className="rounded bg-accent-soft px-0.5 text-accent">
                            {seg.text}
                          </mark>
                        ) : (
                          <span key={si}>{seg.text}</span>
                        ),
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
