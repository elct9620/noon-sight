# noon-sight

An MCP server on Cloudflare Workers that exposes Google Analytics, Google Search Console and Cloudflare zone analytics as MCP tools. Access is gated by Cloudflare Zero Trust.

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
