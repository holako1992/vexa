/** One meeting's page. The id is a row id from the caller's own list; the data read behind it is
 *  owner-scoped at the gateway, so an id belonging to someone else returns nothing to render. */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { MeetingDetail } from "@/components/MeetingDetail";
import { LoadingState } from "@/components/EmptyState";

export const dynamic = "force-dynamic";

export default async function MeetingPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { meetingId } = await params;

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      {/* MeetingDetail reads `?t=` (DB-44's scroll-to-segment link) via useSearchParams, which
          Next.js requires a Suspense boundary for even under force-dynamic. */}
      <Suspense fallback={<LoadingState label="Loading meeting…" />}>
        <MeetingDetail meetingId={meetingId} />
      </Suspense>
    </Shell>
  );
}
