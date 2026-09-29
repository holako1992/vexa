/** Runs once when the Next.js server starts. A production dashboard without its identity-oracle
 *  secret stops here, with the variable named, instead of serving unverifiable sessions. */
import { startupRefusal } from "./lib/startupConfig";

export function register(): void {
  const refusal = startupRefusal(process.env);
  if (refusal) throw new Error(refusal);
}
