/** DB-44 — global search results page. No nav-rail entry (see `Shell.tsx`'s header comment for
 *  why): reached from the search box in the top bar, `Ctrl+K`/`Cmd+K`, or a link straight to a
 *  `?q=`. */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { SearchView } from "@/components/SearchView";
import { LoadingState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

export default async function SearchPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      {/* useSearchParams needs a Suspense boundary even under force-dynamic. */}
      <Suspense fallback={<LoadingState label="Loading search…" />}>
        <SearchView />
      </Suspense>
    </Shell>
  );
}
