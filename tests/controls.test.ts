import { test, expect, describe } from "bun:test";

// ============ Pure functions for control flow ============

/**
 * Determine if a domain migration is complete
 */
function isDomainComplete(domain: { state: string }): boolean {
  return domain.state === 'complete';
}

/**
 * Determine if a domain has an error
 */
function isDomainError(domain: { state: string }): boolean {
  return domain.state === 'error';
}

/**
 * Determine if a domain is still pending (not complete, not error)
 */
function isDomainPending(domain: { state: string }): boolean {
  return domain.state !== 'complete' && domain.state !== 'error';
}

/**
 * Check if migration should proceed to next domain
 */
function shouldProceedToNextDomain(
  currentDomain: { state: string } | null,
  isRunning: boolean,
  isPaused: boolean
): boolean {
  if (!isRunning || isPaused) return false;
  if (!currentDomain) return false;
  return isDomainComplete(currentDomain) || isDomainError(currentDomain);
}

/**
 * Get action to send for pause/resume toggle
 */
function getPauseToggleAction(isPaused: boolean): string {
  return isPaused ? 'resumeMigration' : 'pauseMigration';
}

/**
 * Verify all domains completed successfully
 */
function allDomainsComplete(domains: Array<{ state: string }>): boolean {
  return domains.length > 0 && domains.every(d => d.state === 'complete');
}

/**
 * Count domains by state
 */
function countByState(domains: Array<{ state: string }>): {
  complete: number;
  error: number;
  pending: number;
} {
  return {
    complete: domains.filter(d => d.state === 'complete').length,
    error: domains.filter(d => d.state === 'error').length,
    pending: domains.filter(d => isDomainPending(d)).length
  };
}

/**
 * Check if domain has all required completion data
 */
function hasCompletionData(domain: {
  state: string;
  authCode?: string;
  cloudflareAdded?: boolean;
  nameservers?: { cloudflare?: string[] };
}): { complete: boolean; missing: string[] } {
  const missing: string[] = [];

  if (!domain.authCode) missing.push('authCode');
  if (!domain.cloudflareAdded) missing.push('cloudflareAdded');
  if (!domain.nameservers?.cloudflare?.length) missing.push('cloudflareNameservers');

  return {
    complete: missing.length === 0,
    missing
  };
}

// ============ Tests ============

describe('Domain State Checks', () => {
  test('isDomainComplete returns true only for complete state', () => {
    expect(isDomainComplete({ state: 'complete' })).toBe(true);
    expect(isDomainComplete({ state: 'error' })).toBe(false);
    expect(isDomainComplete({ state: 'queued' })).toBe(false);
    expect(isDomainComplete({ state: 'updating_nameservers' })).toBe(false);
  });

  test('isDomainError returns true only for error state', () => {
    expect(isDomainError({ state: 'error' })).toBe(true);
    expect(isDomainError({ state: 'complete' })).toBe(false);
    expect(isDomainError({ state: 'queued' })).toBe(false);
  });

  test('isDomainPending returns true for non-terminal states', () => {
    expect(isDomainPending({ state: 'queued' })).toBe(true);
    expect(isDomainPending({ state: 'getting_auth' })).toBe(true);
    expect(isDomainPending({ state: 'updating_nameservers' })).toBe(true);
    expect(isDomainPending({ state: 'complete' })).toBe(false);
    expect(isDomainPending({ state: 'error' })).toBe(false);
  });
});

describe('Migration Flow Control', () => {
  test('should not proceed when paused', () => {
    const domain = { state: 'complete' };
    expect(shouldProceedToNextDomain(domain, true, true)).toBe(false);
  });

  test('should not proceed when not running', () => {
    const domain = { state: 'complete' };
    expect(shouldProceedToNextDomain(domain, false, false)).toBe(false);
  });

  test('should not proceed when domain still pending', () => {
    const domain = { state: 'updating_nameservers' };
    expect(shouldProceedToNextDomain(domain, true, false)).toBe(false);
  });

  test('should proceed when domain complete and running', () => {
    const domain = { state: 'complete' };
    expect(shouldProceedToNextDomain(domain, true, false)).toBe(true);
  });

  test('should proceed when domain error and running (to skip)', () => {
    const domain = { state: 'error' };
    expect(shouldProceedToNextDomain(domain, true, false)).toBe(true);
  });

  test('should not proceed when no current domain', () => {
    expect(shouldProceedToNextDomain(null, true, false)).toBe(false);
  });
});

describe('Pause Toggle', () => {
  test('returns resumeMigration when paused', () => {
    expect(getPauseToggleAction(true)).toBe('resumeMigration');
  });

  test('returns pauseMigration when running', () => {
    expect(getPauseToggleAction(false)).toBe('pauseMigration');
  });
});

