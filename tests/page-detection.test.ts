import { test, expect, describe } from "bun:test";

// Import pure functions from lib
const {
  DOMAIN_PATTERN,
  isValidAuthCode,
  detectGoDaddyPageType,
  detectCloudflarePageType,
  extractCloudflareUrlInfo,
  findCloudflareNameservers,
  isPromoElement,
  extractDomainFromPath,
  hasCloudflareNameservers,
  nameserversAlreadySet,
  hasPendingEvent,
  isTransferStep1
} = require('../lib/pure.js');

// ============ Tests ============

describe('Domain Pattern', () => {
  test('matches valid domains', () => {
    expect('policyengine.org'.match(DOMAIN_PATTERN)?.[1]).toBe('policyengine.org');
    expect('example.com'.match(DOMAIN_PATTERN)?.[1]).toBe('example.com');
    expect('my-site.io'.match(DOMAIN_PATTERN)?.[1]).toBe('my-site.io');
    expect('sub.domain.co.uk'.match(DOMAIN_PATTERN)?.[1]).toBe('sub.domain');
  });

  test('rejects invalid strings', () => {
    expect('notadomain'.match(DOMAIN_PATTERN)).toBe(null);
    expect('.com'.match(DOMAIN_PATTERN)).toBe(null);
    expect('a.b'.match(DOMAIN_PATTERN)).toBe(null); // TLD too short
  });
});

describe('Auth Code Validation', () => {
  test('accepts valid auth codes', () => {
    expect(isValidAuthCode('ABC12345')).toBe(true);
    expect(isValidAuthCode('xyz789ABC')).toBe(true);
    expect(isValidAuthCode('A1B2C3D4E5')).toBe(true);
    expect(isValidAuthCode('!@#abc123')).toBe(true);
  });

  test('rejects codes too short', () => {
    expect(isValidAuthCode('ABC123')).toBe(false);
    expect(isValidAuthCode('A1')).toBe(false);
  });

  test('rejects codes too long', () => {
    expect(isValidAuthCode('A'.repeat(31))).toBe(false);
  });

  test('rejects codes with spaces', () => {
    expect(isValidAuthCode('ABC 12345')).toBe(false);
    expect(isValidAuthCode('ABC12345 ')).toBe(false);
  });

  test('rejects codes without letters', () => {
    expect(isValidAuthCode('12345678')).toBe(false);
  });

  test('rejects codes without numbers', () => {
    expect(isValidAuthCode('ABCDEFGH')).toBe(false);
  });
});

describe('GoDaddy Page Detection', () => {
  test('detects SSO/login pages', () => {
    expect(detectGoDaddyPageType('https://sso.godaddy.com/login', '/login')).toBe('verification_required');
    expect(detectGoDaddyPageType('https://godaddy.com/login', '/login')).toBe('verification_required');
    expect(detectGoDaddyPageType('https://godaddy.com/verify', '/verify')).toBe('verification_required');
  });

  test('detects transfer out page', () => {
    expect(detectGoDaddyPageType('https://dcc.godaddy.com/control/example.com/transferOut', '/control/example.com/transferOut')).toBe('transfer_out');
  });

  test('detects transfers list', () => {
    expect(detectGoDaddyPageType('https://dcc.godaddy.com/transfers', '/transfers')).toBe('transfers');
  });

  test('detects portfolio list', () => {
    expect(detectGoDaddyPageType('https://dcc.godaddy.com/portfolio', '/portfolio')).toBe('portfolio_list');
  });

  test('detects domain settings', () => {
    expect(detectGoDaddyPageType('https://dcc.godaddy.com/settings', '/settings')).toBe('domain_settings');
  });

  test('detects DNS management', () => {
    expect(detectGoDaddyPageType('https://dcc.godaddy.com/dnsmanagement?domain=x.com', '/dnsmanagement')).toBe('dns_management');
  });

  test('detects nameservers subtab', () => {
    expect(detectGoDaddyPageType('https://dcc.godaddy.com/dnsmanagement?subtab=nameservers', '/dnsmanagement')).toBe('nameservers');
  });

  test('detects domain overview', () => {
    expect(detectGoDaddyPageType('https://dcc.godaddy.com/portfolio/example.com', '/portfolio/example.com')).toBe('domain_overview');
  });

  test('returns unknown for unrecognized pages', () => {
    expect(detectGoDaddyPageType('https://dcc.godaddy.com/random', '/random')).toBe('unknown');
  });
});

