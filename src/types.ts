/**
 * Core types for domigrate.
 *
 * A migration is the movement of a domain's registration from one
 * registrar (the source) to another (the destination). The tool models
 * both sides as plugins behind small interfaces so that:
 *
 *   - source plugins can be API-driven OR browser-driven (using the
 *     user's already-logged-in Chrome via CDP), and
 *   - destination plugins are typically API-driven (CF, Porkbun, etc.).
 *
 * The SQLite-backed state machine advances each domain through a set of
 * statuses; any command can be re-run safely and will pick up where a
 * prior run left off.
 */

export type DomainStatus =
  | "discovered" // found at source, nothing done yet
  | "zone_created" // zone added at destination (DNS side ready)
  | "unlocked" // transfer lock removed at source
  | "auth_code_retrieved" // EPP/auth code fetched from source
  | "transfer_submitted" // submitted to destination registrar
  | "awaiting_approval" // waiting on email/manual approval at source
  | "completed" // transfer finished, domain now at destination
  | "error";

export interface DomainRecord {
  domain: string;
  source: string; // plugin id, e.g. "godaddy"
  destination: string; // plugin id, e.g. "cloudflare"
  status: DomainStatus;
  auth_code: string | null;
  zone_id: string | null;
  nameservers: string | null; // JSON-encoded string[]
  error: string | null;
  updated_at: string; // ISO
  created_at: string;
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  ttl?: number;
  proxied?: boolean;
}

export interface RegistrantContact {
  first_name: string;
  last_name: string;
  organization?: string;
  email: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  country: string; // ISO 3166-1 alpha-2
}

export interface BrowserHandle {
  /** Playwright browser context bound to the user's real Chrome. */
  // Intentionally untyped here to avoid a hard import dependency in
  // consumers that just want a handle to pass around. browser.ts returns
  // a concrete Playwright BrowserContext.
  context: unknown;
  /** Close the CDP connection (does not close Chrome itself). */
  dispose(): Promise<void>;
}

export interface SourceRegistrar {
  id: string;
  name: string;
  /** Does this plugin require a browser (vs pure API)? */
  requiresBrowser: boolean;
  /** Enumerate all domains the user has at this registrar. */
  list(ctx: PluginContext): Promise<string[]>;
  /** Remove the transfer lock so auth codes can be issued / transfer proceeds. */
  unlock(ctx: PluginContext, domain: string): Promise<void>;
  /** Return the EPP / auth code for a single domain. */
  getAuthCode(ctx: PluginContext, domain: string): Promise<string>;
}

export interface DestinationRegistrar {
  id: string;
  name: string;
  /** Create the DNS zone on the destination (preserves current DNS). */
  addZone(ctx: PluginContext, domain: string): Promise<{ zoneId: string; nameservers: string[] }>;
  /** Import DNS records from the current authoritative server. */
  scanDns(ctx: PluginContext, zoneId: string): Promise<{ imported: number }>;
  /** Submit a transfer-in request with the auth code. */
  submitTransfer(
    ctx: PluginContext,
    args: {
      domain: string;
      zoneId: string;
      authCode: string;
      contact: RegistrantContact;
    },
  ): Promise<{ transferId?: string; message: string }>;
}

/**
 * PluginContext holds ambient dependencies available to every plugin
 * call. Plugins should never read process.env directly; everything they
 * need flows through here so that tests can inject mocks.
 */
export interface PluginContext {
  env: Record<string, string | undefined>;
  /** Lazily resolves (and caches) a browser handle if a plugin needs one. */
  getBrowser(): Promise<BrowserHandle>;
  /** Structured logging — replace in tests to capture output. */
  log: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}
