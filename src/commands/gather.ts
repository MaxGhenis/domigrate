/**
 * `domigrate gather --source <id>`
 *
 * Enumerates all domains at a source registrar and upserts them into
 * the state DB with status "discovered". Safe to re-run; it never
 * regresses an already-advanced domain. Use this before `transfer --all`.
 */

import { State } from "../state.ts";
import { getSource } from "../sources/index.ts";
import { getDestination } from "../destinations/index.ts";
import { makePluginContext } from "../pluginCtx.ts";
import { statePath } from "../config.ts";

export async function gather(args: {
  source: string;
  destination: string;
}) {
  const source = getSource(args.source);
  getDestination(args.destination); // validate now, not later
  const state = new State(statePath());
  const ctx = makePluginContext();
  try {
    console.log(`Listing domains at ${source.name}...`);
    const domains = await source.list(ctx);
    console.log(`Found ${domains.length} domain(s).`);
    for (const d of domains) state.upsert(d, args.source, args.destination);
    return domains;
  } finally {
    await ctx.dispose();
    state.close();
  }
}
