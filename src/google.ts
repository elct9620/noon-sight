import { env } from "cloudflare:workers";
import { SignJWT, importPKCS8 } from "jose";

/** Google mints the token here, and the assertion has to name it as audience. */
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Reading reports is all this server does, so it asks for nothing wider. */
const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

const CACHE_KEY = "google-access-token";

/**
 * A token handed out in its final seconds would expire mid-request, and KV
 * refuses a TTL under a minute; one minute of margin answers both.
 */
const EXPIRY_MARGIN_SECONDS = 60;

type ServiceAccount = { client_email: string; private_key: string };

type TokenResponse = { access_token: string; expires_in: number };

/**
 * The whole Service Account JSON is one secret rather than a field per value:
 * the private key is a PEM whose newlines survive JSON but not a shell.
 */
const serviceAccount = (): ServiceAccount => {
  if (!env.GOOGLE_SERVICE_ACCOUNT) {
    throw new Error("Google credentials are not configured");
  }

  return JSON.parse(env.GOOGLE_SERVICE_ACCOUNT);
};

/**
 * Workers carry no Node crypto, so the official Google SDK cannot run here.
 * jose signs the Service Account assertion and Google exchanges it for the
 * bearer token the Data API accepts.
 *
 * The token is the same for every caller and lives an hour, so it is cached
 * rather than minted per request; KV expires it by TTL and nothing deletes it.
 */
export const accessToken = async (): Promise<string> => {
  const cached = await env.TOKEN_CACHE.get(CACHE_KEY);
  if (cached) return cached;

  const { client_email, private_key } = serviceAccount();
  const assertion = await new SignJWT({ scope: SCOPE })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(client_email)
    .setAudience(TOKEN_ENDPOINT)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(await importPKCS8(private_key, "RS256"));

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  // Google's body names the credential it rejected, so only the status travels.
  if (!response.ok) {
    throw new Error(`Google refused the service account (${response.status})`);
  }

  const { access_token, expires_in } = await response.json<TokenResponse>();
  await env.TOKEN_CACHE.put(CACHE_KEY, access_token, {
    expirationTtl: expires_in - EXPIRY_MARGIN_SECONDS,
  });

  return access_token;
};
