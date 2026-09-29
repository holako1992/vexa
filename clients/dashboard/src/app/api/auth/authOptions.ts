/** NextAuth config for the dashboard's OAuth broker (Google + Microsoft).
 *
 *  NextAuth owns ONLY the provider dance. The dashboard's session contract is the httpOnly
 *  `vexa-token` + `vexa-user-info` cookies — the same contract the terminal holds — so `signIn`
 *  ends by writing exactly those, through the same find-or-create+mint path the email login uses.
 *  That is what makes a deployment fronting both clients on one domain a single sign-in.
 *
 *  Providers self-gate on credentials: a deployment with no OAuth secrets exposes no buttons
 *  rather than failing at the callback.
 *
 *  It lives beside `[...nextauth]/route.ts` rather than inside it because an App Router route file
 *  may only export HTTP handlers — re-exporting `authOptions` from there fails Next's route check.
 */
import { type AuthOptions } from "next-auth";
import GoogleProvider from "next-auth/providers/google";
import AzureADProvider from "next-auth/providers/azure-ad";
import { headers } from "next/headers";
import { findOrCreateUserToken, type IdentityProvenance } from "@/lib/adminApi";
import { setSessionCookies } from "@/lib/session";
import { clientAddress } from "@/lib/rateLimit";
import { isSecureDeployment } from "@/lib/security";

export const googleEnabled = () => !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const microsoftEnabled = () => !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET);

/** What the provider vouches for. Google states it per sign-in in the profile's `email_verified`
 *  claim, and only a literal `true` counts. Microsoft (Entra) accounts are provisioned and
 *  verified by their tenant, and its ID token carries no comparable claim, so a completed
 *  Microsoft sign-in is treated as verified. */
export function provenanceFor(provider: "google" | "microsoft", profile: unknown): IdentityProvenance {
  if (provider === "microsoft") return { provider, emailVerified: true };
  const claim = (profile as { email_verified?: unknown } | null | undefined)?.email_verified;
  return { provider, emailVerified: claim === true };
}

export const authOptions: AuthOptions = {
  providers: [
    // prompt=select_account forces the provider's account chooser every time, so after sign-out a
    // user can pick a different account instead of being silently re-authenticated into the last.
    ...(googleEnabled()
      ? [
          GoogleProvider({
            clientId: process.env.GOOGLE_CLIENT_ID!,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
            authorization: { params: { prompt: "select_account" } },
          }),
        ]
      : []),
    ...(microsoftEnabled()
      ? [
          AzureADProvider({
            id: "microsoft",
            name: "Microsoft",
            clientId: process.env.MICROSOFT_CLIENT_ID!,
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
            tenantId: process.env.MICROSOFT_TENANT_ID || "common",
            authorization: { params: { prompt: "select_account" } },
          }),
        ]
      : []),
  ],
  session: { strategy: "jwt" },
  secret: process.env.NEXTAUTH_SECRET,
  useSecureCookies: isSecureDeployment(),
  pages: { signIn: "/login", error: "/login" },
  callbacks: {
    /** The load-bearing step: a verified OAuth identity becomes the dashboard's session cookies.
     *  Any failure denies the sign-in, with its refusal code on `/login`, rather than landing the user in a half-authenticated shell. */
    async signIn({ user, account, profile }) {
      const provider = account?.provider;
      if ((provider !== "google" && provider !== "microsoft") || !user.email) return false;

      const result = await findOrCreateUserToken(
        user.email.toLowerCase(),
        clientAddress(await headers()),
        provenanceFor(provider, profile),
      );
      if (!result.ok) {
        console.error(`[dashboard-auth] ${provider} sign-in failed for ${user.email}: ${result.error}`);
        // A URL return sends the browser to /login with the refusal CODE; the page owns the words.
        return `/login?error=${result.refusal.code}`;
      }
      await setSessionCookies({ email: result.user.email, name: user.name || result.user.name }, result.token);
      return true;
    },
    /** Land back inside the app, honouring a SAME-SITE path so "you were going to /meetings/42"
     *  survives the round-trip. Anything off-origin collapses to the base URL — no open redirect. */
    async redirect({ url, baseUrl }) {
      if (url.startsWith("/")) return `${baseUrl}${url}`;
      if (url.startsWith(baseUrl)) return url;
      return baseUrl;
    },
  },
};
