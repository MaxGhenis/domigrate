// Domain Migrator - Cloudflare Content Script
// Auto-detects page context and performs migration actions

(function() {
  'use strict';

  const REGISTRAR = 'cloudflare';
  let currentDomain = null;
  let accountId = null;

  const init = createContentScriptInit({
    registrar: REGISTRAR,
    waitOptions: { initialDelay: 1500 },
    extractDomain: extractUrlInfo,
    detectPageType,
    executeAction,
    getExtraData: () => ({ accountId })
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function extractUrlInfo() {
    const path = window.location.pathname;

    // Pattern: /accountid/domain.com/...
    const match = path.match(/\/([a-f0-9]{32})\/([a-z0-9][a-z0-9-]*\.[a-z]{2,})/i);
    if (match) {
      accountId = match[1];
      currentDomain = match[2];
      return currentDomain;
    }

    // Just account ID
    const accountMatch = path.match(/\/([a-f0-9]{32})/i);
    if (accountMatch) {
      accountId = accountMatch[1];
    }

    // Try to find domain in page title
    const domainMatch = document.title.match(DOMAIN_PATTERN);
    if (domainMatch && !domainMatch[1].includes('cloudflare')) {
      currentDomain = domainMatch[1];
      return currentDomain;
    }

    return currentDomain;
  }

  function detectPageType() {
    const url = window.location.href;
    const path = window.location.pathname;

    if (url.includes('add-site') || url.includes('to=/:account/add-site')) return 'add_domain';
    if (path.includes('/dns')) return 'domain_dns';
    if (path.match(/\/[a-f0-9]{32}\/[^\/]+$/)) return 'domain_overview';
    if (path.match(/\/[a-f0-9]{32}\/home/) || path.match(/\/[a-f0-9]{32}$/)) return 'account_home';

    return 'unknown';
  }

  async function executeAction(action, data) {
    try {
      switch (action) {
        case 'addDomainToCloudflare':
          await addDomainToCloudflare(data.domain);
          break;
        case 'selectFreePlan':
          await selectFreePlan(data.domain);
          break;
        case 'extractCloudflareNameservers':
          await extractCloudflareNameservers(data.domain);
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

  async function addDomainToCloudflare(domain) {
    const pageType = detectPageType();

    if (pageType !== 'add_domain') {
      window.location.href = 'https://dash.cloudflare.com/?to=/:account/add-site';
      return;
    }

    const input = findDomainInput();
    if (!input) {
      await reportError(domain, 'Could not find domain input field', REGISTRAR);
      return;
    }

    // Fill domain if not already entered
    const currentValue = input.value?.trim();
    if (!currentValue || currentValue.toLowerCase() !== domain.toLowerCase()) {
      fillInput(input, domain);
      await wait(1000);
    }

    // Select "Quick scan for DNS records" if available
    const radioLabels = document.querySelectorAll('label, [role="radio"]');
    for (const label of radioLabels) {
      if (label.textContent?.toLowerCase().includes('quick scan')) {
        label.click();
        await wait(500);
        break;
      }
    }

    // Find Continue/Add button
    let addButton = findButton(['continue'], { checkDisabled: true });
    if (!addButton) {
      addButton = findButton(['add site', 'add domain', 'add'], { checkDisabled: true });
    }
    if (!addButton) {
      const submitBtn = document.querySelector('button[type="submit"]:not([disabled])');
      const primaryBtn = document.querySelector('button[class*="primary"]:not([disabled]), button[class*="Primary"]:not([disabled])');
      addButton = submitBtn || primaryBtn;
    }

    if (!addButton) {
      await reportError(domain, 'Could not find Add Site/Continue button', REGISTRAR);
      return;
    }

    addButton.click();
    await wait(3000);

    const pageText = document.body.innerText.toLowerCase();

    if (pageText.includes('select a plan') || pageText.includes('free plan') || pageText.includes('pro plan')) {
      await selectFreePlan(domain);
      return;
    }

    if (pageText.includes('already exists') || pageText.includes('already added')) {
      await sendActionComplete('addDomainToCloudflare', domain, { cloudflareAdded: true });
      return;
    }

    if (pageText.includes('nameserver') || pageText.includes('.ns.cloudflare.com')) {
      await sendActionComplete('addDomainToCloudflare', domain, { cloudflareAdded: true });
      return;
    }

    await wait(3000);
    const newPageType = detectPageType();

    if (newPageType !== 'add_domain') {
      await sendActionComplete('addDomainToCloudflare', domain, { cloudflareAdded: true });
    } else {
      const continueBtn = findButton(['continue', 'next', 'proceed'], { checkDisabled: true });
      if (continueBtn) {
        continueBtn.click();
        await wait(3000);
        await sendActionComplete('addDomainToCloudflare', domain, { cloudflareAdded: true });
      } else {
        await reportError(domain, 'Stuck on add-site page', REGISTRAR);
      }
    }
  }

  function findDomainInput() {
    const selectors = [
      'input[placeholder*="domain"]',
      'input[placeholder*="site"]',
      'input[name*="domain"]',
      'input[name*="site"]',
      'input[type="text"]'
    ];

    for (const selector of selectors) {
      const inputs = document.querySelectorAll(selector);
      for (const input of inputs) {
        const rect = input.getBoundingClientRect();
        if (rect.width > 100 && rect.height > 0) {
          return input;
        }
      }
    }
    return null;
  }

  async function selectFreePlan(domain) {
    const freeOptions = document.querySelectorAll('button, [role="button"], label, div[class*="plan"]');

    for (const option of freeOptions) {
      const text = option.textContent?.toLowerCase() || '';
      if (text.includes('free') && !text.includes('pro') && !text.includes('business')) {
        const rect = option.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          option.click();
          await wait(1000);
          break;
        }
      }
    }

    await wait(500);
    const continueButton = findButton(['continue', 'confirm', 'next', 'proceed'], { checkDisabled: true });
    if (continueButton) {
      continueButton.click();
      await wait(3000);
    }

    await wait(2000);
    const pageText = document.body.innerText.toLowerCase();

    if (pageText.includes('nameserver') || pageText.includes('.ns.cloudflare.com')) {
      await sendActionComplete('selectFreePlan', domain, { cloudflareAdded: true });
      return;
    }

    const anotherContinue = findButton(['continue', 'done', 'finish', 'next'], { checkDisabled: true });
    if (anotherContinue) {
      anotherContinue.click();
      await wait(2000);
    }

    await sendActionComplete('selectFreePlan', domain, { cloudflareAdded: true });
  }

  async function extractCloudflareNameservers(domain) {
    let nameservers = findNameservers();

    if (nameservers.length >= 2) {
      await sendActionComplete('extractCloudflareNameservers', domain, { nameservers });
      return;
    }

    // Navigate to DNS page if not already there
    if (currentDomain && accountId && !window.location.href.includes('/dns')) {
      window.location.href = `https://dash.cloudflare.com/${accountId}/${currentDomain}/dns/records`;
      return;
    }

    await wait(3000);
    nameservers = findNameservers();

    if (nameservers.length >= 2) {
      await sendActionComplete('extractCloudflareNameservers', domain, { nameservers });
    } else {
      await reportError(domain, 'Could not find Cloudflare nameservers', REGISTRAR);
    }
  }

  function findNameservers() {
    return findCloudflareNameservers(document.body.innerText);
  }

  async function sendActionComplete(action, domain, extra = {}) {
    await chrome.runtime.sendMessage({
      action: 'actionComplete',
      data: {
        action,
        domain,
        cloudflareAccountId: accountId,
        registrar: REGISTRAR,
        ...extra
      }
    });
  }
})();
