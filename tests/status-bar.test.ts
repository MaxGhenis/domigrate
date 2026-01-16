import { test, expect, describe } from "bun:test";

// Import pure functions from lib
const {
  STATE_LABELS,
  MIGRATION_STEPS,
  getStepIndex,
  getStateLabel,
  calculateProgress,
  getStepStatus
} = require('../lib/pure.js');

// Helper for progress display (thin wrapper over calculateProgress)
function getProgressDisplay(domains: Record<string, { state: string }>, currentIndex: number): string {
  const { total } = calculateProgress(domains);
  return `${currentIndex + 1} / ${total}`;
}

// ============ Tests ============

describe('State Labels', () => {
  test('all workflow states have labels', () => {
    const workflowStates = [
      'queued', 'getting_auth', 'waiting_for_2fa',
      'adding_to_cloudflare', 'selecting_plan',
      'getting_cf_nameservers', 'updating_nameservers',
      'complete', 'error'
    ];

    for (const state of workflowStates) {
      expect(STATE_LABELS[state]).toBeDefined();
      expect(STATE_LABELS[state].length).toBeGreaterThan(0);
    }
  });

  test('getStateLabel returns label for known state', () => {
    expect(getStateLabel('complete')).toBe('Complete');
    expect(getStateLabel('error')).toBe('Error');
    expect(getStateLabel('getting_auth')).toBe('Getting auth code...');
  });

  test('getStateLabel returns raw state for unknown state', () => {
    expect(getStateLabel('unknown_state')).toBe('unknown_state');
  });
});

describe('Migration Steps', () => {
  test('steps are in correct order', () => {
    const expectedOrder = [
      'getting_auth',
      'adding_to_cloudflare',
      'selecting_plan',
      'getting_cf_nameservers',
      'updating_nameservers',
      'complete'
    ];

    expect(MIGRATION_STEPS.map(s => s.state)).toEqual(expectedOrder);
  });

  test('complete is the last step', () => {
    expect(MIGRATION_STEPS[MIGRATION_STEPS.length - 1].state).toBe('complete');
  });

  test('each step has a label', () => {
    for (const step of MIGRATION_STEPS) {
      expect(step.label).toBeDefined();
      expect(step.label.length).toBeGreaterThan(0);
    }
  });
});

describe('getStepIndex', () => {
  test('returns correct index for each step', () => {
    expect(getStepIndex('getting_auth')).toBe(0);
    expect(getStepIndex('adding_to_cloudflare')).toBe(1);
    expect(getStepIndex('selecting_plan')).toBe(2);
    expect(getStepIndex('getting_cf_nameservers')).toBe(3);
    expect(getStepIndex('updating_nameservers')).toBe(4);
    expect(getStepIndex('complete')).toBe(5);
  });

  test('returns 0 for unknown state', () => {
    expect(getStepIndex('unknown')).toBe(0);
    expect(getStepIndex('queued')).toBe(0);
    expect(getStepIndex('error')).toBe(0);
  });

  test('returns 0 for waiting_for_2fa (sub-state of getting_auth)', () => {
    expect(getStepIndex('waiting_for_2fa')).toBe(0);
  });
});

