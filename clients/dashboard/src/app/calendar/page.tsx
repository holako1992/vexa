/** `/calendar` (DB-34): calendar health — last sync, last error, events touched, and a Reconnect
 *  action for any connection whose grant needs it. See `src/components/CalendarHealthView.tsx`
 *  for the view itself. Distinct from `google/` and `microsoft/`, this directory's OAuth-callback
 *  subdirectories (see their own README), which have no nav-rail entry of their own. */
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { CalendarHealthView } from "@/components/CalendarHealthView";

export const dynamic = "force-dynamic";

export default async function CalendarPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      <CalendarHealthView />
    </Shell>
  );
}
