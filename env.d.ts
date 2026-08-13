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
    GOOGLE_SERVICE_ACCOUNT?: string;
    GA_PROPERTY_ID?: string;
    GSC_SITE_URL?: string;
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ZONE_ID?: string;
    // A zone carries every hostname under it, so a server answering for one
    // site names it. Absent, the report covers the whole zone.
    CLOUDFLARE_SITE_HOST?: string;
    BUFFER_API_KEY?: string;
    // Every Buffer query names the organization it is asking about, and an
    // account may hold several. Naming it here rather than asking for it makes
    // it the same kind of setting as the property and the zone, and saves the
    // round trip that would otherwise start every report.
    BUFFER_ORGANIZATION_ID?: string;
  }
}
