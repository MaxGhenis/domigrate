// Domain Migrator - Shared Utilities for Content Scripts
// Common functions used across all registrar content scripts

'use strict';

// Import pure functions (these are loaded via manifest.json before this script)
// STATE_LABELS, MIGRATION_STEPS, getStepIndex, isValidAuthCode, isPromoElement,
// DOMAIN_PATTERN are available globally from lib/pure.js

const STATUS_BAR_ID = 'domain-migrator-status-bar';

function injectStatusBar() {
  if (document.getElementById(STATUS_BAR_ID)) return;

  const bar = document.createElement('div');
  bar.id = STATUS_BAR_ID;
  bar.innerHTML = `
    <style>
      @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap');

      #${STATUS_BAR_ID} {
        position: fixed;
        bottom: 0;
        left: 0;
        right: 0;
        height: 56px;
        background: linear-gradient(180deg, #161b22 0%, #0c1117 100%);
        border-top: 1px solid rgba(139, 148, 158, 0.15);
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 20px;
        font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
        font-size: 13px;
        color: #f0f6fc;
        z-index: 999999;
        box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.4);
        transform: translateY(100%);
        transition: transform 0.3s ease;
      }
      #${STATUS_BAR_ID}.visible {
        transform: translateY(0);
      }
      #${STATUS_BAR_ID} .status-left {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      #${STATUS_BAR_ID} .status-brand {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      #${STATUS_BAR_ID} .status-brand-icon {
        width: 28px;
        height: 28px;
        background: rgba(45, 212, 191, 0.12);
        border-radius: 6px;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
      }
      #${STATUS_BAR_ID} .status-domain {
        font-family: 'IBM Plex Mono', monospace;
        font-size: 13px;
        font-weight: 600;
        color: #f0f6fc;
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #${STATUS_BAR_ID} .status-divider {
        width: 1px;
        height: 24px;
        background: rgba(139, 148, 158, 0.2);
      }
      #${STATUS_BAR_ID} .status-steps {
        display: flex;
        align-items: center;
        gap: 4px;
      }
      #${STATUS_BAR_ID} .step {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        border-radius: 4px;
        font-size: 11px;
        font-weight: 500;
        transition: all 0.2s ease;
      }
      #${STATUS_BAR_ID} .step.completed {
        color: #2dd4bf;
      }
      #${STATUS_BAR_ID} .step.completed .step-icon {
        color: #2dd4bf;
      }
      #${STATUS_BAR_ID} .step.current {
        background: rgba(251, 191, 36, 0.15);
        color: #fbbf24;
      }
      #${STATUS_BAR_ID} .step.current .step-icon {
        animation: dm-spin 1s linear infinite;
      }
      #${STATUS_BAR_ID} .step.pending {
        color: #484f58;
      }
      #${STATUS_BAR_ID} .step-icon {
        font-size: 10px;
      }
      #${STATUS_BAR_ID} .step-connector {
        color: #484f58;
        font-size: 9px;
        margin: 0 2px;
      }
      #${STATUS_BAR_ID} .status-right {
        display: flex;
        align-items: center;
        gap: 10px;
      }
      #${STATUS_BAR_ID} .status-progress {
        background: rgba(45, 212, 191, 0.12);
        color: #2dd4bf;
        padding: 4px 10px;
        border-radius: 12px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        font-weight: 500;
        letter-spacing: 0.03em;
      }
      #${STATUS_BAR_ID} .status-btn {
        background: #21262d;
        border: 1px solid rgba(139, 148, 158, 0.15);
        color: #8b949e;
        padding: 6px 10px;
        border-radius: 6px;
        font-family: 'IBM Plex Mono', monospace;
        font-size: 10px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s ease;
        display: flex;
        align-items: center;
        gap: 4px;
      }
      #${STATUS_BAR_ID} .status-btn:hover {
        background: #30363d;
        color: #f0f6fc;
      }
      #${STATUS_BAR_ID} .status-btn.pause {
        background: rgba(251, 191, 36, 0.12);
        border-color: transparent;
        color: #fbbf24;
      }
      #${STATUS_BAR_ID} .status-btn.pause:hover {
        background: #fbbf24;
        color: #0c1117;
      }
      #${STATUS_BAR_ID} .status-btn.stop {
        background: rgba(248, 113, 113, 0.12);
        border-color: transparent;
        color: #f87171;
      }
      #${STATUS_BAR_ID} .status-btn.stop:hover {
        background: #f87171;
        color: white;
      }
      #${STATUS_BAR_ID}.paused .step.current {
        animation: dm-pulse-paused 1.5s ease-in-out infinite;
      }
      #${STATUS_BAR_ID}.waiting-2fa .step.current {
        background: rgba(251, 146, 36, 0.2);
      }
      @keyframes dm-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      @keyframes dm-pulse-paused {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
      }
    </style>
    <div class="status-left">
      <div class="status-brand">
        <div class="status-brand-icon">⇄</div>
        <div class="status-domain" id="dm-status-domain">...</div>
      </div>
      <div class="status-divider"></div>
      <div class="status-steps" id="dm-status-steps">
        <!-- Steps will be injected here -->
      </div>
    </div>
    <div class="status-right">
      <div class="status-progress" id="dm-status-progress">0 / 0</div>
      <button class="status-btn pause" id="dm-btn-pause">⏸ Pause</button>
      <button class="status-btn stop" id="dm-btn-stop">⏹ Stop</button>
    </div>
  `;

  document.body.appendChild(bar);

  // Set up button handlers
  document.getElementById('dm-btn-pause').addEventListener('click', async () => {
    console.log('Domain Migrator: Pause button clicked');
    try {
      const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
      const action = status.isPaused ? 'resumeMigration' : 'pauseMigration';
      console.log(`Domain Migrator: Sending ${action}`);
      await chrome.runtime.sendMessage({ action });
      // Refresh status bar after action
      const [newStatus, domains] = await Promise.all([
        chrome.runtime.sendMessage({ action: 'getStatus' }),
        chrome.runtime.sendMessage({ action: 'getDomains' })
      ]);
      updateStatusBar(newStatus, domains);
    } catch (e) {
      console.error('Domain Migrator: Pause error:', e);
    }
  });

  document.getElementById('dm-btn-stop').addEventListener('click', async () => {
    console.log('Domain Migrator: Stop button clicked');
    try {
      await chrome.runtime.sendMessage({ action: 'stopMigration' });
      hideStatusBar();
    } catch (e) {
      console.error('Domain Migrator: Stop error:', e);
    }
  });
}

