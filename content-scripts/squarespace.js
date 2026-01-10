// Domain Migrator - Squarespace Autonomous Content Script
// Auto-detects page context and performs migration actions

(function() {
  'use strict';

  const REGISTRAR = 'squarespace';

  console.log('Domain Migrator: Squarespace autonomous script loaded');

  // State
  let currentDomain = null;

  // Initialize on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    // Wait for page to stabilize
    await waitForPageReady();

    // Extract domain from current page
    currentDomain = extractDomainFromUrl();

    // Detect page type
    const pageType = detectPageType();

    console.log(`Squarespace page: ${pageType}, domain: ${currentDomain || 'none'}`);

    // Notify background script that page is ready
    const response = await chrome.runtime.sendMessage({
      action: 'pageReady',
      data: {
        registrar: REGISTRAR,
        pageType,
        domain: currentDomain,
        url: window.location.href
      }
    });

    // If orchestrator gives us an action, execute it
    if (response?.action && response.action !== 'none') {
      console.log(`Received action: ${response.action}`);
      await executeAction(response.action, response);
    }

    // Watch for SPA navigation
    watchForNavigation();
  }

  function waitForPageReady() {
    return new Promise(resolve => {
      const checkReady = () => {
        const hasContent = document.body?.textContent?.length > 300;
        const notLoading = !document.querySelector('.loading, .spinner, [class*="loading"], [class*="spinner"]');
        if (hasContent && notLoading) {
          resolve();
        } else {
          setTimeout(checkReady, 500);
        }
      };
      setTimeout(checkReady, 1000);
    });
  }

  function extractDomainFromUrl() {
    const url = new URL(window.location.href);
    const path = url.pathname;

    // Squarespace URL patterns:
    // /domains/managed/{domain}/dns-settings
    // /domains/managed/{domain}
    // /domains/{domain}

    const pathMatch = path.match(/\/domains?(?:\/managed)?\/([a-z0-9-]+\.[a-z]{2,})/i);
    if (pathMatch) return pathMatch[1].toLowerCase();

    // Check query parameters
    const params = new URLSearchParams(url.search);
    const domainParam = params.get('domain');
    if (domainParam) return domainParam.toLowerCase();

    // Check page title
    const titleMatch = document.title.match(/([a-z0-9-]+\.[a-z]{2,})/i);
    if (titleMatch) return titleMatch[1].toLowerCase();

    // Look for domain in h1 or header
    const h1 = document.querySelector('h1, [class*="domain-name"], [class*="DomainName"]');
    if (h1) {
      const headerMatch = h1.textContent.match(/([a-z0-9-]+\.[a-z]{2,})/i);
      if (headerMatch) return headerMatch[1].toLowerCase();
    }

    return null;
  }

  function detectPageType() {
    const path = window.location.pathname;
    const url = window.location.href;

    if (path.includes('/domains/managed') && !path.match(/\/[a-z0-9-]+\.[a-z]/i)) {
      return 'portfolio_list';
    }
    if (path.includes('/dns-settings') || path.includes('/dns')) {
      return 'dns_settings';
    }
    if (path.includes('/transfer')) {
      return 'transfer_settings';
    }
    if (path.match(/\/domains(?:\/managed)?\/[a-z0-9-]+\.[a-z]/i)) {
      return 'domain_overview';
    }

    return 'unknown';
  }

  // ============ ACTION EXECUTOR ============

  async function executeAction(action, data) {
    try {
      switch (action) {
        case 'scanForDomains':
          await scanForDomains();
          break;
        case 'extractAuthCode':
          await extractAuthCode(data.domain);
          break;
        case 'updateNameservers':
          await updateNameservers(data.domain, data.nameservers);
          break;
        default:
          console.warn(`Unknown action: ${action}`);
          await reportError(data.domain, `Unknown action: ${action}`);
      }
    } catch (error) {
      console.error(`Action ${action} failed:`, error);
      await reportError(data.domain, error.message);
    }
  }

  // ============ AUTONOMOUS ACTIONS ============

  async function scanForDomains() {
    console.log('Scanning for domains on Squarespace...');

    const domains = [];

    // Find domain cards/links on the domains list page
    const domainElements = document.querySelectorAll(
      'a[href*="/domains/"], [class*="domain-card"], [class*="DomainCard"], [class*="domain-name"], [class*="DomainName"]'
    );

    for (const el of domainElements) {
      const href = el.getAttribute('href') || '';
      const text = el.textContent || '';

      // Extract domain from href
      const hrefMatch = href.match(/\/domains?(?:\/managed)?\/([a-z0-9-]+\.[a-z]{2,})/i);
      if (hrefMatch) {
        domains.push(hrefMatch[1].toLowerCase());
        continue;
      }

      // Extract domain from text
      const textMatch = text.match(/([a-z0-9-]+\.[a-z]{2,})/i);
      if (textMatch && !textMatch[1].includes('/')) {
        domains.push(textMatch[1].toLowerCase());
      }
    }

    // Also scan page text for domain patterns
    const pageText = document.body.innerText;
    const textMatches = pageText.match(/\b([a-z0-9-]+\.(com|org|net|ai|co|io|dev|info|online))\b/gi);
    if (textMatches) {
      domains.push(...textMatches.map(d => d.toLowerCase()));
    }

    const uniqueDomains = [...new Set(domains)];
    console.log(`Found ${uniqueDomains.length} domains:`, uniqueDomains);

    await chrome.runtime.sendMessage({
      action: 'domainsFound',
      data: {
        domains: uniqueDomains,
        registrar: REGISTRAR
      }
    });
  }

  async function extractAuthCode(domain) {
    console.log(`Extracting auth code for ${domain}...`);

    const pageType = detectPageType();

    // Navigate to DNS settings or transfer page if not already there
    if (pageType !== 'dns_settings' && pageType !== 'transfer_settings') {
      console.log('   Navigating to domain settings...');
      window.location.href = `https://account.squarespace.com/domains/managed/${domain}/dns-settings`;
      return;
    }

    // First check for existing auth code display
    let authCode = findAuthCodeOnPage();

    if (!authCode) {
      // Look for "Get Transfer Code" or "Authorization Code" button
      const authButton = findButton([
        'get transfer code',
        'get authorization code',
        'authorization code',
        'transfer code',
        'get code',
        'unlock',
        'prepare for transfer'
      ]);

      if (authButton) {
        console.log('   Clicking auth code button...');
        authButton.click();
        await wait(3000);

        authCode = findAuthCodeOnPage();
      }
    }

    if (!authCode) {
      // Look for an "expand" or "show" button that might reveal the code
      const expandButtons = document.querySelectorAll('button, [role="button"]');
      for (const btn of expandButtons) {
        const text = btn.textContent?.toLowerCase() || '';
        if (text.includes('show') || text.includes('reveal') || text.includes('view')) {
          btn.click();
          await wait(1500);
          authCode = findAuthCodeOnPage();
          if (authCode) break;
        }
      }
    }

    if (authCode) {
      console.log(`   Found auth code: ${authCode.substring(0, 4)}...`);
      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: {
          action: 'extractAuthCode',
          domain,
          authCode,
          registrar: REGISTRAR
        }
      });
    } else {
      // Check if domain is locked
      const bodyText = document.body.innerText.toLowerCase();
      if (bodyText.includes('locked') || bodyText.includes('lock enabled')) {
        await reportError(domain, 'Domain is locked - unlock it first in Squarespace');
      } else {
        await reportError(domain, 'Could not find auth code - check transfer settings manually');
      }
    }
  }

  function findAuthCodeOnPage() {
    // Method 1: Look for code in input fields
    const inputs = document.querySelectorAll('input[readonly], input[type="text"], input[value]');
    for (const input of inputs) {
      const value = (input.value || '').trim();
      // Auth codes are typically 8-30 characters with letters and numbers
      if (value.length >= 8 && value.length <= 30 && !value.includes(' ') && value.match(/[A-Za-z]/) && value.match(/[0-9]/)) {
        return value;
      }
    }

    // Method 2: Look for code containers
    const codeContainers = document.querySelectorAll(
      '[class*="auth"], [class*="Auth"], [class*="code"], [class*="Code"], [class*="transfer"], [class*="Transfer"]'
    );
    for (const container of codeContainers) {
      const text = container.innerText;
      const codeMatch = text.match(/([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/);
      if (codeMatch && !codeMatch[1].match(/^(example|domain|enter|your)/i)) {
        return codeMatch[1];
      }
    }

    // Method 3: Look in modal dialogs
    const modals = document.querySelectorAll('[class*="modal"], [class*="Modal"], [role="dialog"], [class*="overlay"]');
    for (const modal of modals) {
      const style = window.getComputedStyle(modal);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const modalText = modal.innerText;
      const codeMatch = modalText.match(/(?:code|authorization)[:\s]+([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/i);
      if (codeMatch) return codeMatch[1];
    }

    // Method 4: Look for any code near "transfer" or "authorization" keywords
    const bodyText = document.body.innerText;
    const nearTransfer = bodyText.match(/(?:transfer|authorization)\s*(?:code)?[:\s]+([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/i);
    if (nearTransfer) return nearTransfer[1];

    return null;
  }

  async function updateNameservers(domain, newNameservers) {
    console.log(`Updating nameservers for ${domain} to:`, newNameservers);

    if (!newNameservers || newNameservers.length < 2) {
      await reportError(domain, 'Need at least 2 nameservers');
      return;
    }

    const pageType = detectPageType();

    // Navigate to DNS settings if not already there
    if (pageType !== 'dns_settings') {
      console.log('   Navigating to DNS settings...');
      window.location.href = `https://account.squarespace.com/domains/managed/${domain}/dns-settings`;
      return;
    }

    // Look for "Edit" or "Change Nameservers" button
    const editButton = findButton([
      'edit nameservers',
      'change nameservers',
      'edit',
      'custom nameservers',
      'use custom',
      'manage nameservers'
    ]);

    if (editButton) {
      console.log('   Clicking edit button...');
      editButton.click();
      await wait(2000);
    }

    // Find nameserver input fields
    const inputs = findNameserverInputs();

    if (inputs.length >= newNameservers.length) {
      console.log(`   Found ${inputs.length} nameserver inputs, filling...`);

      for (let i = 0; i < newNameservers.length; i++) {
        if (inputs[i]) {
          inputs[i].focus();
          inputs[i].value = '';
          inputs[i].value = newNameservers[i];
          inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
          inputs[i].dispatchEvent(new Event('change', { bubbles: true }));
          await wait(300);
        }
      }

      await wait(1000);

      // Look for Save button
      const saveButton = findButton(['save', 'confirm', 'update', 'apply', 'done']);

      if (saveButton) {
        console.log('   Clicking save button...');
        saveButton.click();
        await wait(3000);

        // Verify success
        const pageText = document.body.innerText.toLowerCase();
        if (pageText.includes('success') || pageText.includes('updated') || pageText.includes('saved') || pageText.includes('changes applied')) {
          console.log('   Nameservers updated successfully');
          await chrome.runtime.sendMessage({
            action: 'actionComplete',
            data: {
              action: 'updateNameservers',
              domain,
              registrar: REGISTRAR
            }
          });
        } else {
          await reportError(domain, 'Nameserver update may have failed - please verify');
        }
      } else {
        await reportError(domain, 'Could not find save button');
      }
    } else {
      await reportError(domain, `Only found ${inputs.length} nameserver inputs, need ${newNameservers.length}`);
    }
  }

  function findNameserverInputs() {
    const allInputs = document.querySelectorAll('input[type="text"], input:not([type])');
    return Array.from(allInputs).filter(input => {
      const placeholder = (input.placeholder || '').toLowerCase();
      const name = (input.name || '').toLowerCase();
      const id = (input.id || '').toLowerCase();
      const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
      const nearbyText = input.closest('label')?.textContent?.toLowerCase() ||
                         input.closest('div')?.textContent?.toLowerCase().substring(0, 100) || '';

      return placeholder.includes('nameserver') ||
             placeholder.includes('ns') ||
             name.includes('nameserver') ||
             name.includes('ns') ||
             id.includes('nameserver') ||
             id.includes('ns') ||
             ariaLabel.includes('nameserver') ||
             nearbyText.includes('nameserver');
    });
  }

  // ============ UTILITIES ============

  function findButton(textPatterns) {
    const buttons = document.querySelectorAll('button, a, [role="button"], input[type="submit"], [class*="Button"]');

    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || btn.value?.toLowerCase() || '';
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();

      if (textPatterns.some(pattern => text.includes(pattern) || ariaLabel.includes(pattern))) {
        // Make sure it's visible
        const rect = btn.getBoundingClientRect();
        const style = window.getComputedStyle(btn);
        if (rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden') {
          return btn;
        }
      }
    }
    return null;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function reportError(domain, error) {
    console.error(`Error for ${domain}: ${error}`);
    await chrome.runtime.sendMessage({
      action: 'actionError',
      data: { domain, error, registrar: REGISTRAR }
    });
  }

  function watchForNavigation() {
    let lastUrl = location.href;
    new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        console.log('Navigation detected, reinitializing...');
        setTimeout(init, 1500);
      }
    }).observe(document.body, { subtree: true, childList: true });
  }

  // Listen for messages from background
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
})();
