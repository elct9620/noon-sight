# noon-sight

An MCP server on Cloudflare Workers that aggregates what a site publishes and how it is read. Four sources answer four questions, and Cloudflare Zero Trust guards the door.

Deliberately small: it carries the tools that are actually used, not a full API surface.

## What each source can see

```
    published  ────▶  shown  ────▶  requested  ────▶  rendered
        │               │              │                 │
     Buffer      Search Console    Cloudflare     Google Analytics
        │               │              │                 │
  content_report   search_report  request_report    traffic_report
```

A source earns its place by answering what the others structurally cannot. Search Console is the only one that counts people who were shown the site and did not come. Cloudflare sits in front of the request and sees whoever asked, including everything that runs no JavaScript and so reaches neither of the others. Analytics only ever meets someone who already arrived and rendered the page. Buffer is the only one that says what the site is about rather than how it was read.

Every figure is what one measurement system saw, not what happened — two sources disagreeing does not make either wrong.

## Tools

| Tool             | Source                           | Answers with                                                   | `breakdown` (up to 2)                                                  | Other input                    | Default window         |
| ---------------- | -------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------- | ------------------------------ | ---------------------- |
| `traffic_report` | Google Analytics                 | sessions, users, engagement, duration, key events              | `channel` `source` `page` `country` `language` `device` `visitor_type` | `where` `days` `until` `limit` | 28 days, paired        |
| `search_report`  | Google Search Console            | clicks, impressions, CTR, average position                     | `query` `page` `country` `device`                                      | `where` `days` `until` `limit` | 28 days, paired        |
| `request_report` | Cloudflare zone analytics        | requests and bytes at the edge                                 | `bot` `page` `country` `device` `status` `host`                        | `where` `days` `until` `limit` | 7 days, paired if kept |
| `content_report` | Buffer, and the pages themselves | the posts themselves, with what each page declares it is about | —                                                                      | `kind` `days` `until` `limit`  | 28 days, unpaired      |

The first three are quantitative and share one shape: every row is a pair, the requested period against the equally long one before it, because whether a number rose is the question worth answering and one number cannot say it. Where a source no longer holds the earlier period it says so, and the pair reads null — an absence of record rather than an absence of traffic.

The fourth is qualitative and inherits none of that shape. A single request means nothing alone, which is why traffic is grouped and counted; a single post is already the whole of what it says, and `8 posts about Ruby` is what a reader knew before asking. Counting is theirs to do, on the text they now hold.

How to read the answers arrives with the handshake as MCP `instructions`, rather than as a tool nobody thinks to call.

## How a request flows

```
        ┌──────────────┐
        │  MCP client  │   Claude, or anything that speaks MCP
        └──────┬───────┘
               │  401 challenge → OAuth → Access policy evaluated
        ┌──────▼──────────────────────┐
        │  Cloudflare Access          │   Managed OAuth, one application
        └──────┬──────────────────────┘
               │  POST /mcp  +  Cf-Access-Jwt-Assertion
        ┌──────▼──────────────────────────────────────────────┐
        │  Worker — noon-sight                                │
        │  Hono /mcp → jose verifies iss + aud → MCP server   │
        └───┬──────────┬───────────┬────────────┬─────────────┘
            │          │           │            │
      Analytics    Search      Cloudflare   Buffer GraphQL
      Data API     Console     GraphQL      + the site's own pages
            └── Service ───┘   API token    API key
                Account JWT
```

An MCP client is not a browser and cannot follow Access's `302`, so Managed OAuth answers it with a `401` challenge instead. Access resolves the resulting token itself and still forwards `Cf-Access-Jwt-Assertion`, so the Worker implements no OAuth of its own and an OAuth request is indistinguishable from a browser one.

Two KV namespaces, both provisioned by wrangler and named after the Worker:

| Binding         | Holds                            | Gone after                                |
| --------------- | -------------------------------- | ----------------------------------------- |
| `TOKEN_CACHE`   | the Google access token          | its lifetime less five minutes            |
| `CONTENT_CACHE` | what a page declared it is about | 30 days; one that declared nothing, a day |

## Setup