function updateStatusBar(status, domains) {
  const bar = document.getElementById(STATUS_BAR_ID);
  if (!bar) return;

  const domainEl = document.getElementById('dm-status-domain');
  const stepsEl = document.getElementById('dm-status-steps');
  const progressEl = document.getElementById('dm-status-progress');
  const pauseBtn = document.getElementById('dm-btn-pause');

  // Show/hide bar based on running state
  if (status.isRunning) {
    bar.classList.add('visible');
  } else {
    bar.classList.remove('visible');
    return;
  }

  // Update domain
  domainEl.textContent = status.currentDomain || '...';

  // Render steps
  const currentIdx = getStepIndex(status.currentState);
  const stepsHtml = MIGRATION_STEPS.map((step, idx) => {
    let stepClass = 'pending';
    let icon = '○';

    if (idx < currentIdx) {
      stepClass = 'completed';
      icon = '✓';
    } else if (idx === currentIdx) {
      stepClass = 'current';
      icon = '◐';
    }

    const connector = idx < MIGRATION_STEPS.length - 1 ? '<span class="step-connector">→</span>' : '';

    return `<span class="step ${stepClass}"><span class="step-icon">${icon}</span>${step.label}</span>${connector}`;
  }).join('');

  stepsEl.innerHTML = stepsHtml;

  // Calculate progress (domains completed)
  const total = Object.keys(domains).length;
  const completed = Object.values(domains).filter(d =>
    d.state === 'complete' || d.state === 'error'
  ).length;
  progressEl.textContent = `${completed + 1} / ${total}`;

  // Update pause button
  pauseBtn.innerHTML = status.isPaused ? '▶ Resume' : '⏸ Pause';

  // Add state classes
  bar.classList.toggle('paused', status.isPaused);
  bar.classList.toggle('waiting-2fa', status.currentState === 'waiting_for_2fa');
}

function hideStatusBar() {
  const bar = document.getElementById(STATUS_BAR_ID);
  if (bar) {
    bar.classList.remove('visible');
  }
}

// Listen for status updates from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'statusUpdate') {
    injectStatusBar();
    // Fetch full status and domains to update bar
    Promise.all([
      chrome.runtime.sendMessage({ action: 'getStatus' }),
      chrome.runtime.sendMessage({ action: 'getDomains' })
    ]).then(([status, domains]) => {
      updateStatusBar(status, domains);
    });
  }
  if (message.action === 'hideStatusBar') {
    hideStatusBar();
  }
});

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
 * More aggressive search that works with GoDaddy's modal.
 * @returns {HTMLInputElement[]}
 */
