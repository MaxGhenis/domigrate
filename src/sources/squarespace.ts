/**
 * Squarespace source plugin (browser-driven).
 *
 * Squarespace has no registrar API at all, so this plugin is entirely
 * browser-driven. The strategy mirrors GoDaddy: attach to the user's
 * signed-in Chrome via CDP, navigate to the account pages, and let the
 * LLM find the relevant controls in the HTML.
 */

import { z } from "zod";
import type { PluginContext, SourceRegistrar } from "../types.ts";
import { openTab } from "../browser.ts";
import { extractFromHtml } from "../ai.ts";
import { isValidDomain } from "../domain.ts";
import type { CdpPage } from "../cdp.ts";

const LIST_URL = "https://account.squarespace.com/domains";

function settingsUrl(domain: string) {
  return `https://account.squarespace.com/domains/managed/${domain}`;
}

async function ensureSignedIn(page: CdpPage) {
  const url = await page.url();
  if (/login|signin|auth/.test(new URL(url).pathname)) {
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
    const page = await openTab(handle, LIST_URL);
    try {
      await ensureSignedIn(page);
      await page.wait(2000);
      const html = await page.html();
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
    const page = await openTab(handle, settingsUrl(domain));
    try {
      await ensureSignedIn(page);
      await page.wait(1500);
      const html = await page.html();
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
      await page.wait(2000);
    } finally {
      await page.close();
    }
  },

  async getAuthCode(ctx: PluginContext, domain: string) {
    const handle = await ctx.getBrowser();
    const page = await openTab(handle, settingsUrl(domain));
    /** If true, we leave the tab open on error so the user can finish
     *  the interactive step themselves (e.g., reauth, 2FA). */
    let keepTabOpen = false;
    try {
      await ensureSignedIn(page);
      await page.wait(2500);
      // Squarespace's Overview page has a "Request transfer code" button
      // (rendered as <button> with hashed CSS-in-JS class names that change
      // every build). Clicking it triggers an email with the EPP code;
      // Squarespace does not display the code inline.
      try {
        await page.clickByText("Request transfer code");
      } catch {
        // Button name may vary (e.g., "Get transfer code", "Send authorization code").
        // Fall back to LLM extraction of whichever button is present.
        const { selector } = await extractFromHtml(
          await page.html(),
          z.object({
            selector: z
              .string()
              .nullable()
              .describe(
                "CSS selector for the button that requests/sends/emails the EPP auth code for this domain. Null if no such button is present.",
              ),
          }),
          "Find the button that asks Squarespace to email or display the transfer auth code.",
        );
        if (!selector) {
          throw new Error(
            `${domain}: no transfer-code button found on Squarespace overview page.`,
          );
        }
        await page.click(selector);
      }
      await page.wait(4000); // let any confirmation dialog appear

      // Squarespace frequently interposes a reauth iframe
      // (login.squarespace.com/reauthenticate) inside the transfer
      // modal. We cannot automate password entry — once the user
      // completes it manually in their Chrome tab, subsequent requests
      // within the same session skip the reauth and we can click the
      // modal's confirm button ("Move Domain" / similar).
      const postClickHtml = await page.html();
      if (/login\.squarespace\.com\/reauthenticate/i.test(postClickHtml)) {
        keepTabOpen = true;
        throw new Error(
          `Squarespace is requiring password re-authentication before dispatching the auth code. Complete the reauth in the Chrome tab that just opened for ${domain} (enter your password, then click "Move Domain"). Subsequent domains in the same session should not require this step. Then rerun \`domigrate transfer ${domain}\`.`,
        );
      }

      // "Request transfer code" opens a modal; the actual trigger button
      // is labelled "Move Domain" (or equivalent) inside that modal.
      // We probe likely labels in order; first match wins.
      let modalClicked = false;
      for (const label of [
        "Move Domain",
        "Move domain",
        "Send transfer code",
        "Send code",
        "Confirm",
        "Continue",
        "Yes",
      ]) {
        try {
          await page.clickByText(label);
          modalClicked = true;
          await page.wait(2000);
          break;
        } catch {
          // label not present, try next
        }
      }
      if (!modalClicked) {
        keepTabOpen = true;
        throw new Error(
          `Clicked "Request transfer code" but could not find the modal confirmation button. Complete the transfer in the Chrome tab that just opened.`,
        );
      }

      // Squarespace then emails the code. Surface that clearly so the
      // user knows the next step is to check email + `domigrate code`.
      throw new Error(
        `Squarespace emailed the auth code. When received, run:  domigrate code ${domain} <CODE>`,
      );
    } finally {
      if (!keepTabOpen) await page.close();
    }
  },
};
