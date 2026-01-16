import { test, expect, describe } from "bun:test";
import { JSDOM } from "jsdom";
import {
  areNameserversAlreadySet,
  isRedundantChangeError,
  hasFailureError,
  isUpdateSuccessful,
  determineUpdateOutcome,
  findNameserverInputs,
  isValidNameserver
} from "../lib/nameservers";

// ============ Tests ============

describe('Nameserver Detection', () => {
  test('detects when Cloudflare nameservers are already set', () => {
    const pageText = `
      DNS Management for codestitch.dev
      Current Nameservers:
      grannbo.ns.cloudflare.com
      patryk.ns.cloudflare.com
    `;
    const nameservers = ['grannbo.ns.cloudflare.com', 'patryk.ns.cloudflare.com'];

    expect(areNameserversAlreadySet(pageText, nameservers)).toBe(true);
  });

  test('returns false when nameservers are different', () => {
    const pageText = `
      DNS Management for codestitch.dev
      Current Nameservers:
      ns1.godaddy.com
      ns2.godaddy.com
    `;
    const nameservers = ['grannbo.ns.cloudflare.com', 'patryk.ns.cloudflare.com'];

    expect(areNameserversAlreadySet(pageText, nameservers)).toBe(false);
  });

  test('case insensitive matching', () => {
    const pageText = 'Using GRANNBO.NS.CLOUDFLARE.COM and PATRYK.NS.CLOUDFLARE.COM';
    const nameservers = ['grannbo.ns.cloudflare.com', 'patryk.ns.cloudflare.com'];

    expect(areNameserversAlreadySet(pageText, nameservers)).toBe(true);
  });

  test('returns false when only one nameserver matches', () => {
    const pageText = 'grannbo.ns.cloudflare.com';
    const nameservers = ['grannbo.ns.cloudflare.com', 'patryk.ns.cloudflare.com'];

    expect(areNameserversAlreadySet(pageText, nameservers)).toBe(false);
  });
});

describe('Error Detection', () => {
  test('detects NameserverRedundantChange as redundant error', () => {
    const pageText = 'Your attempt to update nameservers has failed. NameserverRedundantChange';
    expect(isRedundantChangeError(pageText)).toBe(true);
  });

  test('detects "already" keyword as redundant', () => {
    const pageText = 'Nameservers are already set to these values';
    expect(isRedundantChangeError(pageText)).toBe(true);
  });

  test('does not flag normal failure as redundant', () => {
    const pageText = 'Your attempt to update nameservers has failed. Please retry.';
    expect(isRedundantChangeError(pageText)).toBe(false);
  });

  test('detects failure error', () => {
    const pageText = 'Your attempt to update nameservers has failed. Please retry.';
    expect(hasFailureError(pageText)).toBe(true);
  });

  test('detects error keyword', () => {
    const pageText = 'An error occurred while updating nameservers';
    expect(hasFailureError(pageText)).toBe(true);
  });

  test('does not false positive on "no error"', () => {
    const pageText = 'Operation completed with no error';
    expect(hasFailureError(pageText)).toBe(false);
  });
});

describe('Success Detection', () => {
  test('detects success message', () => {
    expect(isUpdateSuccessful('Nameservers updated successfully')).toBe(true);
  });

  test('detects updated message', () => {
    expect(isUpdateSuccessful('Your nameservers have been updated')).toBe(true);
  });

  test('detects saved message', () => {
    expect(isUpdateSuccessful('Changes saved')).toBe(true);
  });

  test('does not false positive on pending state', () => {
    expect(isUpdateSuccessful('Click Save to update your nameservers')).toBe(false);
  });
});

describe('Update Outcome Determination', () => {
  test('success trumps other indicators', () => {
    const pageText = 'Nameservers updated successfully';
    expect(determineUpdateOutcome(pageText)).toBe('success');
  });

  test('redundant error counts as success', () => {
    const pageText = 'NameserverRedundantChange - nameservers already set';
    expect(determineUpdateOutcome(pageText)).toBe('redundant_success');
  });

  test('failed when explicit failure', () => {
    const pageText = 'Your attempt to update nameservers has failed. Please retry.';
    expect(determineUpdateOutcome(pageText)).toBe('failed');
  });

  test('unknown when no clear indicator', () => {
    const pageText = 'DNS Management page for codestitch.dev';
    expect(determineUpdateOutcome(pageText)).toBe('unknown');
  });

  test('real GoDaddy redundant error scenario', () => {
    // This is the actual error from the screenshot
    const pageText = `
      Edit nameservers
      Choose nameservers for codestitch.dev
      Your attempt to update nameservers has failed. Please retry.
      NameserverRedundantChange
      GoDaddy Nameservers (recommended)
      I'll use my own nameservers
      grannbo.ns.cloudflare.com
      patryk.ns.cloudflare.com
    `;

    // Even though it says "failed", the "redundant" keyword should indicate success
    expect(determineUpdateOutcome(pageText)).toBe('redundant_success');
  });
});

