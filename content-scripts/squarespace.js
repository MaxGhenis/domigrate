// Domain Migrator - Squarespace Content Script
// Auto-detects page context and performs migration actions

(function() {
  'use strict';

  const REGISTRAR = 'squarespace';
  let currentDomain = null;

  console.log('Domain Migrator: Squarespace script loaded');

  // Initialize on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    await waitForPageReady({ minContentLength: 300 });
    currentDomain = extractDomainFromUrl();
    const pageType = detectPageType();

    console.log(`Squarespace page: ${pageType}, domain: ${currentDomain || 'none'}`);

    const response = await chrome.runtime.sendMessage({
      action: 'pageReady',
      data: {
        registrar: REGISTRAR,
        pageType,
        domain: currentDomain,
        url: window.location.href
      }
    });

    if (response?.action && response.action !== 'none') {
      console.log(`Received action: ${response.action}`);
      await executeAction(response.action, response);
    }

    watchForNavigation(init);
    setupMessageListener(executeAction);
  }

  function extractDomainFromUrl() {
    const url = new URL(window.location.href);
    const path = url.pathname;

    // Squarespace URL patterns: /domains/managed/{domain}/dns-settings
    const pathMatch = path.match(/\/domains?(?:\/managed)?\/([a-z0-9-]+\.[a-z]{2,})/i);
    if (pathMatch) return pathMatch[1].toLowerCase();

    // Check query parameters
    const domainParam = url.searchParams.get('domain');
    if (domainParam) return domainParam.toLowerCase();

    return extractDomainFromPage(DOMAIN_PATTERN);
  }

  function detectPageType() {
    const path = window.location.pathname;

    if (path.includes('/domains/managed') && !path.match(/\/[a-z0-9-]+\.[a-z]/i)) {
      return 'portfolio_list';
    }
    if (path.includes('/dns-settings') || path.includes('/dns')) return 'dns_settings';
    if (path.includes('/transfer')) return 'transfer_settings';
    if (path.match(/\/domains(?:\/managed)?\/[a-z0-9-]+\.[a-z]/i)) return 'domain_overview';

    return 'unknown';
  }

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
          await reportError(data.domain, `Unknown action: ${action}`, REGISTRAR);
      }
    } catch (error) {
      console.error(`Action ${action} failed:`, error);
      await reportError(data.domain, error.message, REGISTRAR);
    }
  }

  async function scanForDomains() {
    console.log('Scanning for domains on Squarespace...');

    const domains = [];
    const domainElements = document.querySelectorAll(
      'a[href*="/domains/"], [class*="domain-card"], [class*="DomainCard"], [class*="domain-name"], [class*="DomainName"]'
    );

    for (const el of domainElements) {
      const href = el.getAttribute('href') || '';
      const text = el.textContent || '';

      const hrefMatch = href.match(/\/domains?(?:\/managed)?\/([a-z0-9-]+\.[a-z]{2,})/i);
      if (hrefMatch) {
        domains.push(hrefMatch[1].toLowerCase());
        continue;
      }

      const textMatch = text.match(/([a-z0-9-]+\.[a-z]{2,})/i);
      if (textMatch && !textMatch[1].includes('/')) {
        domains.push(textMatch[1].toLowerCase());
      }
    }

    const pageText = document.body.innerText;
    const textMatches = pageText.match(new RegExp(`\\b([a-z0-9-]+\\.(${COMMON_TLDS}))\\b`, 'gi'));
    if (textMatches) {
      domains.push(...textMatches.map(d => d.toLowerCase()));
    }

    const uniqueDomains = [...new Set(domains)];
    console.log(`Found ${uniqueDomains.length} domains:`, uniqueDomains);

    await chrome.runtime.sendMessage({
      action: 'domainsFound',
      data: { domains: uniqueDomains, registrar: REGISTRAR }
    });
  }

  async function extractAuthCode(domain) {
    console.log(`Extracting auth code for ${domain}...`);

    const pageType = detectPageType();
    if (pageType !== 'dns_settings' && pageType !== 'transfer_settings') {
      console.log('Navigating to domain settings...');
      window.location.href = `https://account.squarespace.com/domains/managed/${domain}/dns-settings`;
      return;
    }

    let authCode = findAuthCodeOnPage();

    if (!authCode) {
      const authButton = findButton([
        'get transfer code', 'get authorization code', 'authorization code',
        'transfer code', 'get code', 'unlock', 'prepare for transfer'
      ], { checkAriaLabel: true });

      if (authButton) {
        console.log('Clicking auth code button...');
        authButton.click();
        await wait(3000);
        authCode = findAuthCodeOnPage();
      }
    }

    if (!authCode) {
      // Look for show/reveal buttons
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
      console.log(`Found auth code: ${authCode.substring(0, 4)}...`);
      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: { action: 'extractAuthCode', domain, authCode, registrar: REGISTRAR }
      });
    } else {
      const bodyText = document.body.innerText.toLowerCase();
      if (bodyText.includes('locked') || bodyText.includes('lock enabled')) {
        await reportError(domain, 'Domain is locked - unlock it first in Squarespace', REGISTRAR);
      } else {
        await reportError(domain, 'Could not find auth code - check transfer settings manually', REGISTRAR);
      }
    }
  }

  function findAuthCodeOnPage() {
    // Check input fields
    const inputs = document.querySelectorAll('input[readonly], input[type="text"], input[value]');
    for (const input of inputs) {
      const value = (input.value || '').trim();
      if (isValidAuthCode(value)) return value;
    }

    // Check code containers
    const codeContainers = document.querySelectorAll(
      '[class*="auth"], [class*="Auth"], [class*="code"], [class*="Code"], [class*="transfer"], [class*="Transfer"]'
    );
    for (const container of codeContainers) {
      const codeMatch = container.innerText.match(/([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/);
      if (codeMatch && !codeMatch[1].match(/^(example|domain|enter|your)/i)) {
        return codeMatch[1];
      }
    }

    // Check visible modals
    const modals = document.querySelectorAll('[class*="modal"], [class*="Modal"], [role="dialog"], [class*="overlay"]');
    for (const modal of modals) {
      const style = window.getComputedStyle(modal);
      if (style.display === 'none' || style.visibility === 'hidden') continue;

      const codeMatch = modal.innerText.match(/(?:code|authorization)[:\s]+([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/i);
      if (codeMatch) return codeMatch[1];
    }

    // Check body text near transfer keywords
    const nearTransfer = document.body.innerText.match(
      /(?:transfer|authorization)\s*(?:code)?[:\s]+([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/i
    );
    if (nearTransfer) return nearTransfer[1];

    return null;
  }

  function isValidAuthCode(text) {
    return text.length >= 8 && text.length <= 30 &&
           !text.includes(' ') && text.match(/[A-Za-z]/) && text.match(/[0-9]/);
  }

  async function updateNameservers(domain, newNameservers) {
    console.log(`Updating nameservers for ${domain} to:`, newNameservers);

    if (!newNameservers || newNameservers.length < 2) {
      await reportError(domain, 'Need at least 2 nameservers', REGISTRAR);
      return;
    }

    const pageType = detectPageType();
    if (pageType !== 'dns_settings') {
      console.log('Navigating to DNS settings...');
      window.location.href = `https://account.squarespace.com/domains/managed/${domain}/dns-settings`;
      return;
    }

    const editButton = findButton([
      'edit nameservers', 'change nameservers', 'edit',
      'custom nameservers', 'use custom', 'manage nameservers'
    ], { checkAriaLabel: true, checkDisabled: true });

    if (editButton) {
      console.log('Clicking edit button...');
      editButton.click();
      await wait(2000);
    }

    const inputs = findNameserverInputs();

    if (inputs.length >= newNameservers.length) {
      console.log(`Found ${inputs.length} nameserver inputs, filling...`);
      await fillNameserverInputs(inputs, newNameservers);
      await wait(1000);

      const saveButton = findButton(['save', 'confirm', 'update', 'apply', 'done'], { checkDisabled: true });

      if (saveButton) {
        console.log('Clicking save button...');
        saveButton.click();
        await wait(3000);

        const pageText = document.body.innerText.toLowerCase();
        const successTerms = ['success', 'updated', 'saved', 'changes applied'];
        if (successTerms.some(term => pageText.includes(term))) {
          console.log('Nameservers updated successfully');
          await chrome.runtime.sendMessage({
            action: 'actionComplete',
            data: { action: 'updateNameservers', domain, registrar: REGISTRAR }
          });
        } else {
          await reportError(domain, 'Nameserver update may have failed - please verify', REGISTRAR);
        }
      } else {
        await reportError(domain, 'Could not find save button', REGISTRAR);
      }
    } else {
      await reportError(domain, `Only found ${inputs.length} nameserver inputs, need ${newNameservers.length}`, REGISTRAR);
    }
  }
})();