describe('Completion Verification', () => {
  test('allDomainsComplete returns true when all complete', () => {
    const domains = [
      { state: 'complete' },
      { state: 'complete' },
      { state: 'complete' }
    ];
    expect(allDomainsComplete(domains)).toBe(true);
  });

  test('allDomainsComplete returns false when any pending', () => {
    const domains = [
      { state: 'complete' },
      { state: 'updating_nameservers' },
      { state: 'complete' }
    ];
    expect(allDomainsComplete(domains)).toBe(false);
  });

  test('allDomainsComplete returns false when any error', () => {
    const domains = [
      { state: 'complete' },
      { state: 'error' },
      { state: 'complete' }
    ];
    expect(allDomainsComplete(domains)).toBe(false);
  });

  test('allDomainsComplete returns false for empty array', () => {
    expect(allDomainsComplete([])).toBe(false);
  });
});

describe('Count By State', () => {
  test('counts states correctly', () => {
    const domains = [
      { state: 'complete' },
      { state: 'complete' },
      { state: 'error' },
      { state: 'queued' },
      { state: 'updating_nameservers' }
    ];

    expect(countByState(domains)).toEqual({
      complete: 2,
      error: 1,
      pending: 2
    });
  });

  test('handles empty array', () => {
    expect(countByState([])).toEqual({
      complete: 0,
      error: 0,
      pending: 0
    });
  });
});

describe('Completion Data Verification', () => {
  test('complete domain has all data', () => {
    const domain = {
      state: 'complete',
      authCode: 'ABC123',
      cloudflareAdded: true,
      nameservers: { cloudflare: ['ns1.cloudflare.com', 'ns2.cloudflare.com'] }
    };

    const result = hasCompletionData(domain);
    expect(result.complete).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test('identifies missing auth code', () => {
    const domain = {
      state: 'complete',
      cloudflareAdded: true,
      nameservers: { cloudflare: ['ns1.cloudflare.com'] }
    };

    const result = hasCompletionData(domain);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('authCode');
  });

  test('identifies missing cloudflare added', () => {
    const domain = {
      state: 'complete',
      authCode: 'ABC123',
      nameservers: { cloudflare: ['ns1.cloudflare.com'] }
    };

    const result = hasCompletionData(domain);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('cloudflareAdded');
  });

  test('identifies missing nameservers', () => {
    const domain = {
      state: 'complete',
      authCode: 'ABC123',
      cloudflareAdded: true
    };

    const result = hasCompletionData(domain);
    expect(result.complete).toBe(false);
    expect(result.missing).toContain('cloudflareNameservers');
  });

  test('identifies all missing fields', () => {
    const domain = { state: 'queued' };

    const result = hasCompletionData(domain);
    expect(result.complete).toBe(false);
    expect(result.missing).toHaveLength(3);
  });

  // Real scenario: codestitch.dev completion check
  test('verifies codestitch.dev style completion', () => {
    const codestitch = {
      state: 'complete',
      name: 'codestitch.dev',
      authCode: 'ABC123XYZ',
      cloudflareAdded: true,
      nameservers: {
        cloudflare: ['grannbo.ns.cloudflare.com', 'patryk.ns.cloudflare.com']
      }
    };

    const result = hasCompletionData(codestitch);
    expect(result.complete).toBe(true);
    expect(isDomainComplete(codestitch)).toBe(true);
  });
});

describe('Real Scenario: 8 Domain Migration', () => {
  const domains = [
    { name: 'codestitch.dev', state: 'complete', authCode: 'a', cloudflareAdded: true, nameservers: { cloudflare: ['ns1.cf.com', 'ns2.cf.com'] } },
    { name: 'geteligible.org', state: 'updating_nameservers', authCode: 'b', cloudflareAdded: true, nameservers: { cloudflare: ['ns1.cf.com', 'ns2.cf.com'] } },
    { name: 'policyengine.ai', state: 'queued' },
    { name: 'policyengine.co', state: 'queued' },
    { name: 'policyengine.info', state: 'queued' },
    { name: 'policyengine.online', state: 'queued' },
    { name: 'policyengine.org.uk', state: 'queued' },
    { name: 'societa.ai', state: 'error', error: 'Nameserver update failed' }
  ];

  test('counts 8 domains correctly', () => {
    expect(domains.length).toBe(8);
  });

  test('counts states for real scenario', () => {
    const counts = countByState(domains);
    expect(counts.complete).toBe(1);
    expect(counts.error).toBe(1);
    expect(counts.pending).toBe(6);
  });

  test('not all complete', () => {
    expect(allDomainsComplete(domains)).toBe(false);
  });

  test('should not proceed when current domain pending', () => {
    const current = domains.find(d => d.name === 'geteligible.org');
    expect(shouldProceedToNextDomain(current!, true, false)).toBe(false);
  });

  test('should proceed after domain completes', () => {
    const completed = { ...domains[1], state: 'complete' };
    expect(shouldProceedToNextDomain(completed, true, false)).toBe(true);
  });
});
