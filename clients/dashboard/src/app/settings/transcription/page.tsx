/** `/settings/transcription`: the default bot name and the transcription service. Composed from
 *  `Shell` like every other page; the view is `TranscriptionSettingsView.tsx` beside this file. */
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { TranscriptionSettingsView } from "./TranscriptionSettingsView";

export const dynamic = "force-dynamic";

export default async function TranscriptionSettingsPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      <TranscriptionSettingsView />
    </Shell>
  );
}
