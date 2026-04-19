/**
 * Cloudflare destination plugin.
 *
 * Uses three families of endpoints:
 *   1. documented zone/DNS API — creating zones, scanning DNS records
 *   2. documented registrar read API — domain status, contact info
 *   3. undocumented registrar transfer API — POST /accounts/{id}/registrar/domains/{name}/check_auth
 *                                           POST /zones/{zone}/registrar/domains/{name}/transfer
 *
 * The undocumented endpoints are the ones a real transfer submission
 * exercises in the Cloudflare dashboard; they require the Global API
 * Key + email pair (scoped tokens do not have "Registrar Domains:Edit"
 * as of writing). We authenticate via whichever credentials are set.
 *
 * Upstream docs (that do exist):
 *   - https://developers.cloudflare.com/api/operations/zones-get
 *   - https://developers.cloudflare.com/api/operations/dns-records-for-a-zone-create-dns-record
 *   - https://developers.cloudflare.com/registrar/
 */

import type {
  DestinationRegistrar,
  PluginContext,
  RegistrantContact,
} from "../types.ts";

const BASE_URL = "https://api.cloudflare.com/client/v4";

export interface CloudflareCreds {
  /** Scoped API token. Sufficient for zone/DNS ops. */
  apiToken?: string;
  /** Global API key (legacy). Required for undocumented transfer endpoints. */
  globalKey?: string;
  /** Email; required with globalKey. */
  email?: string;
  /** Account ID; auto-detected from zones if omitted. */
  accountId?: string;
}

export function readCfCreds(env: Record<string, string | undefined>): CloudflareCreds {
  return {
    apiToken: env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_ZONE_TOKEN,
    globalKey: env.CLOUDFLARE_GLOBAL_API_KEY,
    email: env.CLOUDFLARE_EMAIL,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
  };
}

function authHeaders(
  creds: CloudflareCreds,
  forRegistrar: boolean,
): Record<string, string> {
  if (forRegistrar && creds.globalKey && creds.email) {
    return {
      "X-Auth-Key": creds.globalKey,
      "X-Auth-Email": creds.email,
      "Content-Type": "application/json",
    };
  }
  if (creds.apiToken) {
    return {
      Authorization: `Bearer ${creds.apiToken}`,
      "Content-Type": "application/json",
    };
  }
  if (creds.globalKey && creds.email) {
    return {
      "X-Auth-Key": creds.globalKey,
      "X-Auth-Email": creds.email,
      "Content-Type": "application/json",
    };
  }
  throw new Error(
    "No Cloudflare credentials: set CLOUDFLARE_API_TOKEN or CLOUDFLARE_GLOBAL_API_KEY+CLOUDFLARE_EMAIL",
  );
}

type CfEnvelope<T> = {
  success: boolean;
  result: T;
  errors?: Array<{ code: number; message: string }>;
};

/**
 * Low-level request helper.
 *
 * Exposed for direct calls in tests and for registrar endpoints that
 * require a specific auth scheme. The `forRegistrar` flag selects the
 * Global-Key auth form when we have it (registrar endpoints do not
 * accept scoped tokens today).
 *
 * The optional `fetcher` argument lets tests inject a stub — in
 * production we default to globalThis.fetch.
 */
export async function cfRequest<T>(
  creds: CloudflareCreds,
  path: string,
  init: RequestInit & { forRegistrar?: boolean } = {},
  fetcher: typeof fetch = fetch,
): Promise<T> {
  const { forRegistrar, ...rest } = init;
  const res = await fetcher(`${BASE_URL}${path}`, {
    ...rest,
    headers: {
      ...authHeaders(creds, forRegistrar === true),
      ...(rest.headers || {}),
    },
  });
  const body = (await res.json()) as CfEnvelope<T>;
  if (!body.success) {
    const msg =
      body.errors?.map((e) => `[${e.code}] ${e.message}`).join("; ") ||
      `HTTP ${res.status}`;
    throw new CloudflareError(msg, res.status);
  }
  return body.result;
}

export class CloudflareError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = "CloudflareError";
  }
}

/**
 * Find the account ID associated with the credentials. Preference order:
 *   1. explicit CLOUDFLARE_ACCOUNT_ID
 *   2. /accounts endpoint (works with tokens that have Account:Read)
 *   3. first zone's account (works with any zone-scoped token)
 */
