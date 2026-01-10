import { test, expect, describe, beforeEach } from "bun:test";
import { JSDOM } from "jsdom";

// Recreate the scanner logic for testing
function scanForDomains(
  document: Document,
  linkSelectors: string[],
  hrefPattern: RegExp
): string[] {
  const domains: string[] = [];
  const domainElements = document.querySelectorAll(linkSelectors.join(', '));

  for (const el of domainElements) {
    const elementText = el.textContent?.toLowerCase() || '';
    const parent = el.closest('tr, li, div, section, [class*="row"], [class*="item"], [class*="card"]');
    const parentText = parent?.textContent?.toLowerCase() || '';
    const combinedText = `${elementText} ${parentText}`;

    const isPromo = combinedText.includes('add to cart') ||
                    combinedText.includes('get ') ||
                    combinedText.includes('buy ') ||
                    combinedText.includes('safeguard') ||
                    combinedText.includes('ensure its authenticity') ||
                    combinedText.includes('protect your brand') ||
                    combinedText.includes('/yr') ||
                    combinedText.includes('/year') ||
                    combinedText.includes('$');

    if (isPromo) {
      continue;
    }

    const href = el.getAttribute('href') || '';
    const hrefMatch = href.match(hrefPattern);
    if (hrefMatch) {
      domains.push(hrefMatch[1].toLowerCase());
      continue;
    }

    const text = el.textContent?.trim() || '';
    const textMatch = text.match(/^([a-z0-9][a-z0-9-]*\.[a-z]{2,})$/i);
    if (textMatch) {
      domains.push(textMatch[1].toLowerCase());
    }
  }

  return [...new Set(domains)];
}

const GODADDY_SELECTORS = ['a[href*="/portfolio/"]', '[data-testid*="domain"]', '.domain-item', '.domain-name'];
const GODADDY_PATTERN = /\/portfolio\/([a-z0-9-]+\.[a-z]{2,})/i;

describe('GoDaddy Scanner - Real Page Structure', () => {
  test('does NOT pick up codestitch.ai promo from inline banner', () => {
    // Exact structure from real GoDaddy page
    const html = `
      <html><body>
        <table>
          <tr>
            <td><a href="/control/portfolio/codestitch.dev/settings"><span class="ux-button-text">codestitch.dev</span></a></td>
            <td>Dec 28, 2026</td>
          </tr>
          <tr>
            <td colspan="5">
              <div class="inline-table-banner">
                <div class="portfolio-inline-banner--container">
                  <span class="portfolio-inline-banner--tld-domain-suggestion-get-domain-text">
                    Get <strong>codestitch.ai</strong>
                  </span>
                  <span>To confidently safeguard your brand and ensure its authenticity!</span>
                  <span class="pricing-main-price">$49.99</span>
                  <button>Add to Cart</button>
                </div>
              </div>
            </td>
          </tr>
          <tr>
            <td><a href="/control/portfolio/geteligible.org/settings"><span>geteligible.org</span></a></td>
            <td>Jul 1, 2026</td>
          </tr>
        </table>
      </body></html>
    `;

    const dom = new JSDOM(html);
    const result = scanForDomains(dom.window.document, GODADDY_SELECTORS, GODADDY_PATTERN);

    expect(result).toContain('codestitch.dev');
    expect(result).toContain('geteligible.org');
    expect(result).not.toContain('codestitch.ai'); // THE KEY ASSERTION
  });

  test('finds all 8 real domains from GoDaddy portfolio', () => {
    const html = `
      <html><body>
        <div>
          <a href="/control/portfolio/codestitch.dev/settings">codestitch.dev</a>
          <a href="/control/portfolio/geteligible.org/settings">geteligible.org</a>
          <a href="/control/portfolio/policyengine.ai/settings">policyengine.ai</a>
          <a href="/control/portfolio/policyengine.co/settings">policyengine.co</a>
          <a href="/control/portfolio/policyengine.info/settings">policyengine.info</a>
          <a href="/control/portfolio/policyengine.online/settings">policyengine.online</a>
          <a href="/control/portfolio/policyengine.org.uk/settings">policyengine.org.uk</a>
          <a href="/control/portfolio/societa.ai/settings">societa.ai</a>
        </div>
        <!-- Promo banner - should be ignored -->
        <div class="inline-table-banner">
          <span>Get <strong>codestitch.ai</strong></span>
          <span>$49.99/yr - safeguard your brand</span>
          <button>Add to Cart</button>
        </div>
      </body></html>
    `;

    const dom = new JSDOM(html);
    const result = scanForDomains(dom.window.document, GODADDY_SELECTORS, GODADDY_PATTERN);

    expect(result).toHaveLength(8);
    expect(result).not.toContain('codestitch.ai');
  });

  test('filters domain even if promo has portfolio link', () => {
    // Edge case: what if promo DOES have a portfolio link?
    const html = `
      <html><body>
        <a href="/control/portfolio/real-domain.com/settings">real-domain.com</a>
        <div class="inline-table-banner">
          <a href="/control/portfolio/promo-domain.ai/settings">
            Get <strong>promo-domain.ai</strong> - $49.99/yr
          </a>
        </div>
      </body></html>
    `;

    const dom = new JSDOM(html);
    const result = scanForDomains(dom.window.document, GODADDY_SELECTORS, GODADDY_PATTERN);

    expect(result).toContain('real-domain.com');
    expect(result).not.toContain('promo-domain.ai');
  });
});
