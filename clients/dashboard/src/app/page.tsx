/** Home — the meetings list inside the app shell for a signed-in person, the public landing page
 *  for everyone else.
 *
 *  The identity is resolved on the SERVER and passed down: the shell renders who you are without
 *  the browser ever being asked. `/` is the one page the middleware lets through without a session
 *  cookie, so no user here — no cookie, or one the identity oracle rejected — is a visitor, and a
 *  visitor gets the landing page with its doors to `/login`.
 */
import { Suspense } from "react";
import type { Metadata } from "next";
import { currentUser } from "@/lib/session";
import { fetchPlanSheet, productName } from "@/lib/planSheet";
import { Landing } from "@/components/landing/Landing";
import { Shell } from "@/components/Shell";
import { MeetingsView } from "@/components/MeetingsView";
import { LoadingState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

export function generateMetadata(): Metadata {
  const name = productName();
  return {
    title: `${name} — meeting notes, transcripts and summaries`,
    description: `${name} joins your Google Meet, Microsoft Teams and Zoom calls, transcribes them live and summarises them when they end.`,
    // The landing page is the one public page; the root layout keeps every other page out of indexes.
    robots: { index: true, follow: true },
  };
}

export default async function HomePage() {
  const user = await currentUser();
  if (!user) return <Landing productName={productName()} sheet={await fetchPlanSheet()} />;

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      {/* MeetingsView reads `?calendar=` (the return-from-Google-OAuth landing) via
          useSearchParams, which Next.js requires a Suspense boundary for even under
          force-dynamic. */}
      <Suspense fallback={<LoadingState label="Loading meetings…" />}>
        <MeetingsView />
      </Suspense>
    </Shell>
  );
}