export async function resolveAccountId(
  creds: CloudflareCreds,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (creds.accountId) return creds.accountId;
  try {
    const accts = await cfRequest<Array<{ id: string }>>(
      creds,
      "/accounts?per_page=1",
      {},
      fetcher,
    );
    if (accts[0]?.id) return accts[0].id;
  } catch {
    /* fall through */
  }
  const zones = await cfRequest<Array<{ account: { id: string } }>>(
    creds,
    "/zones?per_page=1",
    {},
    fetcher,
  );
  const id = zones[0]?.account?.id;
  if (!id)
    throw new Error(
      "Could not resolve Cloudflare account ID; set CLOUDFLARE_ACCOUNT_ID",
    );
  return id;
}

export const cloudflare: DestinationRegistrar = {
  id: "cloudflare",
  name: "Cloudflare",

  async addZone(ctx: PluginContext, domain: string) {
    const creds = readCfCreds(ctx.env);
    const accountId = await resolveAccountId(creds);

    try {
      const zone = await cfRequest<{ id: string; name_servers: string[] }>(
        creds,
        `/zones`,
        {
          method: "POST",
          body: JSON.stringify({
            name: domain,
            account: { id: accountId },
            type: "full",
          }),
        },
      );
      return { zoneId: zone.id, nameservers: zone.name_servers ?? [] };
    } catch (e) {
      const err = e as CloudflareError;
      // If the zone already exists, fetch its details instead of failing.
      if (/already exists/i.test(err.message)) {
        const existing = await cfRequest<
          Array<{ id: string; name_servers: string[] }>
        >(creds, `/zones?name=${encodeURIComponent(domain)}`);
        if (existing[0]) {
          return {
            zoneId: existing[0].id,
            nameservers: existing[0].name_servers ?? [],
          };
        }
      }
      throw e;
    }
  },

  async scanDns(ctx: PluginContext, zoneId: string) {
    const creds = readCfCreds(ctx.env);
    // "Scan for DNS records" returns { recs_added } — it walks the current
    // authoritative server for common record types. Safe to call at most
    // once per zone; subsequent calls typically no-op.
    const res = await cfRequest<{ recs_added?: number }>(
      creds,
      `/zones/${zoneId}/dns_records/scan`,
      { method: "POST" },
    );
    return { imported: res.recs_added ?? 0 };
  },

  async submitTransfer(
    ctx: PluginContext,
    { domain, zoneId, authCode, contact },
  ) {
    const creds = readCfCreds(ctx.env);
    if (!creds.globalKey || !creds.email) {
      throw new Error(
        "Transfer requires CLOUDFLARE_GLOBAL_API_KEY + CLOUDFLARE_EMAIL " +
          "(scoped tokens cannot submit registrar transfers).",
      );
    }
    const accountId = await resolveAccountId(creds);
    const encoded = Buffer.from(authCode).toString("base64");

    // 1. validate the auth code before committing.
    await cfRequest<{ message: string }>(
      creds,
      `/accounts/${accountId}/registrar/domains/${domain}/check_auth`,
      {
        method: "POST",
        body: JSON.stringify({ auth_code: encoded }),
        forRegistrar: true,
      },
    );

    // 2. submit the transfer. Payload shape discovered from
    //    alexinslc/nodaddy (observed via the dashboard's network tab).
    const res = await cfRequest<{ name?: string; message?: string }>(
      creds,
      `/zones/${zoneId}/registrar/domains/${domain}/transfer`,
      {
        method: "POST",
        body: JSON.stringify({
          auth_code: encoded,
          auto_renew: true,
          years: 1,
          privacy: true,
          import_dns: true,
          registrant: mapContactForCf(contact),
          fee_acknowledgement: { transfer_fee: 0, icann_fee: 0 },
        }),
        forRegistrar: true,
      },
    );
    return { message: res.message || "transfer submitted" };
  },
};

/** Translate the neutral RegistrantContact into Cloudflare's payload shape. */
export function mapContactForCf(c: RegistrantContact) {
  return {
    first_name: c.first_name,
    last_name: c.last_name,
    organization: c.organization ?? "",
    email: c.email,
    phone: c.phone,
    address: c.address,
    city: c.city,
    state: c.state,
    zip: c.zip,
    country: c.country,
  };
}