describe('Input Finding in Modal', () => {
  test('finds inputs in a dialog modal', () => {
    const html = `
      <html><body>
        <div role="dialog">
          <h2>Edit nameservers</h2>
          <input type="text" value="grannbo.ns.cloudflare.com">
          <input type="text" value="patryk.ns.cloudflare.com">
          <button>Save</button>
        </div>
      </body></html>
    `;

    const dom = new JSDOM(html);
    const inputs = findNameserverInputs(dom.window.document);

    expect(inputs.length).toBe(2);
  });

  test('finds inputs by nameserver-related attributes', () => {
    const html = `
      <html><body>
        <input type="text" name="nameserver1" value="">
        <input type="text" name="nameserver2" value="">
      </body></html>
    `;

    const dom = new JSDOM(html);
    const inputs = findNameserverInputs(dom.window.document);

    expect(inputs.length).toBe(2);
  });

  test('excludes disabled and hidden inputs', () => {
    const html = `
      <html><body>
        <div role="dialog">
          <input type="text" value="ns1">
          <input type="hidden" value="hidden">
          <input type="text" disabled value="disabled">
          <input type="text" value="ns2">
        </div>
      </body></html>
    `;

    const dom = new JSDOM(html);
    const inputs = findNameserverInputs(dom.window.document);

    expect(inputs.length).toBe(2);
  });
});

describe('GoDaddy Nameserver Modal Flow', () => {
  test('complete flow: detect modal, find inputs, check values', () => {
    const html = `
      <html><body>
        <div class="dns-management">
          <h1>DNS Management</h1>
          <div role="dialog" class="modal">
            <h2>Edit nameservers</h2>
            <div class="error-banner">
              Your attempt to update nameservers has failed. Please retry.
              NameserverRedundantChange
            </div>
            <label>
              <input type="radio" checked> I'll use my own nameservers
            </label>
            <input type="text" name="ns1" value="grannbo.ns.cloudflare.com">
            <input type="text" name="ns2" value="patryk.ns.cloudflare.com">
            <button class="save-btn">Save</button>
            <button class="cancel-btn">Cancel</button>
          </div>
        </div>
      </body></html>
    `;

    const dom = new JSDOM(html);
    const document = dom.window.document;
    const pageText = document.body.innerText || document.body.textContent || '';

    // Should find 2 inputs
    const inputs = findNameserverInputs(document);
    expect(inputs.length).toBe(2);

    // Values should already be filled
    expect(inputs[0].value).toBe('grannbo.ns.cloudflare.com');
    expect(inputs[1].value).toBe('patryk.ns.cloudflare.com');

    // Should detect redundant error (= success)
    expect(determineUpdateOutcome(pageText)).toBe('redundant_success');
  });
});

describe('Edge Cases', () => {
  test('handles empty nameserver array', () => {
    const pageText = 'Some page content';
    expect(areNameserversAlreadySet(pageText, [])).toBe(true);
  });

  test('handles empty page text', () => {
    const nameservers = ['ns1.cloudflare.com'];
    expect(areNameserversAlreadySet('', nameservers)).toBe(false);
  });

  test('handles partial nameserver match in wrong context', () => {
    // Just having "cloudflare" in the page doesn't mean NS are set
    const pageText = 'Cloudflare is a great service';
    const nameservers = ['ns1.cloudflare.com', 'ns2.cloudflare.com'];
    expect(areNameserversAlreadySet(pageText, nameservers)).toBe(false);
  });
});

describe('Nameserver Validation', () => {
  test('validates standard Cloudflare nameservers', () => {
    expect(isValidNameserver('grannbo.ns.cloudflare.com')).toBe(true);
    expect(isValidNameserver('patryk.ns.cloudflare.com')).toBe(true);
  });

  test('validates standard nameserver formats', () => {
    expect(isValidNameserver('ns1.example.com')).toBe(true);
    expect(isValidNameserver('ns2.example.com')).toBe(true);
    expect(isValidNameserver('dns1.registrar-servers.com')).toBe(true);
  });

  test('rejects invalid nameservers', () => {
    expect(isValidNameserver('')).toBe(false);
    expect(isValidNameserver('not-a-nameserver')).toBe(false);
    expect(isValidNameserver('http://ns1.example.com')).toBe(false);
    expect(isValidNameserver('ns1.example.com/')).toBe(false);
  });

  test('rejects names with invalid characters', () => {
    expect(isValidNameserver('ns1.example.com!')).toBe(false);
    expect(isValidNameserver('ns1 .example.com')).toBe(false);
  });
});
