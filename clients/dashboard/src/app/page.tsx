/** Home — the meetings list, inside the app shell.
 *
 *  The identity is resolved on the SERVER and passed down: the shell renders who you are without
 *  the browser ever being asked. The middleware already refused this request without a session,
 *  so a null user here means the session was rejected by the identity oracle between the two —
 *  which is a sign-out, not an error page.
 */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { MeetingsView } from "@/components/MeetingsView";
import { LoadingState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      {/* MeetingsView reads `?calendar=` (DB-31's return-from-Google-OAuth landing) via
          useSearchParams, which Next.js requires a Suspense boundary for even under
          force-dynamic. */}
      <Suspense fallback={<LoadingState label="Loading meetings…" />}>
        <MeetingsView />
      </Suspense>
    </Shell>
  );
}
