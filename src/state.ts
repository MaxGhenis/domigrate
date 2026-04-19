/**
 * SQLite-backed state machine.
 *
 * Each domain has exactly one row tracking its progress through a
 * transfer. Commands are idempotent against this table: re-running
 * `domigrate transfer` after a crash picks up at the last completed
 * status. We use bun:sqlite (no native deps, no build step).
 */

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DomainRecord, DomainStatus } from "./types.ts";

const SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS domains (
  domain        TEXT PRIMARY KEY,
  source        TEXT NOT NULL,
  destination   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'discovered',
  auth_code     TEXT,
  zone_id       TEXT,
  nameservers   TEXT,
  error         TEXT,
  updated_at    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS domains_status_idx ON domains(status);
CREATE INDEX IF NOT EXISTS domains_source_idx ON domains(source);
`;

export class State {
  private db: Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(DDL);
    this.migrateIfNeeded();
  }

  private migrateIfNeeded() {
    const row = this.db
      .query<{ version: number }, []>("SELECT version FROM schema_version LIMIT 1")
      .get();
    if (!row) {
      this.db
        .query("INSERT INTO schema_version (version) VALUES (?)")
        .run(SCHEMA_VERSION);
    } else if (row.version < SCHEMA_VERSION) {
      // Future migrations land here, keyed on `row.version`.
      this.db
        .query("UPDATE schema_version SET version = ?")
        .run(SCHEMA_VERSION);
    }
  }

  close() {
    this.db.close();
  }

  upsert(domain: string, source: string, destination: string): DomainRecord {
    const now = new Date().toISOString();
    this.db
      .query(
        `INSERT INTO domains (domain, source, destination, status, updated_at, created_at)
         VALUES (?, ?, ?, 'discovered', ?, ?)
         ON CONFLICT(domain) DO UPDATE SET
           source      = excluded.source,
           destination = excluded.destination,
           updated_at  = excluded.updated_at`,
      )
      .run(domain, source, destination, now, now);
    return this.get(domain)!;
  }

  get(domain: string): DomainRecord | null {
    return (
      this.db
        .query<DomainRecord, [string]>("SELECT * FROM domains WHERE domain = ?")
        .get(domain) ?? null
    );
  }

  all(): DomainRecord[] {
    return this.db
      .query<DomainRecord, []>("SELECT * FROM domains ORDER BY domain")
      .all();
  }

  byStatus(status: DomainStatus): DomainRecord[] {
    return this.db
      .query<DomainRecord, [string]>(
        "SELECT * FROM domains WHERE status = ? ORDER BY domain",
      )
      .all(status);
  }

  /**
   * Advance or overwrite a field on a domain row.
   * Nulls are allowed (use `null` to clear a prior value).
   */
  update(
    domain: string,
    fields: Partial<
      Pick<
        DomainRecord,
        "status" | "auth_code" | "zone_id" | "nameservers" | "error"
      >
    >,
  ): DomainRecord {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (keys.length === 0) return this.get(domain)!;
    const assignments = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => fields[k] ?? null);
    values.push(new Date().toISOString());
    this.db
      .query(
        `UPDATE domains SET ${assignments}, updated_at = ? WHERE domain = ?`,
      )
      .run(...values, domain);
    return this.get(domain)!;
  }
}
