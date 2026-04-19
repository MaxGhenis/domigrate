/**
 * Squarespace source plugin (browser-driven).
 *
 * Squarespace has no registrar API at all, so this plugin is entirely
 * browser-driven. The strategy mirrors GoDaddy: attach to the user's
 * signed-in Chrome, navigate to the account pages, and let the LLM find
 * the relevant controls in the HTML.
 *
 * Squarespace's domain console URL is
 * https://account.squarespace.com/domains, and per-domain settings live
 * under https://account.squarespace.com/domains/managed/{domain}/.
 */

import { z } from "zod";
import type { Page } from "playwright";
import type { PluginContext, SourceRegistrar } from "../types.ts";
import { openTab } from "../browser.ts";
import { extractFromHtml } from "../ai.ts";
import { isValidDomain } from "../domain.ts";

const LIST_URL = "https://account.squarespace.com/domains";

function settingsUrl(domain: string) {
  return `https://account.squarespace.com/domains/managed/${domain}`;
}

async function ensureSignedIn(page: Page) {
  if (/login|signin|auth/.test(new URL(page.url()).pathname)) {
    throw new Error(
      "Squarespace requires sign-in. Log in at https://account.squarespace.com in your Chrome (port 9222), then rerun.",
    );
  }
}

export const squarespace: SourceRegistrar = {
  id: "squarespace",
  name: "Squarespace",
  requiresBrowser: true,

  async list(ctx: PluginContext) {
    const handle = await ctx.getBrowser();
    const page = await openTab(handle, LIST_URL, { waitUntil: "networkidle" });
    try {
      await ensureSignedIn(page);
      const html = await page.content();
      const { domains } = await extractFromHtml(
        html,
        z.object({
          domains: z
            .array(z.string())
            .describe(
              "Every domain listed on this Squarespace domains page, lowercase, second-level only.",
            ),
        }),
        "Extract every domain the user owns from this Squarespace domains page.",
      );
      return domains.filter(isValidDomain);
    } finally {
      await page.close();
    }
  },

  async unlock(ctx: PluginContext, domain: string) {
    const handle = await ctx.getBrowser();
    const page = await openTab(handle, settingsUrl(domain), {
      waitUntil: "networkidle",
    });
    try {
      await ensureSignedIn(page);
      const html = await page.content();
      const { locked, toggleSelector } = await extractFromHtml(
        html,
        z.object({
          locked: z.boolean(),
          toggleSelector: z.string().nullable(),
        }),
        "Is the domain's transfer lock enabled on this Squarespace settings page? If so, give a CSS selector for the toggle.",
      );
      if (!locked) return;
      if (!toggleSelector) {
        throw new Error(
          `${domain}: could not locate transfer-lock toggle on Squarespace — unlock manually.`,
        );
      }
      await page.click(toggleSelector);
      await page.waitForTimeout(1500);
    } finally {
      await page.close();
    }
  },

  async getAuthCode(ctx: PluginContext, domain: string) {
    const handle = await ctx.getBrowser();
    const page = await openTab(handle, settingsUrl(domain), {
      waitUntil: "networkidle",
    });
    try {
      await ensureSignedIn(page);
      // Squarespace typically emails the auth code rather than showing
      // it inline; the button is labelled something like "Send
      // authorization code". If so, we press it and surface a clear
      // error so the user knows to check their email.
      for (let attempt = 0; attempt < 2; attempt++) {
        const html = await page.content();
        const { authCode, sendButtonSelector } = await extractFromHtml(
          html,
          z.object({
            authCode: z.string().nullable(),
            sendButtonSelector: z.string().nullable(),
          }),
          "Find the EPP auth code shown on this page, OR a selector for the button that emails/reveals it.",
        );
        if (authCode) return authCode.trim();
        if (!sendButtonSelector) break;
        await page.click(sendButtonSelector);
        await page.waitForTimeout(2500);
      }
      throw new Error(
        `${domain}: Squarespace typically emails the auth code. Check the email on file and paste it with \`domigrate code ${domain} <CODE>\`.`,
      );
    } finally {
      await page.close();
    }
  },
};