Access cannot be named before it exists, so the order matters at exactly one point:

```
 pnpm deploy  ────▶  Access application  ────▶  TEAM_DOMAIN + POLICY_AUD  ────▶  sources
      ▲                on that hostname              Access now enforced        one at a time,
      │                                                                         in any order
 403 "Access is not configured" until the secrets land — the intended state, not a fault
```

Each source stands alone. A tool whose source is unconfigured stays registered and says what is missing, so the server is useful with one source configured and complete with four; withholding it would leave a caller unable to tell a server half set up from a site with nothing to report.

### 1. The Worker

```sh
pnpm install
pnpm deploy
```

The route in `wrangler.jsonc` is a custom domain, and is the hostname to change for your own deployment. `workers.dev` and per-version preview URLs are deliberately not minted: Access is enabled per hostname, so every entrance has to be one somebody remembers to guard.

### 2. Cloudflare Access

| Step                        | Where                                | What                                                                                            |
| --------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Add the application         | Zero Trust → Access → Applications   | Self-hosted, on the Worker's hostname                                                           |
| Add a policy                | the same application                 | Whoever may read the site's numbers                                                             |
| Turn on Managed OAuth       | the application → Advanced settings  | Turns Access into an OAuth server for this application, so a non-browser client can log in      |
| Allow the client's callback | the same tab → Allowed redirect URIs | `https://claude.ai/api/mcp/auth_callback` for the hosted client, a loopback URI for a local one |
| Read the AUD                | the application's overview           | The Application Audience tag                                                                    |

| Secret        | Value                                                                                                    |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com`, scheme included — it is both the JWKS host and the expected `iss` |
| `POLICY_AUD`  | The Application Audience tag                                                                             |

```sh
pnpm wrangler secret put TEAM_DOMAIN
pnpm wrangler secret put POLICY_AUD
```

A further hostname joins this same application as an additional public hostname. A second application would mint a second AUD, and one `POLICY_AUD` cannot match both. Managed OAuth registers each client dynamically, and a client whose registration Access refused keeps that failure until it is removed and added again — allowlisting its callback afterwards is not enough on its own.

### 3. Google Analytics and Search Console

One Service Account serves both, and asks for nothing wider than the two read scopes.

| Step                                 | Where                                             | What                                                                                                      |
| ------------------------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Enable the APIs                      | Google Cloud → APIs & Services                    | Google Analytics Data API, Google Search Console API                                                      |
| Create the account and a JSON key    | Google Cloud → IAM & Admin → Service Accounts     | The downloaded JSON file is the secret, whole                                                             |
| Grant it the GA4 property            | GA4 → Admin → Property access management          | Its e-mail, as Viewer                                                                                     |
| Grant it the Search Console property | Search Console → Settings → Users and permissions | The same e-mail, Full or Restricted. Google Cloud grants nothing here — the property's own user list does |

| Secret                   | Value                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_SERVICE_ACCOUNT` | The whole Service Account JSON, verbatim — one secret rather than a field per value, because the private key is a PEM whose newlines survive JSON but not a shell |
| `GA_PROPERTY_ID`         | The numeric GA4 property id, from Admin → Property details                                                                                                        |
| `GSC_SITE_URL`           | Whatever string `sites.list` returns, verbatim — `sc-domain:example.com` or a trailing-slash URL. A near miss answers `403`                                       |

Workers carry no Node crypto, so the official Google SDK cannot run here: jose signs the Service Account assertion and Google exchanges it for a bearer token, cached in KV for its hour.

### 4. Cloudflare zone analytics

| Step             | Where                                           | What                                                                                                 |
| ---------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Create the token | My Profile → API Tokens → Create Token → Custom | `Zone / Analytics / Read`, scoped to the one zone. `Logs / Read` opens raw events nothing here reads |
| Read the zone id | the zone's Overview page, under API             |                                                                                                      |

