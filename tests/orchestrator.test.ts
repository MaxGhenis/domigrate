import { test, expect, describe, beforeEach } from "bun:test";

// Test the state machine and domain processing logic

const States = {
  QUEUED: 'queued',
  GETTING_AUTH: 'getting_auth',
  ADDING_TO_CLOUDFLARE: 'adding_to_cloudflare',
  SELECTING_PLAN: 'selecting_plan',
  GETTING_CF_NAMESERVERS: 'getting_cf_nameservers',
  UPDATING_NAMESERVERS: 'updating_nameservers',
  COMPLETE: 'complete',
  ERROR: 'error'
} as const;

type State = typeof States[keyof typeof States];

interface Domain {
  name: string;
  state: State;
  sourceRegistrar: string;
  authCode?: string;
  nameservers?: {
    cloudflare?: string[];
    godaddy?: string[];
  };
  cloudflareAdded?: boolean;
  addedAt: string;
  lastUpdated: string;
}

// Pure function to determine next state
function getNextState(currentState: State, actionCompleted: string): State | null {
  const transitions: Record<string, Record<string, State>> = {
    [States.QUEUED]: { 'start': States.GETTING_AUTH },
    [States.GETTING_AUTH]: { 'extractAuthCode': States.ADDING_TO_CLOUDFLARE },
    [States.ADDING_TO_CLOUDFLARE]: { 'addDomainToCloudflare': States.SELECTING_PLAN },
    [States.SELECTING_PLAN]: { 'selectFreePlan': States.GETTING_CF_NAMESERVERS },
    [States.GETTING_CF_NAMESERVERS]: { 'extractCloudflareNameservers': States.UPDATING_NAMESERVERS },
    [States.UPDATING_NAMESERVERS]: { 'updateNameservers': States.COMPLETE },
  };

  return transitions[currentState]?.[actionCompleted] ?? null;
}

// Pure function to check if domain can skip a step
function canSkipStep(domain: Domain, state: State): State | null {
  // If already have auth code, skip getting auth
  if (state === States.GETTING_AUTH && domain.authCode) {
    return States.ADDING_TO_CLOUDFLARE;
  }

  // If already added to Cloudflare, skip adding
  if (state === States.ADDING_TO_CLOUDFLARE && domain.cloudflareAdded) {
    return States.GETTING_CF_NAMESERVERS;
  }

  // If already have Cloudflare nameservers, skip getting them
  if (state === States.GETTING_CF_NAMESERVERS && domain.nameservers?.cloudflare?.length) {
    return States.UPDATING_NAMESERVERS;
  }

  return null;
}

// Pure function to validate domain name
function isValidDomain(domain: string): boolean {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z]{2,}$/i.test(domain);
}

// Pure function to extract domain from URL path
function extractDomainFromPath(path: string): string | null {
  const parts = path.split('/').filter(Boolean);
  for (const part of parts) {
    if (isValidDomain(part)) {
      return part;
    }
  }
  return null;
}

// Pure function to calculate domain stats
function calculateStats(domains: Domain[]): { queued: number; active: number; complete: number; error: number } {
  const stats = { queued: 0, active: 0, complete: 0, error: 0 };
  const activeStates = ['getting_auth', 'adding_to_cloudflare', 'selecting_plan', 'getting_cf_nameservers', 'updating_nameservers'];

  for (const domain of domains) {
    if (domain.state === 'complete') stats.complete++;
    else if (domain.state === 'error') stats.error++;
    else if (activeStates.includes(domain.state)) stats.active++;
    else stats.queued++;
  }

  return stats;
}

describe('State Machine', () => {
  test('transitions from QUEUED to GETTING_AUTH on start', () => {
    expect(getNextState(States.QUEUED, 'start')).toBe(States.GETTING_AUTH);
  });

  test('transitions from GETTING_AUTH to ADDING_TO_CLOUDFLARE on extractAuthCode', () => {
    expect(getNextState(States.GETTING_AUTH, 'extractAuthCode')).toBe(States.ADDING_TO_CLOUDFLARE);
  });

  test('transitions from ADDING_TO_CLOUDFLARE to SELECTING_PLAN on addDomainToCloudflare', () => {
    expect(getNextState(States.ADDING_TO_CLOUDFLARE, 'addDomainToCloudflare')).toBe(States.SELECTING_PLAN);
  });

  test('transitions from SELECTING_PLAN to GETTING_CF_NAMESERVERS on selectFreePlan', () => {
    expect(getNextState(States.SELECTING_PLAN, 'selectFreePlan')).toBe(States.GETTING_CF_NAMESERVERS);
  });

  test('transitions from GETTING_CF_NAMESERVERS to UPDATING_NAMESERVERS on extractCloudflareNameservers', () => {
    expect(getNextState(States.GETTING_CF_NAMESERVERS, 'extractCloudflareNameservers')).toBe(States.UPDATING_NAMESERVERS);
  });

  test('transitions from UPDATING_NAMESERVERS to COMPLETE on updateNameservers', () => {
    expect(getNextState(States.UPDATING_NAMESERVERS, 'updateNameservers')).toBe(States.COMPLETE);
  });

  test('returns null for invalid transitions', () => {
    expect(getNextState(States.COMPLETE, 'start')).toBeNull();
    expect(getNextState(States.ERROR, 'extractAuthCode')).toBeNull();
  });
});

