import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { exportPKCS8, generateKeyPair } from "jose";
import { defineConfig } from "vitest/config";

// Generated rather than written out: importing a PKCS#8 key is the part of the
// Service Account flow that workerd has to support, and a placeholder string
// would let the suite pass without ever asking it to.
const { privateKey } = await generateKeyPair("RS256", { extractable: true });

export default defineConfig({
  test: {
    setupFiles: ["./test/setup.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Pinned rather than inherited: the runtime reads `.dev.vars` too, so a
      // key left unnamed here keeps whatever the developer set locally.
      miniflare: {
        bindings: {
          DEBUG: "false",
          TEAM_DOMAIN: "https://test.cloudflareaccess.com",
          POLICY_AUD: "test-policy-aud",
          GA_PROPERTY_ID: "123456",
          GSC_SITE_URL: "sc-domain:test.example",
          CLOUDFLARE_API_TOKEN: "cf-test-token",
          CLOUDFLARE_ZONE_ID: "zone-test",
          CLOUDFLARE_SITE_HOST: "blog.test.example",
          GOOGLE_SERVICE_ACCOUNT: JSON.stringify({
            client_email: "noon-sight@test.iam.gserviceaccount.com",
            private_key: await exportPKCS8(privateKey),
          }),
        },
      },
    }),
  ],
});
