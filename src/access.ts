import { env } from "cloudflare:workers";
import { createMiddleware } from "hono/factory";
import { type JWTVerifyGetKey, type KeyInput, jwtVerify } from "jose";

/** Access forwards its signed assertion under this header on every request. */
const ASSERTION_HEADER = "Cf-Access-Jwt-Assertion";

/**
 * Local development has no Access in front of it, so the flag lives only in
 * `.dev.vars`. Production reads `undefined` and therefore denies.
 */
export const isBypassed = (debug?: string) => debug === "true";

/**
 * Trust comes from the signature, not from the header being present: a Worker
 * is reachable at its workers.dev URL, so an unverified assertion is one an
 * attacker can write.
 *
 * The team domain is re-checked here rather than taken on faith from the
 * caller, because passing it to jose as `undefined` would drop the issuer
 * comparison and accept any team's token.
 */
export const accessGuard = (keys?: KeyInput | JWTVerifyGetKey) =>
  createMiddleware(async (c, next) => {
    if (isBypassed(env.DEBUG)) return next();

    const { TEAM_DOMAIN, POLICY_AUD } = env;
    if (!keys || !TEAM_DOMAIN || !POLICY_AUD) {
      // Named apart from a denied token: this one is answered by setting a
      // secret, and a fresh deployment hits it before the Access application
      // exists.
      return c.text("Access is not configured", 403);
    }

    const token = c.req.header(ASSERTION_HEADER);
    if (!token) return c.text("Forbidden", 403);

    try {
      await jwtVerify(token, keys, {
        issuer: TEAM_DOMAIN,
        audience: POLICY_AUD,
      });
    } catch {
      return c.text("Forbidden", 403);
    }

    return next();
  });
