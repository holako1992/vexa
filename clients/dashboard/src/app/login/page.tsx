/** The sign-in page.
 *
 *  Which sign-in methods exist is computed HERE, on the server, from environment the browser never
 *  sees. The client component receives three booleans — not a client id, not a secret, not a
 *  provider URL.
 */
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/session";
import { googleEnabled, microsoftEnabled } from "../api/auth/authOptions";
import { LoginForm } from "@/components/LoginForm";

export const dynamic = "force-dynamic";

export default async function LoginPage() {
  // Someone whose session is still good has no business here. A cookie the oracle rejects (revoked
  // or expired) is not a session, so the form renders and signing in replaces it.
  if (await currentUser()) redirect("/");
  const options = {
    google: googleEnabled(),
    microsoft: microsoftEnabled(),
    emailLogin: process.env.DASHBOARD_ALLOW_EMAIL_LOGIN === "true",
  };
  // useSearchParams (the `next` target) needs a Suspense boundary in the App Router.
  return (
    <Suspense>
      <LoginForm options={options} />
    </Suspense>
  );
}