function findNameserverInputs() {
  // First try: look for inputs with nameserver-related attributes
  const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
  let inputs = Array.from(allInputs).filter(input => {
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

  // Second try: look for inputs inside a modal that's visible
  if (inputs.length < 2) {
    const modal = document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="Modal"], [class*="dialog"]');
    if (modal) {
      const modalInputs = modal.querySelectorAll('input[type="text"], input:not([type])');
      // Filter to visible inputs that look like they could be nameserver fields
      inputs = Array.from(modalInputs).filter(input => {
        const rect = input.getBoundingClientRect();
        // Check it's visible and has reasonable dimensions for a nameserver input
        return rect.width > 100 && rect.height > 20 && !input.disabled;
      });
      console.log(`Domain Migrator: Found ${inputs.length} inputs in modal`);
    }
  }

  // Third try: look for any visible text inputs near "nameserver" text
  if (inputs.length < 2) {
    const pageText = document.body.innerText.toLowerCase();
    if (pageText.includes('nameserver')) {
      // Find all text inputs and filter by visibility
      inputs = Array.from(allInputs).filter(input => {
        const rect = input.getBoundingClientRect();
        return rect.width > 100 && rect.height > 20 && !input.disabled &&
               window.getComputedStyle(input).display !== 'none';
      });
      console.log(`Domain Migrator: Found ${inputs.length} visible text inputs`);
    }
  }

  return inputs;
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
 * Uses React-compatible input setting.
 * @param {HTMLInputElement[]} inputs - Input elements
 * @param {string[]} nameservers - Nameserver values to fill
 */
async function fillNameserverInputs(inputs, nameservers) {
  for (let i = 0; i < nameservers.length; i++) {
    if (inputs[i]) {
      console.log(`Domain Migrator: Filling input ${i} with ${nameservers[i]}`);
      await setInputValue(inputs[i], nameservers[i]);
      await wait(500);
    }
  }
}

/**
 * Sets input value in a way that works with React and other frameworks.
 * @param {HTMLInputElement} input - Input element
 * @param {string} value - Value to set
 */
async function setInputValue(input, value) {
  input.focus();

  // Clear the input first
  input.select();
  document.execCommand('delete');

  // Try using the native value setter (works better with React)
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(input, value);

  // Dispatch events that React listens to
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

  // Also dispatch React's synthetic event
  const inputEvent = new InputEvent('input', {
    bubbles: true,
    cancelable: true,
    inputType: 'insertText',
    data: value
  });
  input.dispatchEvent(inputEvent);

  // Blur to trigger validation
  input.blur();
  await wait(100);

  // Verify the value was set
  if (input.value !== value) {
    console.warn(`Domain Migrator: Input value mismatch! Expected "${value}", got "${input.value}"`);
    // Try one more time with direct assignment
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  console.log(`Domain Migrator: Input value is now "${input.value}"`);
}

/**
 * Fills a text input and dispatches change events.
 * @param {HTMLInputElement} input - Input element
 * @param {string} value - Value to set
 */
function fillInput(input, value) {
  input.focus();

  // Use native value setter for React compatibility
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(input, value);

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
 * Initializes a content script with standard setup.
 * @param {Object} config - Configuration object
 * @param {string} config.registrar - Registrar identifier
 * @param {Object} config.waitOptions - Options for waitForPageReady
 * @param {Function} config.extractDomain - Function to extract domain from URL
 * @param {Function} config.detectPageType - Function to detect page type
 * @param {Function} config.executeAction - Function to execute actions
 * @param {Function} config.getExtraData - Optional function to get extra data for pageReady
 * @returns {Function} The init function to call
 */
function createContentScriptInit(config) {
  const { registrar, waitOptions = {}, extractDomain, detectPageType, executeAction, getExtraData } = config;

  async function init() {
    await waitForPageReady(waitOptions);
    const currentDomain = extractDomain();
    const pageType = detectPageType();

    // Show status bar if migration is running
    try {
      const [status, domains] = await Promise.all([
        chrome.runtime.sendMessage({ action: 'getStatus' }),
        chrome.runtime.sendMessage({ action: 'getDomains' })
      ]);
      if (status?.isRunning) {
        injectStatusBar();
        updateStatusBar(status, domains);
      }
    } catch (e) {
      // Ignore - migration may not be running
    }

    const extraData = getExtraData ? getExtraData() : {};

    const response = await chrome.runtime.sendMessage({
      action: 'pageReady',
      data: {
        registrar,
        pageType,
        domain: currentDomain,
        url: window.location.href,
        ...extraData
      }
    });

    if (response?.action && response.action !== 'none') {
      await executeAction(response.action, response);
    }

    watchForNavigation(init);
    setupMessageListener(executeAction);
  }

  return init;
}

/**
 * Scans page for domain names and reports them to the background script.
 * Only uses link-based detection to avoid picking up ads/promos.
 * @param {string} registrar - Registrar identifier
 * @param {string[]} linkSelectors - CSS selectors for domain links
 * @param {RegExp} hrefPattern - Pattern to extract domain from href
 */
async function scanForDomainsAndReport(registrar, linkSelectors, hrefPattern) {
  const domains = [];
  const domainElements = document.querySelectorAll(linkSelectors.join(', '));

  for (const el of domainElements) {
    const elementText = el.textContent?.toLowerCase() || '';
    const parent = el.closest('tr, li, div, section, [class*="row"], [class*="item"], [class*="card"]');
    const parentText = parent?.textContent?.toLowerCase() || '';
    const combinedText = `${elementText} ${parentText}`;

    if (isPromoElement(combinedText)) {
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

  const uniqueDomains = [...new Set(domains)];

  await chrome.runtime.sendMessage({
    action: 'domainsFound',
    data: { domains: uniqueDomains, registrar }
  });
}
