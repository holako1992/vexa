/** `/recordings`: every recording the caller owns, from `GET /api/vexa/recordings`.
 *  Composed from `Shell` the same way every other page is; see `src/components/RecordingsView.tsx`
 *  for the view itself. */
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { RecordingsView } from "@/components/RecordingsView";

export const dynamic = "force-dynamic";

export default async function RecordingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      <RecordingsView />
    </Shell>
  );
}
