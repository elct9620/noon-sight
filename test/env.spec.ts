import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// `.dev.vars` is read by the test runtime as well as by `wrangler dev`, so a
// developer's local DEBUG=true would otherwise disable verification for the
// whole suite while every test stayed green. The bindings pinned in
// vitest.config.ts are what stop that, and this is the alarm if they go.
describe("test environment", () => {
  it("never enables the debug bypass", () => {
    expect(env.DEBUG).not.toBe("true");
  });

  it("carries the Access identity the verifier needs", () => {
    expect(env.TEAM_DOMAIN).toBe("https://test.cloudflareaccess.com");
    expect(env.POLICY_AUD).toBe("test-policy-aud");
  });

  // A developer's own Service Account would sign assertions that reach Google
  // for real, so the suite signs with a key it generated instead.
  it("signs with a generated service account rather than a developer's", () => {
    expect(env.GOOGLE_SERVICE_ACCOUNT).toContain(
      "noon-sight@test.iam.gserviceaccount.com",
    );
  });
});
