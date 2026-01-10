// Domain Migrator - Cloudflare Autonomous Content Script
// Auto-detects page context and performs migration actions

(function() {
  'use strict';

  const REGISTRAR = 'cloudflare';

  console.log('🤖 Domain Migrator: Cloudflare autonomous script loaded');

  // State
  let currentDomain = null;
  let accountId = null;

  // Initialize on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  async function init() {
    // Wait for page to stabilize
    await waitForPageReady();

    // Extract account ID and domain from URL
    extractUrlInfo();

    // Detect page type
    const pageType = detectPageType();

    console.log(`📄 Cloudflare page: ${pageType}, domain: ${currentDomain || 'none'}, account: ${accountId || 'none'}`);

    // Notify background script that page is ready
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

    // If orchestrator gives us an action, execute it
    if (response?.action && response.action !== 'none') {
      console.log(`🎯 Received action: ${response.action}`);
      await executeAction(response.action, response);
    }

    // Watch for SPA navigation
    watchForNavigation();
  }

  function waitForPageReady() {
    return new Promise(resolve => {
      const checkReady = () => {
        const hasContent = document.body?.textContent?.length > 500;
        const notLoading = !document.querySelector('[class*="loading"], [class*="spinner"]');
        if (hasContent && notLoading) {
          resolve();
        } else {
          setTimeout(checkReady, 500);
        }
      };
      setTimeout(checkReady, 1500);
    });
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

    // Try to find domain in page content
    const pageTitle = document.title;
    const domainMatch = pageTitle.match(/([a-z0-9][a-z0-9-]*\.[a-z]{2,})/i);
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
    if (path.match(/\/[a-f0-9]{32}\/home/)) return 'account_home';
    if (path.match(/\/[a-f0-9]{32}$/)) return 'account_home';

    return 'unknown';
  }

  // ============ ACTION EXECUTOR ============

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
          await reportError(data.domain, `Unknown action: ${action}`);
      }
    } catch (error) {
      console.error(`Action ${action} failed:`, error);
      await reportError(data.domain, error.message);
    }
  }

  // ============ AUTONOMOUS ACTIONS ============

  async function addDomainToCloudflare(domain) {
    console.log(`➕ Adding domain ${domain} to Cloudflare...`);

    const pageType = detectPageType();

    // If we're on add-site page
    if (pageType === 'add_domain') {
      // Find the domain input field
      const input = findDomainInput();

      if (input) {
        console.log('   Found domain input, entering domain...');
        input.focus();
        input.value = '';
        input.value = domain;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        await wait(500);

        // Find and click the "Add site" or "Continue" button
        const addButton = findButton(['add site', 'continue', 'add domain', 'add']);

        if (addButton) {
          console.log('   Clicking add button...');
          addButton.click();

          await wait(3000);

          // Check if we advanced to plan selection
          const pageText = document.body.innerText.toLowerCase();
          if (pageText.includes('select a plan') || pageText.includes('free plan') || pageText.includes('pro plan')) {
            console.log('   Advanced to plan selection');
            await selectFreePlan(domain);
          } else if (pageText.includes('already exists') || pageText.includes('already added')) {
            console.log('   Domain already exists in Cloudflare');
            await chrome.runtime.sendMessage({
              action: 'actionComplete',
              data: {
                action: 'addDomainToCloudflare',
                domain,
                cloudflareAdded: true,
                cloudflareAccountId: accountId,
                registrar: REGISTRAR
              }
            });
          } else {
            // Wait more and check again
            await wait(3000);
            const newPageType = detectPageType();
            if (newPageType !== 'add_domain') {
              await chrome.runtime.sendMessage({
                action: 'actionComplete',
                data: {
                  action: 'addDomainToCloudflare',
                  domain,
                  cloudflareAdded: true,
                  cloudflareAccountId: accountId,
                  registrar: REGISTRAR
                }
              });
            }
          }
        } else {
          await reportError(domain, 'Could not find Add Site button');
        }
      } else {
        await reportError(domain, 'Could not find domain input field');
      }
    } else {
      // Navigate to add-site page
      console.log('   Navigating to add-site page...');
      window.location.href = 'https://dash.cloudflare.com/?to=/:account/add-site';
    }
  }

  function findDomainInput() {
    // Try various selectors for the domain input
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
    console.log(`📋 Selecting free plan for ${domain}...`);

    // Look for "Free" plan option
    const freeOptions = document.querySelectorAll('button, [role="button"], label, div[class*="plan"]');

    for (const option of freeOptions) {
      const text = option.textContent?.toLowerCase() || '';
      if (text.includes('free') && !text.includes('pro') && !text.includes('business')) {
        const rect = option.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          console.log('   Found free plan option, clicking...');
          option.click();
          await wait(1000);
          break;
        }
      }
    }

    // Look for "Continue" or "Confirm" button
    await wait(500);
    const continueButton = findButton(['continue', 'confirm', 'next', 'proceed']);

    if (continueButton) {
      console.log('   Clicking continue...');
      continueButton.click();
      await wait(3000);
    }

    // Check if we're now on the DNS/nameserver page
    await wait(2000);
    const pageText = document.body.innerText.toLowerCase();

    if (pageText.includes('nameserver') || pageText.includes('.ns.cloudflare.com')) {
      console.log('   ✅ Free plan selected, now on nameserver page');
      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: {
          action: 'selectFreePlan',
          domain,
          cloudflareAdded: true,
          cloudflareAccountId: accountId,
          registrar: REGISTRAR
        }
      });
    } else {
      // Keep clicking continue if there are more steps
      const anotherContinue = findButton(['continue', 'done', 'finish', 'next']);
      if (anotherContinue) {
        anotherContinue.click();
        await wait(2000);
      }

      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: {
          action: 'selectFreePlan',
          domain,
          cloudflareAdded: true,
          cloudflareAccountId: accountId,
          registrar: REGISTRAR
        }
      });
    }
  }

  async function extractCloudflareNameservers(domain) {
    console.log(`🌐 Extracting Cloudflare nameservers for ${domain}...`);

    // Make sure we're on a page with nameservers
    const nameservers = findNameservers();

    if (nameservers.length >= 2) {
      console.log(`   ✅ Found nameservers: ${nameservers.join(', ')}`);
      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: {
          action: 'extractCloudflareNameservers',
          domain,
          nameservers,
          cloudflareAccountId: accountId,
          registrar: REGISTRAR
        }
      });
    } else {
      // Try navigating to the domain's DNS page
      if (currentDomain && accountId) {
        const dnsUrl = `https://dash.cloudflare.com/${accountId}/${currentDomain}/dns/records`;
        if (!window.location.href.includes('/dns')) {
          console.log('   Navigating to DNS page...');
          window.location.href = dnsUrl;
          return;
        }
      }

      // Wait and try again
      await wait(3000);
      const retryNs = findNameservers();

      if (retryNs.length >= 2) {
        console.log(`   ✅ Found nameservers on retry: ${retryNs.join(', ')}`);
        await chrome.runtime.sendMessage({
          action: 'actionComplete',
          data: {
            action: 'extractCloudflareNameservers',
            domain,
            nameservers: retryNs,
            cloudflareAccountId: accountId,
            registrar: REGISTRAR
          }
        });
      } else {
        await reportError(domain, 'Could not find Cloudflare nameservers');
      }
    }
  }

  function findNameservers() {
    const nameservers = [];
    const bodyText = document.body.innerText;

    // Pattern: *.ns.cloudflare.com
    const matches = bodyText.match(/[a-z]+\.ns\.cloudflare\.com/gi);
    if (matches) {
      nameservers.push(...new Set(matches));
    }

    return nameservers;
  }

  // ============ UTILITIES ============

  function findButton(textPatterns) {
    const buttons = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');

    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || btn.value?.toLowerCase() || '';
      if (textPatterns.some(pattern => text.includes(pattern))) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          // Check it's not disabled
          if (!btn.disabled && !btn.classList.contains('disabled')) {
            return btn;
          }
        }
      }
    }
    return null;
  }

  function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function reportError(domain, error) {
    console.error(`❌ Error for ${domain}: ${error}`);
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
        console.log('🔄 Navigation detected, reinitializing...');
        setTimeout(init, 1500);
      }
    }).observe(document.body, { subtree: true, childList: true });
  }

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'statusUpdate') {
      console.log('📊 Status update:', message.status);
    }
    if (message.action === 'executeAction') {
      executeAction(message.instruction.action, message);
    }
    sendResponse({ received: true });
    return true;
  });
})();
