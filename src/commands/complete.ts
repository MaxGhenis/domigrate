/**
 * `domigrate complete <domain>`
 *
 * Mark a domain as fully transferred. Useful after the user confirms
 * the transfer via the email from the losing registrar. Destinations
 * may later grow a proper poll for status; until they do, this is
 * manual.
 */

import { State } from "../state.ts";
import { statePath } from "../config.ts";

export function complete(domain: string) {
  const state = new State(statePath());
  try {
    const row = state.get(domain);
    if (!row) throw new Error(`${domain} is not in state.`);
    state.update(domain, { status: "completed", error: null });
    console.log(`${domain}: marked completed.`);
  } finally {
    state.close();
  }
}
