/** One meeting's page. The id is a row id from the caller's own list; the data read behind it is
 *  owner-scoped at the gateway, so an id belonging to someone else returns nothing to render. */
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { MeetingDetail } from "@/components/MeetingDetail";

export const dynamic = "force-dynamic";

export default async function MeetingPage({ params }: { params: Promise<{ meetingId: string }> }) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const { meetingId } = await params;

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      <MeetingDetail meetingId={meetingId} />
    </Shell>
  );
}