describe('Cloudflare Page Detection', () => {
  test('detects add-site page', () => {
    expect(detectCloudflarePageType('https://dash.cloudflare.com/add-site', '/add-site')).toBe('add_domain');
    expect(detectCloudflarePageType('https://dash.cloudflare.com/?to=/:account/add-site', '/')).toBe('add_domain');
  });

  test('detects DNS page', () => {
    expect(detectCloudflarePageType('https://dash.cloudflare.com/abc123/example.com/dns', '/abc123/example.com/dns')).toBe('domain_dns');
  });

  test('detects domain overview', () => {
    const accountId = 'a'.repeat(32);
    expect(detectCloudflarePageType(`https://dash.cloudflare.com/${accountId}/example.com`, `/${accountId}/example.com`)).toBe('domain_overview');
  });

  test('detects account home', () => {
    const accountId = 'b'.repeat(32);
    expect(detectCloudflarePageType(`https://dash.cloudflare.com/${accountId}/home`, `/${accountId}/home`)).toBe('account_home');
    expect(detectCloudflarePageType(`https://dash.cloudflare.com/${accountId}`, `/${accountId}`)).toBe('account_home');
  });
});

describe('Cloudflare URL Info Extraction', () => {
  test('extracts account ID and domain from path', () => {
    const accountId = '010d8d7f3b423be5ce36c7a5a49e91e4';
    const result = extractCloudflareUrlInfo(`/${accountId}/policyengine.org/dns`);
    expect(result.accountId).toBe(accountId);
    expect(result.domain).toBe('policyengine.org');
  });

  test('extracts only account ID when no domain', () => {
    const accountId = 'abcd1234abcd1234abcd1234abcd1234';
    const result = extractCloudflareUrlInfo(`/${accountId}/home`);
    expect(result.accountId).toBe(accountId);
    expect(result.domain).toBe(null);
  });

  test('extracts domain from title when not in path', () => {
    const accountId = 'abcd1234abcd1234abcd1234abcd1234';
    const result = extractCloudflareUrlInfo(`/${accountId}`, 'example.com | Cloudflare');
    expect(result.accountId).toBe(accountId);
    expect(result.domain).toBe('example.com');
  });

  test('ignores cloudflare in title', () => {
    const result = extractCloudflareUrlInfo('/dashboard', 'cloudflare.com Dashboard');
    expect(result.domain).toBe(null);
  });

  test('handles empty path', () => {
    const result = extractCloudflareUrlInfo('/');
    expect(result.accountId).toBe(null);
    expect(result.domain).toBe(null);
  });
});

describe('Cloudflare Nameserver Extraction', () => {
  test('extracts nameservers from page text', () => {
    const text = 'Update your nameservers to: anna.ns.cloudflare.com and bob.ns.cloudflare.com';
    const ns = findCloudflareNameservers(text);
    expect(ns).toContain('anna.ns.cloudflare.com');
    expect(ns).toContain('bob.ns.cloudflare.com');
    expect(ns.length).toBe(2);
  });

  test('deduplicates nameservers', () => {
    const text = 'NS1: anna.ns.cloudflare.com NS2: anna.ns.cloudflare.com bob.ns.cloudflare.com';
    const ns = findCloudflareNameservers(text);
    expect(ns.length).toBe(2);
  });

  test('returns empty array when no nameservers', () => {
    const text = 'No nameservers here';
    expect(findCloudflareNameservers(text)).toEqual([]);
  });

  test('handles mixed case', () => {
    const text = 'ANNA.NS.CLOUDFLARE.COM and Bob.Ns.Cloudflare.Com';
    const ns = findCloudflareNameservers(text);
    expect(ns.length).toBe(2);
  });
});

describe('Promo Element Detection', () => {
  test('detects "add to cart" promos', () => {
    expect(isPromoElement('policyengine.ai add to cart $12.99')).toBe(true);
  });

  test('detects "get" promos', () => {
    expect(isPromoElement('get policyengine.ai now')).toBe(true);
  });

  test('detects "buy" promos', () => {
    expect(isPromoElement('buy example.com today')).toBe(true);
  });

  test('detects pricing indicators', () => {
    expect(isPromoElement('example.com $9.99/yr')).toBe(true);
    expect(isPromoElement('example.com $9.99/year')).toBe(true);
    expect(isPromoElement('example.com for only $12')).toBe(true);
  });

  test('detects brand protection upsells', () => {
    expect(isPromoElement('safeguard your domain')).toBe(true);
    expect(isPromoElement('ensure its authenticity')).toBe(true);
    expect(isPromoElement('protect your brand today')).toBe(true);
  });

  test('allows legitimate domain elements', () => {
    expect(isPromoElement('policyengine.org')).toBe(false);
    expect(isPromoElement('example.com settings')).toBe(false);
    expect(isPromoElement('manage dns for mydomain.io')).toBe(false);
  });
});