| Secret                 | Value                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN` | The token as it stands — it is the credential rather than a claim to be exchanged for one, so nothing is signed or cached |
| `CLOUDFLARE_ZONE_ID`   | The zone the site lives in                                                                                                |
| `CLOUDFLARE_SITE_HOST` | The hostname this server answers for, e.g. `blog.example.com`                                                             |

A zone is a billing boundary carrying every hostname under it, so this source takes two identifiers where the others take one. `CLOUDFLARE_SITE_HOST` is then read twice over: it says which site inside the zone a request report covers, and it is what makes a link in a post a link to this site rather than to anywhere else. Left unset, a request report covers the whole zone and every shared page reads as somebody else's.

A refusal from this API arrives as `200` with an `errors` array, so a token without the permission, a field the plan does not carry and a window wider than it allows all look like success to anything reading the status. The tool reads the array and says what Cloudflare said.

### 5. Buffer

| Step                     | Where                                   | What                                                          |
| ------------------------ | --------------------------------------- | ------------------------------------------------------------- |
| Create the API key       | https://publish.buffer.com/settings/api |                                                               |
| Find the organization id | one query, below                        | An account may hold several, and every Buffer query names one |

```sh
curl -s https://api.buffer.com \
  -H "Authorization: Bearer $BUFFER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ account { organizations { id name } } }"}'
```

| Secret                   | Value                                   |
| ------------------------ | --------------------------------------- |
| `BUFFER_API_KEY`         | The key as it stands, like Cloudflare's |
| `BUFFER_ORGANIZATION_ID` | The `id` the query above answers with   |

Naming the organization in configuration makes it the same kind of value as the property and the zone, and spares every report the round trip that would otherwise start it.

`content_report` then asks each linked page what it is about over the public web — `Accept: text/markdown` first, then schema.org in the HTML — so `CLOUDFLARE_SITE_HOST` is what tells a link to this site from a link anywhere else. A page declaring nothing is reported as declaring nothing, which is not the same as not being published.

### Every secret at a glance

| Secret                                      | Unlocks                           | Without it                                                       |
| ------------------------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `TEAM_DOMAIN` `POLICY_AUD`                  | every request                     | `403 Access is not configured`                                   |
| `GOOGLE_SERVICE_ACCOUNT`                    | `traffic_report` `search_report`  | both refuse, saying Google credentials are not configured        |
| `GA_PROPERTY_ID`                            | `traffic_report`                  | it refuses, saying no property is configured                     |
| `GSC_SITE_URL`                              | `search_report`                   | it refuses, saying no property is configured                     |
| `CLOUDFLARE_API_TOKEN` `CLOUDFLARE_ZONE_ID` | `request_report`                  | it refuses, naming the one that is missing                       |
| `CLOUDFLARE_SITE_HOST`                      | `request_report` `content_report` | the zone answers whole, and no post is recognised as this site's |
| `BUFFER_API_KEY` `BUFFER_ORGANIZATION_ID`   | `content_report`                  | it refuses, naming the one that is missing                       |

Secrets live in `wrangler secret` and `.dev.vars`, never in `wrangler.jsonc`. Cloudflare classes the first two as vars rather than secrets; keeping them out of the repository costs nothing and publishes neither the team nor the application being guarded.

## Local development

`.dev.vars` carries the same names, plus `DEBUG=true`, which skips Access verification — local development has no Access in front of it. Production reads `undefined` for the flag, so denial is what the absence of configuration already produces, and vitest pins it off so the suite cannot be disarmed by a developer's local file.

| Command           | Does                                                           |
| ----------------- | -------------------------------------------------------------- |
| `pnpm dev`        | Runs locally on workerd, reading `.dev.vars`                   |
| `pnpm test`       | Runs the suite on workerd, outbound requests answered by MSW   |
| `pnpm typecheck`  | Typechecks `src` and `test` as separate projects               |
| `pnpm format`     | Prettier; `format:check` verifies without writing              |
| `pnpm deploy`     | Deploys to Cloudflare                                          |
| `pnpm cf-typegen` | Regenerates binding types; run after changing `wrangler.jsonc` |

## Connecting a client

Add `https://<your-hostname>/mcp` as a remote MCP server. The first call is answered with a `401` naming Access's OAuth endpoints, the client registers itself and walks the flow, and Access evaluates its policy before any request reaches the Worker.

## License

Apache-2.0
