# noon-sight

An MCP server on Cloudflare Workers that aggregates what a site publishes and how it is read. Google Analytics, Google Search Console and Cloudflare zone analytics answer how much; Buffer answers what was published and what it was about. Access is gated by Cloudflare Zero Trust.

Deliberately small: it carries the tools that are actually used, not a full API surface.

## Development

```sh
pnpm install
pnpm dev     # local Workers runtime
pnpm test    # tests on workerd
pnpm deploy  # deploy to Cloudflare
```

## License

Apache-2.0