describe('Domain Extraction from Path', () => {
  test('extracts domain from GoDaddy portfolio path', () => {
    expect(extractDomainFromPath('/portfolio/example.com')).toBe('example.com');
    expect(extractDomainFromPath('/portfolio/my-site.io')).toBe('my-site.io');
  });

  test('extracts domain from Cloudflare path', () => {
    expect(extractDomainFromPath('/abc123/policyengine.org/dns')).toBe('policyengine.org');
  });

  test('returns null when no domain', () => {
    expect(extractDomainFromPath('/portfolio')).toBe(null);
    expect(extractDomainFromPath('/settings')).toBe(null);
  });
});

describe('Cloudflare Nameserver Detection', () => {
  test('detects Cloudflare nameservers on page', () => {
    expect(hasCloudflareNameservers('Your nameservers: anna.ns.cloudflare.com')).toBe(true);
    expect(hasCloudflareNameservers('ANNA.NS.CLOUDFLARE.COM')).toBe(true);
  });

  test('returns false when no CF nameservers', () => {
    expect(hasCloudflareNameservers('ns1.godaddy.com')).toBe(false);
    expect(hasCloudflareNameservers('No nameservers set')).toBe(false);
  });
});

describe('Nameserver Already Set Detection', () => {
  test('detects when all nameservers are present', () => {
    const pageText = 'NS1: anna.ns.cloudflare.com NS2: bob.ns.cloudflare.com';
    const nameservers = ['anna.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
    expect(nameserversAlreadySet(pageText, nameservers)).toBe(true);
  });

  test('returns false when some nameservers missing', () => {
    const pageText = 'NS1: anna.ns.cloudflare.com';
    const nameservers = ['anna.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
    expect(nameserversAlreadySet(pageText, nameservers)).toBe(false);
  });

  test('handles case insensitivity', () => {
    const pageText = 'NS1: ANNA.NS.CLOUDFLARE.COM NS2: BOB.NS.CLOUDFLARE.COM';
    const nameservers = ['anna.ns.cloudflare.com', 'bob.ns.cloudflare.com'];
    expect(nameserversAlreadySet(pageText, nameservers)).toBe(true);
  });
});

describe('GoDaddy Pending Event Detection', () => {
  test('detects pending event messages', () => {
    expect(hasPendingEvent('This domain has a pending event')).toBe(true);
    expect(hasPendingEvent('There is a pending operation on this domain')).toBe(true);
  });

  test('returns false when no pending event', () => {
    expect(hasPendingEvent('Domain is ready')).toBe(false);
    expect(hasPendingEvent('Nameserver update complete')).toBe(false);
  });
});

describe('GoDaddy Transfer Step Detection', () => {
  test('detects Step 1 of 2', () => {
    expect(isTransferStep1('Transfer Out Step 1 of 2')).toBe(true);
    expect(isTransferStep1('Complete checklist Step 1 of 2')).toBe(true);
  });

  test('returns false for Step 2', () => {
    expect(isTransferStep1('Step 2 of 2')).toBe(false);
    expect(isTransferStep1('Authorization code')).toBe(false);
  });
});

describe('Real Scenarios', () => {
  test('GoDaddy transfer flow for policyengine.ai', () => {
    const url = 'https://dcc.godaddy.com/control/policyengine.ai/transferOut';
    const path = '/control/policyengine.ai/transferOut';

    expect(detectGoDaddyPageType(url, path)).toBe('transfer_out');
    expect(extractDomainFromPath(path)).toBe('policyengine.ai');
  });

  test('Cloudflare DNS page for policyengine.org', () => {
    const accountId = '010d8d7f3b423be5ce36c7a5a49e91e4';
    const path = `/${accountId}/policyengine.org/dns/records`;
    const url = `https://dash.cloudflare.com${path}`;

    expect(detectCloudflarePageType(url, path)).toBe('domain_dns');
    const info = extractCloudflareUrlInfo(path);
    expect(info.accountId).toBe(accountId);
    expect(info.domain).toBe('policyengine.org');
  });

  test('GoDaddy nameserver page with Cloudflare NS already set', () => {
    const pageText = `
      Current Nameservers:
      NS1: anna.ns.cloudflare.com
      NS2: bob.ns.cloudflare.com

      Last updated: Jan 15, 2026
    `;

    expect(hasCloudflareNameservers(pageText)).toBe(true);
    expect(nameserversAlreadySet(pageText, ['anna.ns.cloudflare.com', 'bob.ns.cloudflare.com'])).toBe(true);
  });

  test('validate real auth code format', () => {
    // Real GoDaddy auth codes look like this
    expect(isValidAuthCode('Abc12XyZ')).toBe(true);
    expect(isValidAuthCode('K#mL9!pQr$')).toBe(true);
    // But not these
    expect(isValidAuthCode('pending')).toBe(false);  // No numbers
    expect(isValidAuthCode('12345678')).toBe(false); // No letters
  });
});
