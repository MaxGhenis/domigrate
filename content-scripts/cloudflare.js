// Domain Migrator - Cloudflare Content Script
// Auto-detects page context and performs migration actions

(function() {
  'use strict';

  const REGISTRAR = 'cloudflare';
  let currentDomain = null;
  let accountId = null;

  console.log('Domain Migrator: Cloudflare script loaded');

  // Initialize on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    await waitForPageReady({ initialDelay: 1500 });
    extractUrlInfo();
    const pageType = detectPageType();

    console.log(`Cloudflare page: ${pageType}, domain: ${currentDomain || 'none'}, account: ${accountId || 'none'}`);

    const response = await chrome.runtime.sendMessage({
      action: 'pageReady',
      data: {
        registrar: REGISTRAR,
        pageType,
        domain: currentDomain,
        accountId,
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

  function extractUrlInfo() {
    const path = window.location.pathname;

    // Pattern: /accountid/domain.com/...
    const match = path.match(/\/([a-f0-9]{32})\/([a-z0-9][a-z0-9-]*\.[a-z]{2,})/i);
    if (match) {
      accountId = match[1];
      currentDomain = match[2];
      return;
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
    }
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
    console.log(`Adding domain ${domain} to Cloudflare...`);

    const pageType = detectPageType();

    if (pageType !== 'add_domain') {
      console.log('Navigating to add-site page...');
      window.location.href = 'https://dash.cloudflare.com/?to=/:account/add-site';
      return;
    }

    const input = findDomainInput();

    if (!input) {
      await reportError(domain, 'Could not find domain input field', REGISTRAR);
      return;
    }

    console.log('Found domain input, entering domain...');
    fillInput(input, domain);
    await wait(500);

    const addButton = findButton(['add site', 'continue', 'add domain', 'add']);

    if (!addButton) {
      await reportError(domain, 'Could not find Add Site button', REGISTRAR);
      return;
    }

    console.log('Clicking add button...');
    addButton.click();
    await wait(3000);

    const pageText = document.body.innerText.toLowerCase();

    if (pageText.includes('select a plan') || pageText.includes('free plan') || pageText.includes('pro plan')) {
      console.log('Advanced to plan selection');
      await selectFreePlan(domain);
      return;
    }

    if (pageText.includes('already exists') || pageText.includes('already added')) {
      console.log('Domain already exists in Cloudflare');
      await sendActionComplete('addDomainToCloudflare', domain, { cloudflareAdded: true });
      return;
    }

    await wait(3000);
    if (detectPageType() !== 'add_domain') {
      await sendActionComplete('addDomainToCloudflare', domain, { cloudflareAdded: true });
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
    console.log(`Selecting free plan for ${domain}...`);

    const freeOptions = document.querySelectorAll('button, [role="button"], label, div[class*="plan"]');

    for (const option of freeOptions) {
      const text = option.textContent?.toLowerCase() || '';
      if (text.includes('free') && !text.includes('pro') && !text.includes('business')) {
        const rect = option.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          console.log('Found free plan option, clicking...');
          option.click();
          await wait(1000);
          break;
        }
      }
    }

    await wait(500);
    const continueButton = findButton(['continue', 'confirm', 'next', 'proceed'], { checkDisabled: true });

    if (continueButton) {
      console.log('Clicking continue...');
      continueButton.click();
      await wait(3000);
    }

    await wait(2000);
    const pageText = document.body.innerText.toLowerCase();

    if (pageText.includes('nameserver') || pageText.includes('.ns.cloudflare.com')) {
      console.log('Free plan selected, now on nameserver page');
      await sendActionComplete('selectFreePlan', domain, { cloudflareAdded: true });
      return;
    }

    // Keep clicking continue if there are more steps
    const anotherContinue = findButton(['continue', 'done', 'finish', 'next'], { checkDisabled: true });
    if (anotherContinue) {
      anotherContinue.click();
      await wait(2000);
    }

    await sendActionComplete('selectFreePlan', domain, { cloudflareAdded: true });
  }

  async function extractCloudflareNameservers(domain) {
    console.log(`Extracting Cloudflare nameservers for ${domain}...`);

    let nameservers = findNameservers();

    if (nameservers.length >= 2) {
      console.log(`Found nameservers: ${nameservers.join(', ')}`);
      await sendActionComplete('extractCloudflareNameservers', domain, { nameservers });
      return;
    }

    // Try navigating to the domain's DNS page
    if (currentDomain && accountId && !window.location.href.includes('/dns')) {
      console.log('Navigating to DNS page...');
      window.location.href = `https://dash.cloudflare.com/${accountId}/${currentDomain}/dns/records`;
      return;
    }

    await wait(3000);
    nameservers = findNameservers();

    if (nameservers.length >= 2) {
      console.log(`Found nameservers on retry: ${nameservers.join(', ')}`);
      await sendActionComplete('extractCloudflareNameservers', domain, { nameservers });
    } else {
      await reportError(domain, 'Could not find Cloudflare nameservers', REGISTRAR);
    }
  }

  function findNameservers() {
    const bodyText = document.body.innerText;
    const matches = bodyText.match(/[a-z]+\.ns\.cloudflare\.com/gi);
    return matches ? [...new Set(matches)] : [];
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
