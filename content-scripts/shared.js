// Domain Migrator - Shared Utilities for Content Scripts
// Common functions used across all registrar content scripts

'use strict';

/**
 * Delays execution for specified milliseconds.
 * @param {number} ms - Milliseconds to wait
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Finds a visible button matching any of the text patterns.
 * @param {string[]} textPatterns - Lowercase text patterns to match
 * @param {Object} options - Additional options
 * @param {boolean} options.checkDisabled - Whether to skip disabled buttons
 * @param {boolean} options.checkAriaLabel - Whether to check aria-label
 * @returns {HTMLElement|null}
 */
function findButton(textPatterns, options = {}) {
  const { checkDisabled = false, checkAriaLabel = false } = options;
  const buttons = document.querySelectorAll('button, a, [role="button"], input[type="submit"], [class*="Button"]');

  for (const btn of buttons) {
    const text = btn.textContent?.toLowerCase() || btn.value?.toLowerCase() || '';
    const ariaLabel = checkAriaLabel ? (btn.getAttribute('aria-label') || '').toLowerCase() : '';

    const matches = textPatterns.some(pattern =>
      text.includes(pattern) || (checkAriaLabel && ariaLabel.includes(pattern))
    );

    if (!matches) continue;

    const rect = btn.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    if (checkDisabled) {
      const style = window.getComputedStyle(btn);
      if (btn.disabled || btn.classList.contains('disabled') ||
          style.display === 'none' || style.visibility === 'hidden') {
        continue;
      }
    }

    return btn;
  }

  return null;
}

/**
 * Reports an error to the background script.
 * @param {string} domain - Domain name
 * @param {string} error - Error message
 * @param {string} registrar - Registrar identifier
 */
async function reportError(domain, error, registrar) {
  console.error(`Error for ${domain}: ${error}`);
  await chrome.runtime.sendMessage({
    action: 'actionError',
    data: { domain, error, registrar }
  });
}

/**
 * Watches for SPA navigation and calls the reinit callback.
 * @param {Function} reinitCallback - Function to call on navigation
 * @param {number} delay - Delay before reinitializing (default 1500ms)
 */
function watchForNavigation(reinitCallback, delay = 1500) {
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      console.log('Navigation detected, reinitializing...');
      setTimeout(reinitCallback, delay);
    }
  }).observe(document.body, { subtree: true, childList: true });
}

/**
 * Waits for page content to stabilize.
 * @param {Object} options - Configuration options
 * @param {number} options.minContentLength - Minimum body text length
 * @param {number} options.initialDelay - Initial delay before checking
 * @param {number} options.checkInterval - Interval between checks
 * @returns {Promise<void>}
 */
function waitForPageReady(options = {}) {
  const {
    minContentLength = 500,
    initialDelay = 1000,
    checkInterval = 500
  } = options;

  return new Promise(resolve => {
    const checkReady = () => {
      const hasContent = document.body?.textContent?.length > minContentLength;
      const notLoading = !document.querySelector('.loading, .spinner, [class*="loading"], [class*="spinner"]');
      if (hasContent && notLoading) {
        resolve();
      } else {
        setTimeout(checkReady, checkInterval);
      }
    };
    setTimeout(checkReady, initialDelay);
  });
}

/**
 * Finds nameserver input fields on the page.
 * @returns {HTMLInputElement[]}
 */
function findNameserverInputs() {
  const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
  return Array.from(allInputs).filter(input => {
    const placeholder = (input.placeholder || '').toLowerCase();
    const name = (input.name || '').toLowerCase();
    const id = (input.id || '').toLowerCase();
    const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
    const labelText = input.closest('label')?.textContent?.toLowerCase() || '';

    return placeholder.includes('nameserver') || placeholder.includes('ns') ||
           name.includes('nameserver') || name.includes('ns') ||
           id.includes('nameserver') || id.includes('ns') ||
           ariaLabel.includes('nameserver') || labelText.includes('nameserver');
  });
}

/**
 * Sets up the standard message listener for content scripts.
 * @param {Function} executeAction - Action executor function
 */
function setupMessageListener(executeAction) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'statusUpdate') {
      console.log('Status update:', message.status);
    }
    if (message.action === 'executeAction') {
      executeAction(message.instruction.action, message);
    }
    sendResponse({ received: true });
    return true;
  });
}

/**
 * Fills nameserver inputs with provided values.
 * @param {HTMLInputElement[]} inputs - Input elements
 * @param {string[]} nameservers - Nameserver values to fill
 */
async function fillNameserverInputs(inputs, nameservers) {
  for (let i = 0; i < nameservers.length; i++) {
    if (inputs[i]) {
      inputs[i].focus();
      inputs[i].value = '';
      inputs[i].value = nameservers[i];
      inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
      inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
      await wait(300);
    }
  }
}

/**
 * Fills a text input and dispatches change events.
 * @param {HTMLInputElement} input - Input element
 * @param {string} value - Value to set
 */
function fillInput(input, value) {
  input.focus();
  input.value = '';
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Extracts domain from various page sources.
 * @param {RegExp} domainPattern - Pattern to match domain names
 * @param {Object} extractors - Extractor functions for different sources
 * @returns {string|null}
 */
function extractDomainFromPage(domainPattern, extractors = {}) {
  const { fromUrl, fromTitle = true, fromHeader = true } = extractors;

  // Try URL-based extraction first (registrar-specific)
  if (fromUrl) {
    const result = fromUrl();
    if (result) return result;
  }

  // Check page title
  if (fromTitle) {
    const titleMatch = document.title.match(domainPattern);
    if (titleMatch) return titleMatch[1].toLowerCase();
  }

  // Look for domain in h1 or header
  if (fromHeader) {
    const h1 = document.querySelector('h1, .domain-name, [data-testid*="domain"], [class*="domain-name"], [class*="DomainName"]');
    if (h1) {
      const headerMatch = h1.textContent.match(domainPattern);
      if (headerMatch) return headerMatch[1].toLowerCase();
    }
  }

  return null;
}

/**
 * Common domain regex pattern.
 */
const DOMAIN_PATTERN = /([a-z0-9][a-z0-9-]*\.[a-z]{2,})/i;

/**
 * Common TLD list for scanning.
 */
const COMMON_TLDS = 'com|org|net|ai|co|io|dev|info|online';