describe('Skip Step Logic', () => {
  const baseDomain: Domain = {
    name: 'example.com',
    state: States.QUEUED,
    sourceRegistrar: 'godaddy',
    addedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString()
  };

  test('skips GETTING_AUTH if authCode already exists', () => {
    const domain = { ...baseDomain, authCode: 'ABC123' };
    expect(canSkipStep(domain, States.GETTING_AUTH)).toBe(States.ADDING_TO_CLOUDFLARE);
  });

  test('does not skip GETTING_AUTH if no authCode', () => {
    expect(canSkipStep(baseDomain, States.GETTING_AUTH)).toBeNull();
  });

  test('skips ADDING_TO_CLOUDFLARE if cloudflareAdded is true', () => {
    const domain = { ...baseDomain, cloudflareAdded: true };
    expect(canSkipStep(domain, States.ADDING_TO_CLOUDFLARE)).toBe(States.GETTING_CF_NAMESERVERS);
  });

  test('skips GETTING_CF_NAMESERVERS if nameservers already exist', () => {
    const domain = { ...baseDomain, nameservers: { cloudflare: ['ns1.cloudflare.com', 'ns2.cloudflare.com'] } };
    expect(canSkipStep(domain, States.GETTING_CF_NAMESERVERS)).toBe(States.UPDATING_NAMESERVERS);
  });
});

describe('Domain Validation', () => {
  test('validates correct domain names', () => {
    expect(isValidDomain('example.com')).toBe(true);
    expect(isValidDomain('my-domain.org')).toBe(true);
    expect(isValidDomain('test123.io')).toBe(true);
    expect(isValidDomain('a.ai')).toBe(true);
  });

  test('rejects subdomains and multi-level domains', () => {
    // Domain validation is for root domains only (what you transfer)
    expect(isValidDomain('sub.example.com')).toBe(false);
    expect(isValidDomain('www.example.com')).toBe(false);
    expect(isValidDomain('my-site.co.uk')).toBe(false);
  });

  test('rejects invalid domain names', () => {
    expect(isValidDomain('')).toBe(false);
    expect(isValidDomain('example')).toBe(false);
    expect(isValidDomain('.com')).toBe(false);
    expect(isValidDomain('example..com')).toBe(false);
    expect(isValidDomain('-example.com')).toBe(false);
  });
});

describe('Extract Domain from Path', () => {
  test('extracts domain from portfolio path', () => {
    expect(extractDomainFromPath('/portfolio/example.com/settings')).toBe('example.com');
    expect(extractDomainFromPath('/control/portfolio/mysite.io')).toBe('mysite.io');
  });

  test('extracts domain from Cloudflare path', () => {
    expect(extractDomainFromPath('/abc123def456/example.com/dns')).toBe('example.com');
  });

  test('returns null for paths without domains', () => {
    expect(extractDomainFromPath('/portfolio/')).toBeNull();
    expect(extractDomainFromPath('/settings')).toBeNull();
  });
});

describe('Statistics Calculation', () => {
  test('calculates correct stats for empty array', () => {
    expect(calculateStats([])).toEqual({ queued: 0, active: 0, complete: 0, error: 0 });
  });

  test('calculates correct stats for mixed states', () => {
    const domains: Domain[] = [
      { name: 'a.com', state: States.QUEUED, sourceRegistrar: 'godaddy', addedAt: '', lastUpdated: '' },
      { name: 'b.com', state: States.GETTING_AUTH, sourceRegistrar: 'godaddy', addedAt: '', lastUpdated: '' },
      { name: 'c.com', state: States.COMPLETE, sourceRegistrar: 'godaddy', addedAt: '', lastUpdated: '' },
      { name: 'd.com', state: States.ERROR, sourceRegistrar: 'godaddy', addedAt: '', lastUpdated: '' },
      { name: 'e.com', state: States.ADDING_TO_CLOUDFLARE, sourceRegistrar: 'godaddy', addedAt: '', lastUpdated: '' },
    ];

    expect(calculateStats(domains)).toEqual({ queued: 1, active: 2, complete: 1, error: 1 });
  });

  test('treats all active states correctly', () => {
    const activeStates = [
      States.GETTING_AUTH,
      States.ADDING_TO_CLOUDFLARE,
      States.SELECTING_PLAN,
      States.GETTING_CF_NAMESERVERS,
      States.UPDATING_NAMESERVERS
    ];

    const domains: Domain[] = activeStates.map((state, i) => ({
      name: `domain${i}.com`,
      state,
      sourceRegistrar: 'godaddy',
      addedAt: '',
      lastUpdated: ''
    }));

    expect(calculateStats(domains)).toEqual({ queued: 0, active: 5, complete: 0, error: 0 });
  });
});
