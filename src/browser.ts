/**
 * Browser automation against the user's already-running Chrome.
 *
 * This is the architectural bet that makes the tool actually work: we
 * never log into GoDaddy or Squarespace. We attach to Chrome over the
 * DevTools Protocol (port 9222 by default) and drive the tabs the user
 * is already signed into. No cookie harvesting, no 2FA replay, no stored
 * credentials — just a thin orchestration layer on top of what the
 * user's browser already has open.
 *
 * To use: launch Chrome with --remote-debugging-port=9222. On macOS, one
 * common pattern is a wrapper app at `~/Applications/Chrome (debug).app`.
 */

import { chromium, type BrowserContext } from "playwright";
import type { BrowserHandle } from "./types.ts";

export interface BrowserOptions {
  /** CDP endpoint. Default: http://127.0.0.1:9222 */
  cdpUrl?: string;
  /** Tab/context to use. "existing" reuses the first existing context
   *  (preserves cookies/session); "new" isolates into a fresh context. */
  isolation?: "existing" | "new";
}

const DEFAULT_CDP = "http://127.0.0.1:9222";

export async function connectBrowser(
  opts: BrowserOptions = {},
): Promise<BrowserHandle> {
  const url = opts.cdpUrl ?? DEFAULT_CDP;
  const isolation = opts.isolation ?? "existing";

  const browser = await chromium.connectOverCDP(url);
  let context: BrowserContext;
  if (isolation === "existing" && browser.contexts().length > 0) {
    context = browser.contexts()[0]!;
  } else {
    context = await browser.newContext();
  }

  return {
    context,
    async dispose() {
      // Detach without closing Chrome itself.
      await browser.close().catch(() => undefined);
    },
  };
}

/**
 * Navigate in a new tab and return the Playwright Page. Caller is
 * responsible for closing the tab when done (or leaving it open for
 * debugging). We always use a new tab so we don't disrupt the user's
 * active browsing.
 */
export async function openTab(
  handle: BrowserHandle,
  url: string,
  {
    waitUntil = "domcontentloaded",
    timeoutMs = 45_000,
  }: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; timeoutMs?: number } = {},
) {
  const ctx = handle.context as BrowserContext;
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil, timeout: timeoutMs });
  return page;
}
