/**
 * Configuration and paths.
 *
 * State lives under $XDG_DATA_HOME (default ~/.local/share/domigrate),
 * user config under $XDG_CONFIG_HOME (default ~/.config/domigrate).
 * Env vars remain the primary way to pass secrets so that users can
 * plug in their own keychain/1Password/`op` layer without us needing
 * to ship credential-storage code.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RegistrantContact } from "./types.ts";

export function stateDir() {
  return process.env.DOMIGRATE_STATE_DIR ??
    join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "domigrate");
}

export function configDir() {
  return process.env.DOMIGRATE_CONFIG_DIR ??
    join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "domigrate");
}

export function statePath() {
  return join(stateDir(), "state.db");
}

export function contactPath() {
  return join(configDir(), "contact.json");
}

export function loadContact(): RegistrantContact | null {
  const p = contactPath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<RegistrantContact>;
    const required: (keyof RegistrantContact)[] = [
      "first_name",
      "last_name",
      "email",
      "phone",
      "address",
      "city",
      "state",
      "zip",
      "country",
    ];
    for (const k of required) {
      if (!raw[k]) return null;
    }
    return raw as RegistrantContact;
  } catch {
    return null;
  }
}
