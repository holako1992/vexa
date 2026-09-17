/** The NextAuth handler. Configuration lives in ../authOptions.ts — a route file may only export
 *  HTTP handlers. */
import NextAuth from "next-auth";
import { authOptions } from "../authOptions";

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
