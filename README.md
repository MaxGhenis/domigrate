# domigrate

End-to-end domain registrar migrations from the command line. Any
source (GoDaddy, Squarespace today; Namecheap, Porkbun, Name.com next)
to any destination (Cloudflare today). Resumable, no source-registrar
credentials stored on disk, and robust to UI redesigns.

## Why this tool exists

Every other migration tool is one of:

- **API-only** (e.g. `nodaddy`) — breaks when the source registrar
  paywalls its API, as GoDaddy did in May 2024.
- **Chrome-extension DOM-scraping** — breaks every time the source
  registrar ships a redesign.
- **"Bulk" helpers that only add zones to Cloudflare** — the
  automatable half. Leaves you doing the transfer submission by hand.

None covered both Squarespace (no API) and GoDaddy (paywalled API),
which together make up most small-portfolio migrations.

domigrate is different in two ways:

1. **Browser side attaches to your already-running Chrome over CDP**
   (`--remote-debugging-port=9222`), so it inherits your sessions and
   2FA. Nothing on disk to steal.
2. **LLM-assisted extraction** — instead of brittle CSS selectors, we
   hand the page HTML to a small fast model with a `zod` schema
   (routed via the Vercel AI Gateway). Any registrar's UI is supported
   without writing selectors.

The state machine is SQLite-backed, so every command is resumable:
crash after the auth-code step and the next run picks up at transfer
submission.

## Install

```bash
bun install -g domigrate        # once published; for now see "Developing"
```

## Setup

### 1. Chrome with remote debugging

On macOS, create a wrapper that launches Chrome with the debugging
port:

```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/Library/Application Support/Google/Chrome"
```

Or package it as `~/Applications/Chrome (debug).app` and keep it in
the Dock.

Sign into GoDaddy / Squarespace / whichever source registrar in that
Chrome instance. domigrate never handles your login; it attaches to
tabs you own.

### 2. Cloudflare credentials

```bash
export CLOUDFLARE_API_TOKEN="..."         # for zone + DNS ops (scoped token OK)
export CLOUDFLARE_GLOBAL_API_KEY="..."    # required to submit transfers
export CLOUDFLARE_EMAIL="you@example.com" # with GLOBAL_API_KEY
```

The scoped token can be minimal — `Zone:Edit`, `DNS:Edit`. The
undocumented registrar transfer endpoints do not yet accept scoped
tokens, so transfer submission needs the Global API Key.

### 3. LLM provider (for browser-driven sources)

Source plugins extract structured data from HTML via an LLM. Pick one:

```bash
# Preferred — any model, via the Vercel AI Gateway
export AI_GATEWAY_API_KEY="..."      # https://vercel.com/ai-gateway

# Or use OpenAI directly if you already have a key
export OPENAI_API_KEY="..."
```

Pure-API source plugins (none yet) would not need this.

### 4. Registrant contact

Create `~/.config/domigrate/contact.json`:

```json
{
  "first_name": "Ada",
  "last_name":  "Lovelace",
  "organization": "Analytical Engines Inc.",
  "email":      "ada@example.com",
  "phone":      "+1.5555551212",
  "address":    "1 Analytical Way",
  "city":       "Washington",
  "state":      "DC",
  "zip":        "20001",
  "country":    "US"
}
```

This is sent to the destination registrar as the new registrant of
record.

## Usage

```bash
# 1. Enumerate everything at GoDaddy (or Squarespace, or both).
domigrate gather --source godaddy
domigrate gather --source squarespace

# 2. Check the state table.
domigrate status

# 3. Run the pipeline.
domigrate transfer --all              # everything not yet completed
domigrate transfer example.com        # one domain
domigrate transfer --all --dns-only   # just add zones + scan DNS

# 4. Squarespace emails auth codes — record one manually:
domigrate code example.com ABCD-1234

# 5. After the source emails you the transfer confirmation:
domigrate complete example.com
```

## State machine

Each domain advances through these statuses, persisted in SQLite:

```
discovered → zone_created → unlocked → auth_code_retrieved
                                     → transfer_submitted
                                     → awaiting_approval
                                     → completed
```

`error` is a side state: the error message is stored and the domain is
retried from its prior good status on the next run.

## Architecture

```
src/
  cli.ts                     # plain argv dispatch (no commander)
  state.ts                   # bun:sqlite state machine
  cdp.ts                     # minimal Chrome DevTools Protocol client
  browser.ts                 # thin wrapper around CDP for source plugins
  ai.ts                      # AI SDK (Gateway or OpenAI direct)
  types.ts                   # SourceRegistrar / DestinationRegistrar
  sources/
    godaddy.ts               # browser-driven
    squarespace.ts           # browser-driven
  destinations/
    cloudflare.ts            # API, incl. undocumented transfer endpoints
  commands/
    gather.ts  transfer.ts  status.ts  code.ts  complete.ts
```

We use raw CDP (WebSocket + fetch) rather than Playwright/Puppeteer so
that:
  - nothing is spawned (safer when other Chrome automation tools are
    running), and
  - target-enumeration time stays O(1) regardless of how many tabs the
    user has open (Playwright-JS handshake times out on very large
    sessions).

Adding a new **source** registrar: implement `SourceRegistrar` (three
methods: `list`, `unlock`, `getAuthCode`). Drop it in
`src/sources/index.ts`. If you're browser-driven, use `extractFromHtml`
to avoid selectors.

Adding a new **destination** registrar: implement
`DestinationRegistrar` (`addZone`, `scanDns`, `submitTransfer`).

## Developing

```bash
bun install
bun test
bun typecheck
bun run src/cli.ts status
```

Tests mock `fetch` and never hit the network.

## Limitations & design choices

- **Registrar transfer endpoints on Cloudflare are undocumented.** We
  use the request shapes observed in the dashboard's network traffic
  (independently confirmed by `alexinslc/nodaddy`). They could change;
  the `submitTransfer` call is isolated so a fix is one file.
- **GoDaddy API is not used.** It is paywalled and unreliable for
  small portfolios. The browser plugin handles everything.
- **Squarespace emails auth codes** rather than displaying them. The
  plugin clicks the "send" button for you; the `domigrate code` command
  records the emailed code.
- **ICANN mandates a confirmation email** from the losing registrar
  that only a human can click. This is intentional anti-hijacking
  friction and cannot be automated.
- **We never try to log you in.** If your Chrome session is expired,
  you'll get a clear error telling you to sign in yourself.

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Pull requests welcome, especially:
- new source plugins (Namecheap, Porkbun, Name.com, Dynadot, Hover)
- new destination plugins (Porkbun, Namecheap)
- WHOIS-based auto-detection of current registrar
- web UI on top of the state machine
