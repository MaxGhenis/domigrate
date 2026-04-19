/**
 * LLM-assisted structured extraction from HTML.
 *
 * The second architectural bet: instead of hardcoding CSS selectors for
 * GoDaddy's and Squarespace's control panels (which break on every
 * redesign), we hand the page HTML to a small fast model with a zod
 * schema and let it pull out what we need. Any registrar's UI becomes
 * "supported" for free.
 *
 * We route through the Vercel AI Gateway so users can pick any model
 * (default: anthropic/claude-haiku-4-5) without installing per-provider
 * SDKs. The gateway key is read from env; no SDK setup required beyond
 * installing the `ai` and `@ai-sdk/gateway` packages.
 */

import { generateObject } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import type { z } from "zod";

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";
const MAX_HTML_CHARS = 120_000; // safety cap so we never blow a context budget

export interface ExtractOptions {
  /** Provider/model slug understood by the AI Gateway (default haiku). */
  model?: string;
  /** Override the default instruction preamble. */
  system?: string;
}

/**
 * Extract a typed object from a chunk of HTML. The LLM is told to
 * populate the schema fields as best it can from visible text + input
 * values + data-attributes; unknown fields should be left nullish.
 */
export async function extractFromHtml<T>(
  html: string,
  schema: z.ZodType<T>,
  prompt: string,
  opts: ExtractOptions = {},
): Promise<T> {
  if (!process.env.AI_GATEWAY_API_KEY && !process.env.VERCEL_OIDC_TOKEN) {
    throw new Error(
      "Set AI_GATEWAY_API_KEY (https://vercel.com/ai) to use AI-assisted extraction.",
    );
  }
  const gateway = createGateway({
    apiKey: process.env.AI_GATEWAY_API_KEY,
  });
  const trimmed = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const { object } = await generateObject({
    model: gateway(opts.model ?? DEFAULT_MODEL),
    schema,
    system:
      opts.system ??
      "You are a precise HTML scraper. Extract exactly what the user asks for from the given HTML. When asked for domain-transfer fields (EPP code, auth code, nameservers, lock state), look in visible text, input `value` attributes, and aria-labels. Never invent values; return null/empty when a field is truly absent.",
    prompt: `${prompt}\n\n--- HTML ---\n${trimmed}`,
  });
  return object;
}
