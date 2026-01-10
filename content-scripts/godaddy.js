// Domain Migrator - GoDaddy Content Script
// Auto-detects page context and performs migration actions

(function() {
  'use strict';

  const REGISTRAR = 'godaddy';
  let currentDomain = null;

  console.log('Domain Migrator: GoDaddy script loaded');

  // Initialize on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    await waitForPageReady();
    currentDomain = extractDomainFromUrl();
    const pageType = detectPageType();

    console.log(`GoDaddy page: ${pageType}, domain: ${currentDomain || 'none'}`);

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
    const params = new URLSearchParams(url.search);
    const paramDomain = params.get('domainName');
    if (paramDomain) return paramDomain;

    const pathParts = url.pathname.split('/').filter(Boolean);
    for (const part of pathParts) {
      if (part.match(DOMAIN_PATTERN)) {
        return part;
      }
    }

    return extractDomainFromPage(DOMAIN_PATTERN);
  }

  function detectPageType() {
    const url = window.location.href;
    const path = window.location.pathname;

    if (url.includes('portfolio') && !path.includes('.')) return 'portfolio_list';
    if (url.includes('/settings') || url.includes('settings')) return 'domain_settings';
    if (url.includes('dnsmanagement') || url.includes('dns')) return 'dns_management';
    if (url.includes('subtab=nameservers')) return 'nameservers';
    if (path.match(/\/portfolio\/[^\/]+$/)) return 'domain_overview';

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
    console.log('Scanning for domains...');

    const domains = [];
    const domainElements = document.querySelectorAll(
      'a[href*="/portfolio/"], [data-testid*="domain"], .domain-item, .domain-name'
    );

    for (const el of domainElements) {
      const href = el.getAttribute('href') || '';
      const text = el.textContent || '';

      const hrefMatch = href.match(/\/portfolio\/([a-z0-9-]+\.[a-z]{2,})/i);
      if (hrefMatch) {
        domains.push(hrefMatch[1]);
        continue;
      }

      const textMatch = text.match(/^([a-z0-9-]+\.[a-z]{2,})$/i);
      if (textMatch) {
        domains.push(textMatch[1]);
      }
    }

    const pageText = document.body.innerText;
    const textMatches = pageText.match(new RegExp(`\\b([a-z0-9-]+\\.(${COMMON_TLDS}))\\b`, 'gi'));
    if (textMatches) {
      domains.push(...textMatches);
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
    if (pageType !== 'domain_settings' && pageType !== 'domain_overview') {
      console.log('Navigating to domain settings...');
      window.location.href = `https://dcc.godaddy.com/control/portfolio/${domain}/settings`;
      return;
    }

    let authCode = findAuthCodeOnPage();

    if (!authCode) {
      const authButton = findButton([
        'get authorization code', 'get auth code', 'authorization code', 'transfer', 'auth code'
      ]);

      if (authButton) {
        console.log('Clicking auth code button...');
        authButton.click();
        await wait(3000);
        authCode = findAuthCodeOnPage();
      }
    }

    if (authCode) {
      console.log(`Found auth code: ${authCode.substring(0, 4)}...`);
      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: { action: 'extractAuthCode', domain, authCode, registrar: REGISTRAR }
      });
    } else if (document.body.innerText.toLowerCase().includes('domain is locked')) {
      await reportError(domain, 'Domain is locked - unlock it first', REGISTRAR);
    } else {
      await reportError(domain, 'Could not find auth code - may need manual extraction', REGISTRAR);
    }
  }

  function findAuthCodeOnPage() {
    const containers = document.querySelectorAll(
      '[data-testid*="auth"], [data-testid*="code"], .auth-code, .authorization-code, input[readonly], .code-display'
    );

    for (const container of containers) {
      const text = (container.value || container.textContent || '').trim();
      if (isValidAuthCode(text)) return text;
    }

    const modals = document.querySelectorAll('.modal, [role="dialog"], .popup');
    for (const modal of modals) {
      const codeMatch = modal.innerText.match(/(?:code|authorization)[:\s]+([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/i);
      if (codeMatch) return codeMatch[1];
    }

    const bodyText = document.body.innerText;
    const nearAuth = bodyText.match(/authorization[^a-z]*code[^a-z]*([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/i);
    if (nearAuth) return nearAuth[1];

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
    if (pageType !== 'nameservers' && pageType !== 'dns_management') {
      console.log('Navigating to nameservers page...');
      window.location.href = `https://dcc.godaddy.com/control/dnsmanagement?domainName=${domain}&subtab=nameservers`;
      return;
    }

    const changeButton = findButton([
      'change nameservers', 'change', 'edit nameservers', 'edit', "i'll use my own nameservers"
    ]);

    if (changeButton) {
      console.log('Clicking change button...');
      changeButton.click();
      await wait(2000);
    }

    const inputs = findNameserverInputs();

    if (inputs.length >= newNameservers.length) {
      console.log(`Found ${inputs.length} nameserver inputs, filling...`);
      await fillNameserverInputs(inputs, newNameservers);
      await wait(1000);

      const saveButton = findButton(['save', 'confirm', 'update', 'apply']);

      if (saveButton) {
        console.log('Clicking save button...');
        saveButton.click();
        await wait(3000);

        const pageText = document.body.innerText.toLowerCase();
        if (pageText.includes('success') || pageText.includes('updated') || pageText.includes('saved')) {
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
