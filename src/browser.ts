/**
 * Thin wrapper around the CDP client (src/cdp.ts) that exposes a stable
 * shape to source plugins. We keep this indirection so that swapping
 * transports (e.g., testing with a mock) never reaches across into the
 * plugin code.
 */

import { openTab as cdpOpenTab, pingCdp, type CdpPage } from "./cdp.ts";
import type { BrowserHandle } from "./types.ts";

export interface BrowserOptions {
  /** CDP HTTP endpoint. Default: http://127.0.0.1:9222 */
  cdpUrl?: string;
}

export async function connectBrowser(
  opts: BrowserOptions = {},
): Promise<BrowserHandle & { cdpUrl: string }> {
  const cdpUrl = opts.cdpUrl ?? "http://127.0.0.1:9222";
  await pingCdp(cdpUrl);
  return {
    context: { cdpUrl },
    cdpUrl,
    async dispose() {
      // Nothing to dispose for the raw-CDP transport; tab cleanup
      // happens per-tab in the source plugins.
    },
  };
}

export async function openTab(
  handle: BrowserHandle & { cdpUrl?: string },
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<CdpPage> {
  const cdpUrl = (handle.context as { cdpUrl?: string })?.cdpUrl
    ?? handle.cdpUrl
    ?? "http://127.0.0.1:9222";
  return cdpOpenTab(url, { cdpUrl, timeoutMs: opts.timeoutMs });
}
