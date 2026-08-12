import { env } from "cloudflare:workers";
import { decodeJwt } from "jose";
import { HttpResponse, http } from "msw";
import { beforeEach, describe, expect, it } from "vitest";
import { accessToken } from "../src/google";
import { server } from "./setup";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Every exchange Google is asked for lands here, so a test can say how many
// there should have been.
let exchanges: FormData[];

const mints = (token: string, expiresIn = 3600) =>
  server.use(
    http.post(TOKEN_ENDPOINT, async ({ request }) => {
      exchanges.push(await request.formData());
      return HttpResponse.json({
        access_token: token,
        expires_in: expiresIn,
        token_type: "Bearer",
      });
    }),
  );

beforeEach(async () => {
  exchanges = [];
  // Storage is shared across the cases in this file, so a token one case
  // cached would otherwise answer the next one's first call.
  const { keys } = await env.TOKEN_CACHE.list();
  await Promise.all(keys.map(({ name }) => env.TOKEN_CACHE.delete(name)));
});

describe("accessToken", () => {
  it("exchanges a signed assertion for a bearer token", async () => {
    mints("ya29.first");

    expect(await accessToken()).toBe("ya29.first");
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0].get("grant_type")).toBe(
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
  });

  // Signing is where workerd has to import the PKCS#8 private key, so the
  // assertion arriving well-formed is what proves that import happened.
  it("names the service account, the token endpoint and the read scope", async () => {
    mints("ya29.claims");
    await accessToken();

    expect(decodeJwt(String(exchanges[0].get("assertion")))).toMatchObject({
      iss: "noon-sight@test.iam.gserviceaccount.com",
      aud: TOKEN_ENDPOINT,
      scope: "https://www.googleapis.com/auth/analytics.readonly",
    });
  });

  it("serves a second call from the cache instead of exchanging again", async () => {
    mints("ya29.cached");

    expect(await accessToken()).toBe("ya29.cached");
    expect(await accessToken()).toBe("ya29.cached");
    expect(exchanges).toHaveLength(1);
  });

  // Google's rejection body names the credential it refused, so the caller is
  // told the request failed and nothing more.
  it("reports a refusal without repeating what Google said", async () => {
    server.use(
      http.post(TOKEN_ENDPOINT, () =>
        HttpResponse.json(
          {
            error: "invalid_grant",
            error_description: "Invalid JWT Signature",
          },
          { status: 400 },
        ),
      ),
    );

    await expect(accessToken()).rejects.toThrow(
      "Google refused the service account (400)",
    );
  });
});
