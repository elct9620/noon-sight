import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

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
        },
      },
    }),
  ],
});
