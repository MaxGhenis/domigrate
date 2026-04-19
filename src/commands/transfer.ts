/**
 * `domigrate transfer <domain...> | --all`
 *
 * Drives the full pipeline for each domain, using the SQLite state
 * machine to make every step resumable:
 *
 *   discovered
 *     → zone_created        (destination.addZone + destination.scanDns)
 *     → unlocked            (source.unlock)
 *     → auth_code_retrieved (source.getAuthCode)
 *     → transfer_submitted  (destination.submitTransfer)
 *     → awaiting_approval   (user confirms via email at source)
 *     → completed           (set manually via `domigrate complete <domain>`)
 *
 * Idempotent: each step checks current status first and skips work
 * already done. If a step throws, the domain is marked `error` and the
 * error message is stored; subsequent runs retry from there.
 */

import { State } from "../state.ts";
import { getSource } from "../sources/index.ts";
import { getDestination } from "../destinations/index.ts";
import { makePluginContext } from "../pluginCtx.ts";
import { statePath, loadContact } from "../config.ts";
import type { DomainRecord } from "../types.ts";

export interface TransferOptions {
  all?: boolean;
  domains?: string[];
  /** Stop after zone creation (skip the transfer itself). */
  dnsOnly?: boolean;
  /** Default source if a domain isn't yet in the state DB. */
  source?: string;
  /** Default destination. */
  destination?: string;
}

const ADVANCE: Record<DomainRecord["status"], number> = {
  discovered: 0,
  zone_created: 1,
  unlocked: 2,
  auth_code_retrieved: 3,
  transfer_submitted: 4,
  awaiting_approval: 5,
  completed: 6,
  error: -1,
};

export async function transfer(opts: TransferOptions) {
  const state = new State(statePath());
  const ctx = makePluginContext();
  try {
    // Resolve target set of domains.
    const targets: DomainRecord[] = [];
    if (opts.all) {
      for (const r of state.all()) {
        if (r.status !== "completed") targets.push(r);
      }
    } else {
      for (const d of opts.domains ?? []) {
        const existing = state.get(d);
        if (existing) targets.push(existing);
        else if (opts.source && opts.destination)
          targets.push(state.upsert(d, opts.source, opts.destination));
        else
          throw new Error(
            `${d}: not in state DB; pass --source and --destination, or run \`gather\` first.`,
          );
      }
    }

    for (const rec of targets) {
      try {
        await advanceOne(rec, state, ctx, opts);
      } catch (e) {
        const msg = (e as Error).message;
        state.update(rec.domain, { status: "error", error: msg });
        ctx.log("error", `${rec.domain}: ${msg}`);
      }
    }
  } finally {
    await ctx.dispose();
    state.close();
  }
}

async function advanceOne(
  rec: DomainRecord,
  state: State,
  ctx: ReturnType<typeof makePluginContext>,
  opts: TransferOptions,
) {
  const source = getSource(rec.source);
  const dest = getDestination(rec.destination);
  const step = ADVANCE[rec.status] ?? 0;

  // 1. Create destination zone (does nothing if already created).
  if (step < ADVANCE.zone_created) {
    ctx.log("info", `${rec.domain}: creating zone at ${dest.name}...`);
    const { zoneId, nameservers } = await dest.addZone(ctx, rec.domain);
    const { imported } = await dest.scanDns(ctx, zoneId).catch((e) => {
      ctx.log("warn", `${rec.domain}: DNS scan failed: ${(e as Error).message}`);
      return { imported: 0 };
    });
    ctx.log("info", `${rec.domain}: zone ${zoneId}, imported ${imported} record(s)`);
    rec = state.update(rec.domain, {
      status: "zone_created",
      zone_id: zoneId,
      nameservers: JSON.stringify(nameservers),
      error: null,
    });
  }

  if (opts.dnsOnly) {
    ctx.log("info", `${rec.domain}: --dns-only; stopping after zone creation.`);
    return;
  }

  // 2. Unlock at source.
  if (ADVANCE[rec.status] < ADVANCE.unlocked) {
    ctx.log("info", `${rec.domain}: unlocking at ${source.name}...`);
    await source.unlock(ctx, rec.domain);
    rec = state.update(rec.domain, { status: "unlocked", error: null });
  }

  // 3. Auth code.
  if (ADVANCE[rec.status] < ADVANCE.auth_code_retrieved) {
    ctx.log("info", `${rec.domain}: retrieving auth code...`);
    const code = await source.getAuthCode(ctx, rec.domain);
    rec = state.update(rec.domain, {
      status: "auth_code_retrieved",
      auth_code: code,
      error: null,
    });
  }

  // 4. Submit transfer.
  if (ADVANCE[rec.status] < ADVANCE.transfer_submitted) {
    const contact = loadContact();
    if (!contact) {
      throw new Error(
        "No registrant contact on file. Create one at ~/.config/domigrate/contact.json (see README).",
      );
    }
    if (!rec.zone_id) throw new Error(`${rec.domain}: no zone_id in state.`);
    if (!rec.auth_code) throw new Error(`${rec.domain}: no auth code in state.`);
    ctx.log("info", `${rec.domain}: submitting transfer to ${dest.name}...`);
    const res = await dest.submitTransfer(ctx, {
      domain: rec.domain,
      zoneId: rec.zone_id,
      authCode: rec.auth_code,
      contact,
    });
    ctx.log("info", `${rec.domain}: ${res.message}`);
    rec = state.update(rec.domain, {
      status: "awaiting_approval",
      error: null,
    });
  }
}
