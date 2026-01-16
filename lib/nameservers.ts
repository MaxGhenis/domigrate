/**
 * Pure functions for nameserver operations
 * These can be tested independently and used in content scripts
 */

/**
 * Check if Cloudflare nameservers are already set on the page
 */
export function areNameserversAlreadySet(pageText: string, nameservers: string[]): boolean {
  if (nameservers.length === 0) return true;
  const lowerPageText = pageText.toLowerCase();
  return nameservers.every(ns => lowerPageText.includes(ns.toLowerCase()));
}

/**
 * Detect if an error message indicates nameservers are already correct (redundant change)
 */
export function isRedundantChangeError(pageText: string): boolean {
  const lowerText = pageText.toLowerCase();
  return lowerText.includes('redundant') ||
         (lowerText.includes('already') && lowerText.includes('nameserver'));
}

/**
 * Detect if there's a failure error on the page
 */
export function hasFailureError(pageText: string): boolean {
  const lowerText = pageText.toLowerCase();
  return lowerText.includes('failed') ||
         (lowerText.includes('error') && !lowerText.includes('no error'));
}

/**
 * Detect if nameserver update was successful
 */
export function isUpdateSuccessful(pageText: string): boolean {
  const lowerText = pageText.toLowerCase();
  return lowerText.includes('success') ||
         lowerText.includes('updated') ||
         lowerText.includes('saved');
}

/**
 * Outcome types for nameserver updates
 */
export type UpdateOutcome = 'success' | 'redundant_success' | 'failed' | 'unknown';

/**
 * Determine the outcome of a nameserver update attempt
 */
export function determineUpdateOutcome(pageText: string): UpdateOutcome {
  if (isUpdateSuccessful(pageText)) {
    return 'success';
  }
  if (isRedundantChangeError(pageText)) {
    return 'redundant_success'; // Redundant = already correct = success
  }
  if (hasFailureError(pageText)) {
    return 'failed';
  }
  return 'unknown';
}

/**
 * Find nameserver inputs in a document (modal or page)
 * Works with both DOM and JSDOM
 */
export function findNameserverInputs(document: Document): HTMLInputElement[] {
  const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
  let inputs = Array.from(allInputs).filter(input => {
    const el = input as HTMLInputElement;
    const placeholder = (el.placeholder || '').toLowerCase();
    const name = (el.name || '').toLowerCase();
    const id = (el.id || '').toLowerCase();

    return placeholder.includes('nameserver') || placeholder.includes('ns') ||
           name.includes('nameserver') || name.includes('ns') ||
           id.includes('nameserver') || id.includes('ns');
  }) as HTMLInputElement[];

  // Fallback: look in modal
  if (inputs.length < 2) {
    const modal = document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="Modal"]');
    if (modal) {
      const modalInputs = modal.querySelectorAll('input[type="text"], input:not([type])');
      inputs = Array.from(modalInputs).filter(input => {
        const el = input as HTMLInputElement;
        return !el.disabled && el.type !== 'hidden';
      }) as HTMLInputElement[];
    }
  }

  return inputs;
}

/**
 * Validates that a value looks like a nameserver
 */
export function isValidNameserver(value: string): boolean {
  // Nameservers typically look like: ns1.example.com, grannbo.ns.cloudflare.com
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value);
}
