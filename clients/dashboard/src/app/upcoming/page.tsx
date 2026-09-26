/** `/upcoming` (DB-33): meetings Vexa is watching for, grouped by day, with the per-meeting
 *  Join / Don't join override and "Sync now". See `src/components/UpcomingView.tsx` for the view
 *  itself and where its data comes from. */
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { UpcomingView } from "@/components/UpcomingView";

export const dynamic = "force-dynamic";

export default async function UpcomingPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      <UpcomingView />
    </Shell>
  );
}
