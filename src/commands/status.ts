/**
 * `domigrate status`
 *
 * Pretty-prints the state DB. No I/O beyond reading the SQLite file.
 */

import { State } from "../state.ts";
import { statePath } from "../config.ts";
import type { DomainStatus } from "../types.ts";

const ORDER: DomainStatus[] = [
  "error",
  "discovered",
  "zone_created",
  "unlocked",
  "auth_code_retrieved",
  "transfer_submitted",
  "awaiting_approval",
  "completed",
];

export function status() {
  const state = new State(statePath());
  try {
    const rows = state.all();
    if (rows.length === 0) {
      console.log("No domains in state. Start with: domigrate gather --source <id>");
      return;
    }
    const byStatus = new Map<DomainStatus, number>();
    for (const r of rows) {
      byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);
    }
    console.log(`${rows.length} domain(s) tracked:\n`);
    for (const s of ORDER) {
      const n = byStatus.get(s) ?? 0;
      if (n > 0) console.log(`  ${s.padEnd(22)} ${n}`);
    }
    console.log();
    console.log(
      `${"domain".padEnd(32)} ${"status".padEnd(22)} ${"source".padEnd(12)} dest`,
    );
    console.log("-".repeat(80));
    for (const r of rows) {
      console.log(
        `${r.domain.padEnd(32)} ${r.status.padEnd(22)} ${r.source.padEnd(12)} ${r.destination}${r.error ? `  [${r.error}]` : ""}`,
      );
    }
  } finally {
    state.close();
  }
}
