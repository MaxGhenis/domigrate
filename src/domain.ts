/**
 * Domain validation and parsing helpers.
 *
 * Kept pure (no I/O, no side effects) so the core invariants are easy
 * to test. RFC 1035 / RFC 5891 compliant for the subset that actually
 * shows up as a registrable domain: 2+ labels, each 1–63 chars, total
 * ≤253 chars, ASCII letters/digits/hyphens (IDN domains are accepted in
 * their Punycode "xn--" form).
 */

const MAX_DOMAIN_LENGTH = 253;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export function isValidDomain(input: unknown): input is string {
  if (typeof input !== "string") return false;
  const s = input.trim().toLowerCase();
  if (!s || s.length > MAX_DOMAIN_LENGTH) return false;
  if (s.startsWith(".") || s.endsWith(".")) return false;
  const labels = s.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => LABEL_RE.test(l));
}

export interface ParsedDomainList {
  valid: string[];
  invalid: string[];
}

/**
 * Parse a string containing one or more domains.
 *
 * Accepts comma, whitespace, or newline separation so that both CLI
 * arguments (`a.com,b.com`) and files (one-per-line) work with the same
 * parser. Duplicates are removed; the output preserves input order on
 * first occurrence.
 */
export function parseDomainList(input: string | null | undefined): ParsedDomainList {
  if (!input) return { valid: [], invalid: [] };
  const tokens = input
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
    .filter(Boolean);
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const raw of tokens) {
    const norm = raw.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (isValidDomain(norm)) valid.push(norm);
    else invalid.push(raw);
  }
  return { valid, invalid };
}

/**
 * Extract the registrable second-level domain from a hostname.
 * Returns null on failure; used when scraping registrar portfolio pages
 * to normalize "www.example.com" → "example.com". Does not understand
 * the public suffix list, so `foo.co.uk` collapses to `co.uk`. Callers
 * that need PSL accuracy should swap this out for `tldts` or similar.
 */
export function rootOfHostname(hostname: string): string | null {
  if (!isValidDomain(hostname)) return null;
  const parts = hostname.split(".");
  return parts.slice(-2).join(".");
}
