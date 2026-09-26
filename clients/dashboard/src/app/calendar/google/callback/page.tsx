/** DB-31 — Google's OAuth redirect target: `GOOGLE_CALENDAR_REDIRECT_URI` is set to this exact
 *  page (see `docs/docs/how-to/calendar-sync.mdx`'s self-hosting section). No nav-rail entry —
 *  reached only from Google's own redirect, the same way `/search` is reached only from the
 *  search box (`Shell.tsx`'s header comment). */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { GoogleCalendarCallback } from "@/components/GoogleCalendarCallback";
import { LoadingState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

export default async function GoogleCalendarCallbackPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      {/* useSearchParams needs a Suspense boundary even under force-dynamic. */}
      <Suspense fallback={<LoadingState label="Finishing Google Calendar connection…" />}>
        <GoogleCalendarCallback />
      </Suspense>
    </Shell>
  );
}
