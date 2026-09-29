/** The configuration a production dashboard refuses to start without.
 *
 *  Pure so it is tested directly: `instrumentation.ts` feeds it the environment at server start.
 *  `next dev`, tests and `next build` are not production serving and are never refused.
 */

export interface StartupEnv {
  NODE_ENV?: string;
  NEXT_PHASE?: string;
  VEXA_INTERNAL_API_SECRET?: string;
}

/** The refusal message, or `null` when the environment may start. The identity oracle's secret is
 *  required in production: without it `/api/auth/me` could only report `verified: false`, and a
 *  signed-in identity would never be checked against admin-api. */
export function startupRefusal(env: StartupEnv): string | null {
  if (env.NODE_ENV !== "production") return null;
  if (env.NEXT_PHASE === "phase-production-build") return null;
  if (!(env.VEXA_INTERNAL_API_SECRET || "").trim()) {
    return (
      "VEXA_INTERNAL_API_SECRET is required in production: the dashboard verifies every signed-in " +
      "identity against admin-api with it. Set it to the deployment's INTERNAL_API_SECRET."
    );
  }
  return null;
}
