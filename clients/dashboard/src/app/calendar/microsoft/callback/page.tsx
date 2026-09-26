/** DB-32/DB-33 — Microsoft's OAuth redirect target: `MICROSOFT_CALENDAR_REDIRECT_URI` is set to
 *  this exact page (see `docs/docs/how-to/calendar-sync.mdx`'s self-hosting section). No nav-rail
 *  entry — reached only from Microsoft's own redirect, the same way `/search` is reached only
 *  from the search box (`Shell.tsx`'s header comment). Renders the provider-shared
 *  `CalendarOAuthCallback` (see that file's header comment); `../../google/callback/page.tsx` is
 *  its sibling. */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { CalendarOAuthCallback } from "@/components/CalendarOAuthCallback";
import { LoadingState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

export default async function MicrosoftCalendarCallbackPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      {/* useSearchParams needs a Suspense boundary even under force-dynamic. */}
      <Suspense fallback={<LoadingState label="Finishing Microsoft 365 connection…" />}>
        <CalendarOAuthCallback provider="microsoft" />
      </Suspense>
    </Shell>
  );
}
