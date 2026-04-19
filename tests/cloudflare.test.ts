import { test, expect, describe, mock } from "bun:test";
import {
  cfRequest,
  cloudflare,
  mapContactForCf,
  readCfCreds,
  resolveAccountId,
} from "../src/destinations/cloudflare";
import type { PluginContext } from "../src/types";

function mockFetch(
  handler: (url: string, init: RequestInit) => {
    status?: number;
    body: unknown;
  },
): typeof fetch {
  return (async (url: string, init: RequestInit = {}) => {
    const { status = 200, body } = handler(url, init);
    return {
      status,
      json: async () => body,
    } as Response;
  }) as unknown as typeof fetch;
}

function ctx(env: Record<string, string | undefined> = {}): PluginContext {
  return {
    env,
    getBrowser: () => {
      throw new Error("browser not used in this test");
    },
    log: () => {},
  };
}

describe("readCfCreds", () => {
  test("prefers scoped token over global key", () => {
    const c = readCfCreds({
      CLOUDFLARE_API_TOKEN: "tok",
      CLOUDFLARE_GLOBAL_API_KEY: "gk",
      CLOUDFLARE_EMAIL: "e@x",
    });
    expect(c.apiToken).toBe("tok");
    expect(c.globalKey).toBe("gk");
  });

  test("falls back to zone-scoped token env var", () => {
    const c = readCfCreds({ CLOUDFLARE_ZONE_TOKEN: "zt" });
    expect(c.apiToken).toBe("zt");
  });
});

describe("cfRequest", () => {
  test("throws CloudflareError on failure with formatted error", async () => {
    const fetcher = mockFetch(() => ({
      status: 400,
      body: {
        success: false,
        errors: [{ code: 1002, message: "invalid zone" }],
      },
    }));
    await expect(
      cfRequest({ apiToken: "tok" }, "/zones", {}, fetcher),
    ).rejects.toThrow(/invalid zone/);
  });

  test("uses Bearer auth with scoped token", async () => {
    let headers: Record<string, string> = {};
    const fetcher = mockFetch((_url, init) => {
      headers = init.headers as Record<string, string>;
      return { body: { success: true, result: {} } };
    });
    await cfRequest({ apiToken: "tok" }, "/zones", {}, fetcher);
    expect(headers.Authorization).toBe("Bearer tok");
  });

  test("uses X-Auth headers for registrar endpoints when global key available", async () => {
    let headers: Record<string, string> = {};
    const fetcher = mockFetch((_url, init) => {
      headers = init.headers as Record<string, string>;
      return { body: { success: true, result: {} } };
    });
    await cfRequest(
      { apiToken: "tok", globalKey: "gk", email: "e@x" },
      "/accounts/abc/registrar/domains/e.com/check_auth",
      { method: "POST", body: "{}", forRegistrar: true },
      fetcher,
    );
    expect(headers["X-Auth-Key"]).toBe("gk");
    expect(headers["X-Auth-Email"]).toBe("e@x");
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("resolveAccountId", () => {
  test("returns explicit accountId unchanged", async () => {
    const id = await resolveAccountId({ accountId: "abc" }, mockFetch(() => ({
      body: { success: true, result: [] },
    })));
    expect(id).toBe("abc");
  });

  test("falls back to zones[0].account.id when /accounts is empty", async () => {
    let calls = 0;
    const fetcher = mockFetch((url) => {
      calls++;
      if (url.includes("/accounts")) {
        return { body: { success: true, result: [] } };
      }
      if (url.includes("/zones")) {
        return {
          body: {
            success: true,
            result: [{ id: "z1", account: { id: "acct-from-zone" } }],
          },
        };
      }
      throw new Error(`unexpected: ${url}`);
    });
    const id = await resolveAccountId({ apiToken: "tok" }, fetcher);
    expect(id).toBe("acct-from-zone");
    expect(calls).toBe(2);
  });
});

describe("mapContactForCf", () => {
  test("defaults organization to empty string", () => {
    const out = mapContactForCf({
      first_name: "A",
      last_name: "B",
      email: "a@b.com",
      phone: "+1.5555551212",
      address: "1 Main",
      city: "DC",
      state: "DC",
      zip: "20001",
      country: "US",
    });
    expect(out.organization).toBe("");
    expect(out.country).toBe("US");
  });
});

describe("cloudflare.addZone", () => {
  test("idempotent: recovers an existing zone rather than failing", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = mockFetch((url, init) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/accounts?per_page=1") && method === "GET") {
        // accounts probe returns empty → falls through to zones probe
        return { body: { success: true, result: [] } };
      }
      if (url.includes("/zones?per_page=1") && method === "GET") {
        // account-id resolution fallback
        return {
          body: {
            success: true,
            result: [{ id: "z0", account: { id: "acct1" } }],
          },
        };
      }
      if (url.endsWith("/zones") && method === "POST") {
        return {
          body: {
            success: false,
            errors: [{ code: 1061, message: "zone already exists" }],
          },
        };
      }
      if (url.includes("/zones?name=")) {
        return {
          body: {
            success: true,
            result: [
              { id: "z1", name_servers: ["ns1.cf.com", "ns2.cf.com"] },
            ],
          },
        };
      }
      throw new Error(`unexpected: ${method} ${url}`);
    });
    try {
      const result = await cloudflare.addZone(
        ctx({ CLOUDFLARE_API_TOKEN: "tok" }),
        "example.com",
      );
      expect(result.zoneId).toBe("z1");
      expect(result.nameservers).toEqual(["ns1.cf.com", "ns2.cf.com"]);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
