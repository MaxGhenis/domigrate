/**
 * Build a PluginContext that lazily creates a browser on first use, so
 * commands that don't need one never pay the CDP connect cost.
 */

import type { BrowserHandle, PluginContext } from "./types.ts";
import { connectBrowser } from "./browser.ts";

export function makePluginContext(): PluginContext & { dispose(): Promise<void> } {
  let browser: BrowserHandle | null = null;
  return {
    env: process.env as Record<string, string | undefined>,
    async getBrowser() {
      if (browser) return browser;
      browser = await connectBrowser();
      return browser;
    },
    log(level, msg, extra) {
      const prefix = level === "error" ? "ERROR:" : level === "warn" ? "WARN:" : "";
      const line = [prefix, msg].filter(Boolean).join(" ");
      if (extra !== undefined) console.log(line, extra);
      else console.log(line);
    },
    async dispose() {
      if (browser) await browser.dispose();
    },
  };
}
