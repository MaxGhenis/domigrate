#!/usr/bin/env bun
/**
 * CLI entry point.
 *
 * Intentionally dependency-free argv parsing: no commander, no yargs.
 * The command set is small and explicit, and every command maps to a
 * single function in ./commands/.
 */

import { gather } from "./commands/gather.ts";
import { transfer } from "./commands/transfer.ts";
import { status } from "./commands/status.ts";
import { code } from "./commands/code.ts";
import { complete } from "./commands/complete.ts";

const HELP = `domigrate — end-to-end domain registrar migrations

Usage:
  domigrate gather   --source <id> [--destination <id>]
      Enumerate all domains at the source and record them.

  domigrate transfer [<domain>...] [--source <id>] [--destination <id>]
                     [--all] [--dns-only] [--no-submit]
      Run the migration pipeline. Resumable; re-run on failure.
      --dns-only     stop after zone creation.
      --no-submit    run unlock + auth-code but skip the (paid) submit.

  domigrate code <domain> <auth-code>
      Manually record an auth/EPP code (e.g., from Squarespace email).

  domigrate complete <domain>
      Mark a domain as fully transferred.

  domigrate status
      Show the state table.

Available sources:       godaddy, squarespace
Available destinations:  cloudflare

Environment variables:
  CLOUDFLARE_API_TOKEN        - zone/DNS operations (scoped token OK)
  CLOUDFLARE_GLOBAL_API_KEY   - required for submitting transfers
  CLOUDFLARE_EMAIL            - required with GLOBAL_API_KEY
  CLOUDFLARE_ACCOUNT_ID       - optional, auto-detected
  AI_GATEWAY_API_KEY          - for browser-driven source plugins
                                (sign up: https://vercel.com/ai-gateway)
  DOMIGRATE_STATE_DIR         - override state DB location

Registrant contact (required for transfers):
  ~/.config/domigrate/contact.json
  {
    "first_name": "...", "last_name": "...", "email": "...",
    "phone": "+1.5555551212", "address": "...", "city": "...",
    "state": "...", "zip": "...", "country": "US"
  }

Chrome must be running with --remote-debugging-port=9222 and signed
into the source registrar(s).
`;

function flag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      // flags with values consume the next token unless it's another flag
      if (a === "--all" || a === "--dns-only" || a === "--no-submit") continue;
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(HELP);
    return;
  }

  switch (cmd) {
    case "gather": {
      const source = flag(rest, "source");
      const destination = flag(rest, "destination") ?? "cloudflare";
      if (!source) throw new Error("gather requires --source <id>");
      await gather({ source, destination });
      break;
    }
    case "transfer": {
      const source = flag(rest, "source");
      const destination = flag(rest, "destination") ?? "cloudflare";
      const all = hasFlag(rest, "all");
      const dnsOnly = hasFlag(rest, "dns-only");
      const noSubmit = hasFlag(rest, "no-submit");
      const domains = positional(rest);
      await transfer({ source, destination, all, dnsOnly, noSubmit, domains });
      break;
    }
    case "status":
      status();
      break;
    case "code": {
      const [domain, authCode] = positional(rest);
      if (!domain || !authCode)
        throw new Error("code requires <domain> <auth-code>");
      code(domain, authCode);
      break;
    }
    case "complete": {
      const [domain] = positional(rest);
      if (!domain) throw new Error("complete requires <domain>");
      complete(domain);
      break;
    }
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error(HELP);
      process.exit(1);
  }
}

main().catch((e) => {
  console.error(`ERROR: ${(e as Error).message}`);
  process.exit(1);
});
