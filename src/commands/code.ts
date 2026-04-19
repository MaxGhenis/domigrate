/**
 * `domigrate code <domain> <auth-code>`
 *
 * Manually record an auth code for a domain whose source registrar
 * delivers codes out of band (e.g., Squarespace emails them). Advances
 * the state to `auth_code_retrieved`.
 */

import { State } from "../state.ts";
import { statePath } from "../config.ts";

export function code(domain: string, authCode: string) {
  const state = new State(statePath());
  try {
    const row = state.get(domain);
    if (!row) {
      throw new Error(
        `${domain} is not in state. Run \`domigrate gather\` first.`,
      );
    }
    state.update(domain, {
      status: "auth_code_retrieved",
      auth_code: authCode.trim(),
      error: null,
    });
    console.log(`${domain}: auth code recorded.`);
  } finally {
    state.close();
  }
}