describe('Progress Calculation', () => {
  test('calculates progress for empty domains', () => {
    const result = calculateProgress({});
    expect(result.completed).toBe(0);
    expect(result.total).toBe(0);
  });

  test('calculates progress for all pending', () => {
    const domains = {
      'a.com': { state: 'queued' },
      'b.com': { state: 'getting_auth' },
      'c.com': { state: 'updating_nameservers' }
    };
    const result = calculateProgress(domains);
    expect(result.completed).toBe(0);
    expect(result.total).toBe(3);
  });

  test('calculates progress with completed domains', () => {
    const domains = {
      'a.com': { state: 'complete' },
      'b.com': { state: 'getting_auth' },
      'c.com': { state: 'queued' }
    };
    const result = calculateProgress(domains);
    expect(result.completed).toBe(1);
    expect(result.total).toBe(3);
  });

  test('counts errors as completed (terminal state)', () => {
    const domains = {
      'a.com': { state: 'complete' },
      'b.com': { state: 'error' },
      'c.com': { state: 'queued' }
    };
    const result = calculateProgress(domains);
    expect(result.completed).toBe(2);
    expect(result.total).toBe(3);
  });

  test('all domains complete or error', () => {
    const domains = {
      'a.com': { state: 'complete' },
      'b.com': { state: 'complete' },
      'c.com': { state: 'error' }
    };
    const result = calculateProgress(domains);
    expect(result.completed).toBe(3);
    expect(result.total).toBe(3);
  });
});

describe('Progress Display', () => {
  test('shows 1-indexed current position', () => {
    const domains = {
      'a.com': { state: 'complete' },
      'b.com': { state: 'getting_auth' },
      'c.com': { state: 'queued' }
    };
    expect(getProgressDisplay(domains, 0)).toBe('1 / 3');
    expect(getProgressDisplay(domains, 1)).toBe('2 / 3');
    expect(getProgressDisplay(domains, 2)).toBe('3 / 3');
  });
});

describe('Step Status', () => {
  test('marks steps before current as completed', () => {
    expect(getStepStatus(0, 2)).toBe('completed');
    expect(getStepStatus(1, 2)).toBe('completed');
  });

  test('marks current step as current', () => {
    expect(getStepStatus(2, 2)).toBe('current');
  });

  test('marks steps after current as pending', () => {
    expect(getStepStatus(3, 2)).toBe('pending');
    expect(getStepStatus(4, 2)).toBe('pending');
  });

  test('first step is current when index is 0', () => {
    expect(getStepStatus(0, 0)).toBe('current');
    expect(getStepStatus(1, 0)).toBe('pending');
  });

  test('last step is current when complete', () => {
    const lastIndex = MIGRATION_STEPS.length - 1;
    expect(getStepStatus(lastIndex - 1, lastIndex)).toBe('completed');
    expect(getStepStatus(lastIndex, lastIndex)).toBe('current');
  });
});

describe('Real Scenario: 8 Domain Status Bar', () => {
  const domains: Record<string, { state: string }> = {
    'codestitch.dev': { state: 'complete' },
    'geteligible.org': { state: 'updating_nameservers' },
    'policyengine.ai': { state: 'queued' },
    'policyengine.co': { state: 'queued' },
    'policyengine.info': { state: 'queued' },
    'policyengine.online': { state: 'queued' },
    'policyengine.org.uk': { state: 'queued' },
    'societa.ai': { state: 'error' }
  };

  test('progress shows 2 terminal states (complete + error)', () => {
    const { completed, total } = calculateProgress(domains);
    expect(completed).toBe(2);
    expect(total).toBe(8);
  });

  test('current domain step index is 4 (updating_nameservers)', () => {
    const currentState = domains['geteligible.org'].state;
    expect(getStepIndex(currentState)).toBe(4);
  });

  test('step statuses for current domain', () => {
    const currentStepIndex = getStepIndex('updating_nameservers');

    expect(getStepStatus(0, currentStepIndex)).toBe('completed'); // getting_auth
    expect(getStepStatus(1, currentStepIndex)).toBe('completed'); // adding_to_cloudflare
    expect(getStepStatus(2, currentStepIndex)).toBe('completed'); // selecting_plan
    expect(getStepStatus(3, currentStepIndex)).toBe('completed'); // getting_cf_nameservers
    expect(getStepStatus(4, currentStepIndex)).toBe('current');   // updating_nameservers
    expect(getStepStatus(5, currentStepIndex)).toBe('pending');   // complete
  });

  test('state label for current domain', () => {
    expect(getStateLabel('updating_nameservers')).toBe('Updating nameservers...');
  });
});
