// Secrets and the local debug flag never enter wrangler.jsonc, so
// `wrangler types` cannot see them. Every one is optional because every one can
// genuinely be absent — DEBUG outside local development, POLICY_AUD before the
// Access application exists — and optionality makes handling that absence a
// typecheck requirement rather than a discipline.
declare namespace Cloudflare {
  interface Env {
    TEAM_DOMAIN?: string;
    POLICY_AUD?: string;
    DEBUG?: string;
  }
}
