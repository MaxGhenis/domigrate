import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { State } from "../src/state";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let state: State;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "domigrate-test-"));
  state = new State(join(dir, "state.db"));
});

afterEach(() => {
  state.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("State", () => {
  test("upsert creates a new row at 'discovered'", () => {
    const row = state.upsert("example.com", "godaddy", "cloudflare");
    expect(row.domain).toBe("example.com");
    expect(row.source).toBe("godaddy");
    expect(row.destination).toBe("cloudflare");
    expect(row.status).toBe("discovered");
    expect(row.auth_code).toBeNull();
    expect(row.created_at).toBeDefined();
  });

  test("upsert preserves existing domain status on re-insert", () => {
    state.upsert("example.com", "godaddy", "cloudflare");
    state.update("example.com", { status: "zone_created", zone_id: "abc123" });
    const re = state.upsert("example.com", "godaddy", "cloudflare");
    expect(re.status).toBe("zone_created");
    expect(re.zone_id).toBe("abc123");
  });

  test("update advances state, clears error on success", () => {
    state.upsert("example.com", "godaddy", "cloudflare");
    state.update("example.com", { status: "error", error: "failed" });
    const cleared = state.update("example.com", {
      status: "zone_created",
      error: null,
    });
    expect(cleared.status).toBe("zone_created");
    expect(cleared.error).toBeNull();
  });

  test("byStatus filters correctly", () => {
    state.upsert("a.com", "godaddy", "cloudflare");
    state.upsert("b.com", "godaddy", "cloudflare");
    state.update("a.com", { status: "completed" });
    expect(state.byStatus("completed").map((r) => r.domain)).toEqual(["a.com"]);
    expect(state.byStatus("discovered").map((r) => r.domain)).toEqual([
      "b.com",
    ]);
  });

  test("all() returns sorted by domain", () => {
    state.upsert("zeta.com", "godaddy", "cloudflare");
    state.upsert("alpha.com", "godaddy", "cloudflare");
    expect(state.all().map((r) => r.domain)).toEqual([
      "alpha.com",
      "zeta.com",
    ]);
  });

  test("re-opening the DB preserves state (persistence)", () => {
    state.upsert("example.com", "godaddy", "cloudflare");
    state.update("example.com", {
      status: "auth_code_retrieved",
      auth_code: "ABCD-1234",
    });
    state.close();
    const reopened = new State(join(dir, "state.db"));
    const row = reopened.get("example.com");
    expect(row?.status).toBe("auth_code_retrieved");
    expect(row?.auth_code).toBe("ABCD-1234");
    reopened.close();
  });
});
