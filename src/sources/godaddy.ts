/**
 * GoDaddy source plugin (browser-driven).
 *
 * GoDaddy's API is paywalled behind a 10+ domain / Domain Pro threshold
 * since May 2024, so we rely entirely on the user's logged-in Chrome.
 *
 * Approach:
 *   - `list`:         scrape https://dcc.godaddy.com/control/portfolio
 *   - `unlock`:       navigate to the domain's settings page and toggle
 *                     the transfer lock (we let the LLM find the button)
 *   - `getAuthCode`:  navigate to domain settings, click "request auth
 *                     code" if needed, then read the code from the page
 *
 * We purposely never try to log in; if the user isn't already signed
 * into their GoDaddy account in Chrome, we surface a clear error.
 */

import { z } from "zod";
import type { PluginContext, SourceRegistrar } from "../types.ts";
import { openTab } from "../browser.ts";
import { extractFromHtml } from "../ai.ts";
import { isValidDomain } from "../domain.ts";
import type { CdpPage } from "../cdp.ts";

const PORTFOLIO_URL = "https://dcc.godaddy.com/control/portfolio";

async function ensureSignedIn(page: CdpPage) {
  const url = await page.url();
  if (new URL(url).hostname === "sso.godaddy.com") {
    throw new Error(
      "GoDaddy requires sign-in. Log in at https://sso.godaddy.com in your Chrome (port 9222), then rerun.",
    );
  }
}

export const godaddy: SourceRegistrar = {
  id: "godaddy",
  name: "GoDaddy",
  requiresBrowser: true,

  async list(ctx: PluginContext) {
    const handle = await ctx.getBrowser();
    const page = await openTab(handle, PORTFOLIO_URL);
    try {
      await ensureSignedIn(page);
      // GoDaddy's portfolio paginates; give the virtual list a beat to
      // render after initial load.
      await page.wait(2000);
      const html = await page.html();
      const { domains } = await extractFromHtml(
        html,
        z.object({
          domains: z
            .array(z.string())
            .describe(
              "Every second-level domain listed in this portfolio table, lowercase, no protocol, no path.",
            ),
        }),
        "Extract every domain the user owns from this GoDaddy portfolio page.",
      );
      return domains.filter(isValidDomain);
    } finally {
      await page.close();
    }
  },

  async unlock(ctx: PluginContext, domain: string) {
    const handle = await ctx.getBrowser();
    const page = await openTab(
      handle,
      `https://dcc.godaddy.com/control/${domain}/settings`,
    );
    try {
      await ensureSignedIn(page);
      await page.wait(1500);
      const html = await page.html();
      const { locked, toggleSelector } = await extractFromHtml(
        html,
        z.object({
          locked: z
            .boolean()
            .describe("true if the domain's transfer lock is currently ON."),
          toggleSelector: z
            .string()
            .nullable()
            .describe(
              "A CSS selector for the UI control that disables/toggles the transfer lock, if present.",
            ),
        }),
        "Determine whether the transfer lock is enabled for this domain, and the selector to toggle it.",
      );
      if (!locked) {
        ctx.log("info", `${domain}: already unlocked`);
        return;
      }
      if (!toggleSelector) {
        throw new Error(
          `${domain}: could not locate transfer-lock toggle in GoDaddy UI — unlock manually.`,
        );
      }
      await page.click(toggleSelector);
      await page.wait(2000);
    } finally {
      await page.close();
    }
  },

  async getAuthCode(ctx: PluginContext, domain: string) {
    const handle = await ctx.getBrowser();
    const page = await openTab(
      handle,
      `https://dcc.godaddy.com/control/${domain}/settings`,
    );
    try {
      await ensureSignedIn(page);
      await page.wait(1500);
      for (let attempt = 0; attempt < 2; attempt++) {
        const html = await page.html();
        const { authCode, requestButtonSelector } = await extractFromHtml(
          html,
          z.object({
            authCode: z
              .string()
              .nullable()
              .describe(
                "The EPP / domain authorization code, typically 8–32 chars, shown or copyable from the page. Null if not displayed.",
              ),
            requestButtonSelector: z
              .string()
              .nullable()
              .describe(
                "CSS selector of the button that generates/reveals the auth code, if the code itself is not yet shown.",
              ),
          }),
          "Find the transfer authorization (EPP) code for this domain, or the button to request it.",
        );
        if (authCode) return authCode.trim();
        if (!requestButtonSelector) break;
        await page.click(requestButtonSelector);
        await page.wait(2500);
      }
      throw new Error(
        `${domain}: auth code not available on GoDaddy settings page — may require email verification.`,
      );
    } finally {
      await page.close();
    }
  },
};
