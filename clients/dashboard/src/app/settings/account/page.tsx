/** `/settings/account`: profile, sign-in method and active sessions, with "sign out everywhere".
 *  Composed from `Shell` like every other page; the view is `src/components/AccountView.tsx`. */
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { AccountView } from "@/components/AccountView";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      <AccountView />
    </Shell>
  );
}
