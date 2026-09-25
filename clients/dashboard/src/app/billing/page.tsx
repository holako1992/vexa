/** `/billing` (DB-74's read-only half): plan, usage, and billing period, from `GET
 *  /api/vexa/user/entitlements`. Composed from `Shell` the same way every other page is; see
 *  `src/components/BillingView.tsx` for the view itself. */
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { Shell } from "@/components/Shell";
import { BillingView } from "@/components/BillingView";

export const dynamic = "force-dynamic";

export default async function BillingPage() {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <Shell user={{ email: user.email, name: user.name }}>
      <BillingView />
    </Shell>
  );
}
