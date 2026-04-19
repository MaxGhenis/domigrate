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

import { generateObject, type LanguageModel } from "ai";
import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import type { z } from "zod";

// Safety cap so we never blow a context budget. Modern models (Haiku 4.5,
// gpt-5-mini) comfortably take ~500KB of HTML (~100K tokens); the cap is
// really about keeping response times and cost predictable.
const MAX_HTML_CHARS = 400_000;

const DEFAULT_SYSTEM =
  "You are a precise HTML scraper. Extract exactly what the user asks for from the given HTML. When asked for domain-transfer fields (EPP code, auth code, nameservers, lock state), look in visible text, input `value` attributes, and aria-labels. Never invent values; return null/empty when a field is truly absent.";

export interface ExtractOptions {
  /** Model slug. Interpretation depends on the selected provider. */
  model?: string;
  /** Override the default instruction preamble. */
  system?: string;
}

/**
 * Select an LLM provider+model. Preference order:
 *   1. Vercel AI Gateway (AI_GATEWAY_API_KEY) — the recommended path;
 *      lets users pick any model by "provider/model" slug.
 *   2. OpenAI direct (OPENAI_API_KEY) — convenient fallback for users
 *      who already have an OpenAI key.
 */
function chooseModel(modelOverride?: string): LanguageModel {
  if (process.env.AI_GATEWAY_API_KEY) {
    const gateway = createGateway({ apiKey: process.env.AI_GATEWAY_API_KEY });
    return gateway(modelOverride ?? "anthropic/claude-haiku-4-5");
  }
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai(modelOverride ?? "gpt-5-mini");
  }
  throw new Error(
    "No LLM credentials. Set AI_GATEWAY_API_KEY (https://vercel.com/ai-gateway) or OPENAI_API_KEY.",
  );
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
  const trimmed = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  const { object } = await generateObject({
    model: chooseModel(opts.model),
    schema,
    system: opts.system ?? DEFAULT_SYSTEM,
    prompt: `${prompt}\n\n--- HTML ---\n${trimmed}`,
  });
  return object;
}
