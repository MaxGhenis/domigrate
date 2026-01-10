// Domain Migrator - GoDaddy Autonomous Content Script
// Auto-detects page context and performs migration actions

(function() {
  'use strict';

  const REGISTRAR = 'godaddy';

  console.log('🤖 Domain Migrator: GoDaddy autonomous script loaded');

  // State
  let currentDomain = null;
  let isAutonomousMode = false;

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

    console.log(`📄 GoDaddy page: ${pageType}, domain: ${currentDomain || 'none'}`);

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
      console.log(`🎯 Received action: ${response.action}`);
      isAutonomousMode = true;
      await executeAction(response.action, response);
    }

    // Also create the manual overlay for non-autonomous use
    if (!isAutonomousMode) {
      createOverlay();
    }

    // Watch for SPA navigation
    watchForNavigation();
  }

  function waitForPageReady() {
    return new Promise(resolve => {
      // Wait for key elements to appear
      const checkReady = () => {
        const hasContent = document.body?.textContent?.length > 500;
        const notLoading = !document.querySelector('.loading, .spinner, [class*="loading"]');
        if (hasContent && notLoading) {
          resolve();
        } else {
          setTimeout(checkReady, 500);
        }
      };
      setTimeout(checkReady, 1000); // Initial delay for page load
    });
  }

  function extractDomainFromUrl() {
    const url = new URL(window.location.href);

    // Method 1: Query parameter
    const params = new URLSearchParams(url.search);
    const paramDomain = params.get('domainName');
    if (paramDomain) return paramDomain;

    // Method 2: Path-based URL (e.g., /portfolio/example.com/settings)
    const pathParts = url.pathname.split('/').filter(Boolean);
    for (const part of pathParts) {
      if (part.match(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z]{2,}$/i)) {
        return part;
      }
    }

    // Method 3: Page title
    const titleMatch = document.title.match(/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z]{2,})/i);
    if (titleMatch) return titleMatch[1];

    // Method 4: Look for domain in page header
    const h1 = document.querySelector('h1, .domain-name, [data-testid*="domain"]');
    if (h1) {
      const headerMatch = h1.textContent.match(/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.[a-z]{2,})/i);
      if (headerMatch) return headerMatch[1];
    }

    return null;
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
    console.log('🔍 Scanning for domains...');

    const domains = [];

    // Find all domain links/entries on the page
    const domainElements = document.querySelectorAll(
      'a[href*="/portfolio/"], [data-testid*="domain"], .domain-item, .domain-name'
    );

    for (const el of domainElements) {
      const href = el.getAttribute('href') || '';
      const text = el.textContent || '';

      // Extract domain from href
      const hrefMatch = href.match(/\/portfolio\/([a-z0-9-]+\.[a-z]{2,})/i);
      if (hrefMatch) {
        domains.push(hrefMatch[1]);
        continue;
      }

      // Extract domain from text
      const textMatch = text.match(/^([a-z0-9-]+\.[a-z]{2,})$/i);
      if (textMatch) {
        domains.push(textMatch[1]);
      }
    }

    // Also scan page text
    const pageText = document.body.innerText;
    const textMatches = pageText.match(/\b([a-z0-9-]+\.(com|org|net|ai|co|io|dev|info|online))\b/gi);
    if (textMatches) {
      domains.push(...textMatches);
    }

    const uniqueDomains = [...new Set(domains)];
    console.log(`📋 Found ${uniqueDomains.length} domains:`, uniqueDomains);

    await chrome.runtime.sendMessage({
      action: 'domainsFound',
      data: {
        domains: uniqueDomains,
        registrar: REGISTRAR
      }
    });
  }

  async function extractAuthCode(domain) {
    console.log(`🔑 Extracting auth code for ${domain}...`);

    // First, check if we're on the right page
    const pageType = detectPageType();
    if (pageType !== 'domain_settings' && pageType !== 'domain_overview') {
      // Navigate to domain settings
      console.log('   Navigating to domain settings...');
      window.location.href = `https://dcc.godaddy.com/control/portfolio/${domain}/settings`;
      return; // Page will reload and re-trigger
    }

    // Look for existing auth code display
    let authCode = findAuthCodeOnPage();

    if (!authCode) {
      // Try to click the "Get Authorization Code" button
      const authButton = findButton([
        'get authorization code',
        'get auth code',
        'authorization code',
        'transfer',
        'auth code'
      ]);

      if (authButton) {
        console.log('   Clicking auth code button...');
        authButton.click();

        // Wait for modal/code to appear
        await wait(3000);

        authCode = findAuthCodeOnPage();
      }
    }

    if (authCode) {
      console.log(`   ✅ Found auth code: ${authCode.substring(0, 4)}...`);
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
      // Check if there's a "domain locked" message
      if (document.body.innerText.toLowerCase().includes('domain is locked')) {
        await reportError(domain, 'Domain is locked - unlock it first');
      } else {
        await reportError(domain, 'Could not find auth code - may need manual extraction');
      }
    }
  }

  function findAuthCodeOnPage() {
    // Method 1: Look for specific containers
    const containers = document.querySelectorAll(
      '[data-testid*="auth"], [data-testid*="code"], .auth-code, .authorization-code, input[readonly], .code-display'
    );

    for (const container of containers) {
      const text = (container.value || container.textContent || '').trim();
      // Auth codes are typically 8-20 characters with mixed chars
      if (text.length >= 8 && text.length <= 30 && !text.includes(' ') && text.match(/[A-Za-z]/) && text.match(/[0-9]/)) {
        return text;
      }
    }

    // Method 2: Look in modal dialogs
    const modals = document.querySelectorAll('.modal, [role="dialog"], .popup');
    for (const modal of modals) {
      const modalText = modal.innerText;
      // Look for patterns like "Your code is: XXXXXX"
      const codeMatch = modalText.match(/(?:code|authorization)[:\s]+([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/i);
      if (codeMatch) return codeMatch[1];
    }

    // Method 3: Look for any code-like string near "authorization" text
    const bodyText = document.body.innerText;
    const nearAuth = bodyText.match(/authorization[^a-z]*code[^a-z]*([A-Za-z0-9!@#$%^&*()_\-+=]{8,30})/i);
    if (nearAuth) return nearAuth[1];

    return null;
  }

  async function updateNameservers(domain, newNameservers) {
    console.log(`🌐 Updating nameservers for ${domain} to:`, newNameservers);

    if (!newNameservers || newNameservers.length < 2) {
      await reportError(domain, 'Need at least 2 nameservers');
      return;
    }

    // Check if we're on the nameserver page
    const pageType = detectPageType();
    if (pageType !== 'nameservers' && pageType !== 'dns_management') {
      // Navigate to nameservers page
      console.log('   Navigating to nameservers page...');
      window.location.href = `https://dcc.godaddy.com/control/dnsmanagement?domainName=${domain}&subtab=nameservers`;
      return;
    }

    // Look for "Change" or "Edit" nameservers button
    const changeButton = findButton([
      'change nameservers',
      'change',
      'edit nameservers',
      'edit',
      'i\'ll use my own nameservers'
    ]);

    if (changeButton) {
      console.log('   Clicking change button...');
      changeButton.click();
      await wait(2000);
    }

    // Find nameserver input fields
    const inputs = findNameserverInputs();

    if (inputs.length >= newNameservers.length) {
      console.log(`   Found ${inputs.length} nameserver inputs, filling...`);

      // Clear and fill each input
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

      // Look for Save button
      await wait(1000);
      const saveButton = findButton(['save', 'confirm', 'update', 'apply']);

      if (saveButton) {
        console.log('   Clicking save button...');
        saveButton.click();
        await wait(3000);

        // Verify success
        const successIndicator = document.body.innerText.toLowerCase();
        if (successIndicator.includes('success') || successIndicator.includes('updated') || successIndicator.includes('saved')) {
          console.log('   ✅ Nameservers updated successfully');
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
      const label = input.closest('label')?.textContent?.toLowerCase() || '';

      return placeholder.includes('nameserver') ||
             placeholder.includes('ns') ||
             name.includes('nameserver') ||
             name.includes('ns') ||
             id.includes('nameserver') ||
             id.includes('ns') ||
             label.includes('nameserver');
    });
  }

  // ============ UTILITIES ============

  function findButton(textPatterns) {
    const buttons = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');

    for (const btn of buttons) {
      const text = btn.textContent?.toLowerCase() || btn.value?.toLowerCase() || '';
      if (textPatterns.some(pattern => text.includes(pattern))) {
        // Make sure it's visible
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
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

  // ============ MANUAL OVERLAY (fallback) ============

  let overlay = null;

  function createOverlay() {
    if (overlay || isAutonomousMode) return;

    overlay = document.createElement('div');
    overlay.id = 'domain-migrator-overlay';
    overlay.innerHTML = `
      <div class="dm-header">
        <span class="dm-logo">🔄</span>
        <span class="dm-title">Domain Migrator</span>
        <button class="dm-minimize">−</button>
      </div>
      <div class="dm-content">
        <div class="dm-domain-name">${currentDomain || 'GoDaddy'}</div>
        <div class="dm-status">Ready</div>
        <div class="dm-info" style="font-size: 11px; color: #888; margin-top: 8px;">
          Open popup to start autonomous migration
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.querySelector('.dm-minimize').addEventListener('click', () => {
      overlay.classList.toggle('dm-minimized');
    });
  }

  // Listen for status updates from background
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
