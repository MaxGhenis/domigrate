// Domain Migrator - GoDaddy Content Script
// Auto-detects page context and performs migration actions

(function() {
  'use strict';

  const REGISTRAR = 'godaddy';

  const init = createContentScriptInit({
    registrar: REGISTRAR,
    waitOptions: {
      minContentLength: 1000,  // GoDaddy pages are content-heavy
      initialDelay: 2000,      // Give the SPA time to render
      checkInterval: 500
    },
    extractDomain: extractDomainFromUrl,
    detectPageType,
    executeAction
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
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

    // Detect SSO/2FA pages - user needs to complete verification
    if (url.includes('sso.godaddy.com') || url.includes('login') || url.includes('verify')) {
      return 'verification_required';
    }
    // Detect transfer out page (where auth code is shown)
    if (url.includes('transferOut')) return 'transfer_out';
    if (url.includes('/transfers')) return 'transfers';
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
    await scanForDomainsAndReport(
      REGISTRAR,
      ['a[href*="/portfolio/"]', '[data-testid*="domain"]', '.domain-item', '.domain-name'],
      /\/portfolio\/([a-z0-9-]+\.[a-z]{2,})/i
    );
  }

  async function extractAuthCode(domain) {
    const pageType = detectPageType();

    // Wait for 2FA if on verification page
    if (pageType === 'verification_required') {
      await chrome.runtime.sendMessage({
        action: 'waitingFor2FA',
        data: { domain, registrar: REGISTRAR }
      });
      const checkInterval = setInterval(async () => {
        if (detectPageType() !== 'verification_required') {
          clearInterval(checkInterval);
          await wait(2000);
          await extractAuthCode(domain);
        }
      }, 1000);
      return;
    }

    // Handle transfer out page flow
    if (pageType === 'transfer_out') {
      // Handle Step 1 if present
      if (isTransferStep1(document.body.innerText)) {
        const continueBtn = findButton(['continue']);
        if (continueBtn) {
          continueBtn.click();
          await wait(3000);
        }
      }

      // Try to get auth code
      let authCode = findAuthCodeOnPage();

      // Try revealing if not visible
      if (!authCode) {
        const revealBtn = findButton(['click here to see authorization code', 'see authorization code', 'show authorization code']);
        if (revealBtn) {
          revealBtn.click();
          await wait(2000);
          authCode = findAuthCodeOnPage();
        }
      }

      if (authCode) {
        await chrome.runtime.sendMessage({
          action: 'actionComplete',
          data: { action: 'extractAuthCode', domain, authCode, registrar: REGISTRAR }
        });
        return;
      }

      // Retry once
      await wait(3000);
      authCode = findAuthCodeOnPage();

      if (authCode) {
        await chrome.runtime.sendMessage({
          action: 'actionComplete',
          data: { action: 'extractAuthCode', domain, authCode, registrar: REGISTRAR }
        });
        return;
      }

      await reportError(domain, 'Could not find auth code on transfer page', REGISTRAR);
      return;
    }

    // Navigate to transfer out page
    window.location.href = `https://dcc.godaddy.com/control/${domain}/transferOut`;
  }

  function findAuthCodeOnPage() {
    // GoDaddy transfer page has auth code in #authCodeInput
    const authCodeInput = document.querySelector('#authCodeInput');
    if (authCodeInput?.value) {
      const code = authCodeInput.value.trim();
      if (code.length >= 8) return code;
    }

    const containers = document.querySelectorAll(
      '[data-testid*="auth"], [data-testid*="code"], .auth-code, .authorization-code, input[readonly], .code-display'
    );

    for (const container of containers) {
      const text = (container.value || container.textContent || '').trim();
      if (isValidAuthCode(text)) return text;
    }

    const modals = document.querySelectorAll('.modal, [role="dialog"], .popup');
    for (const modal of modals) {
      const codeMatch = modal.innerText.match(/(?:code|authorization)[:\s]+([A-Za-z0-9!@#$%^&*()_\-+=,\.]{8,30})/i);
      if (codeMatch) return codeMatch[1];
    }

    const bodyText = document.body.innerText;
    const nearAuth = bodyText.match(/authorization[^a-z]*code[^a-z]*([A-Za-z0-9!@#$%^&*()_\-+=,\.]{8,30})/i);
    if (nearAuth) return nearAuth[1];

    return null;
  }

  async function updateNameservers(domain, newNameservers) {
    if (!newNameservers || newNameservers.length < 2) {
      await reportError(domain, 'Need at least 2 nameservers', REGISTRAR);
      return;
    }

    const pageType = detectPageType();
    if (pageType !== 'nameservers' && pageType !== 'dns_management') {
      window.location.href = `https://dcc.godaddy.com/control/dnsmanagement?domainName=${domain}&subtab=nameservers`;
      return;
    }

    const pageText = document.body.innerText;

    // Check if already set to Cloudflare
    if (hasCloudflareNameservers(pageText) || nameserversAlreadySet(pageText, newNameservers)) {
      const closeBtn = findButton(['close', 'cancel', 'x', 'ok']);
      if (closeBtn) closeBtn.click();
      await wait(500);
      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: { action: 'updateNameservers', domain, registrar: REGISTRAR }
      });
      return;
    }

    // Check for pending event blocking changes
    if (hasPendingEvent(pageText)) {
      if (hasCloudflareNameservers(pageText)) {
        const closeBtn = findButton(['close', 'cancel', 'ok']);
        if (closeBtn) closeBtn.click();
        await chrome.runtime.sendMessage({
          action: 'actionComplete',
          data: { action: 'updateNameservers', domain, registrar: REGISTRAR }
        });
        return;
      }
      const closeBtn = findButton(['close', 'cancel', 'ok']);
      if (closeBtn) closeBtn.click();
      await reportError(domain, 'Domain has pending event - cannot change nameservers. Try again later.', REGISTRAR);
      return;
    }

    // Close any error modal first
    const errorModal = document.querySelector('[class*="error"], [class*="Error"], .modal, [role="dialog"]');
    const pageHasError = pageText.toLowerCase().includes('failed') || pageText.toLowerCase().includes('error');
    if (pageHasError && errorModal) {
      const cancelBtn = findButton(['cancel', 'close', 'x', 'dismiss']);
      if (cancelBtn) {
        cancelBtn.click();
        await wait(1500);
      }
    }

    const changeButton = findButton([
      'change nameservers', 'change', 'edit nameservers', 'edit', "i'll use my own nameservers"
    ]);
    if (changeButton) {
      changeButton.click();
      await wait(2000);
    }

    // Select "I'll use my own nameservers" option
    const ownNsLabels = document.querySelectorAll('label, [role="radio"]');
    for (const label of ownNsLabels) {
      const labelText = label.textContent?.toLowerCase() || '';
      if (labelText.includes("i'll use my own") || labelText.includes('custom') || labelText.includes('own nameservers')) {
        label.click();
        await wait(500);
        break;
      }
    }

    const inputs = findNameserverInputs();
    if (inputs.length < newNameservers.length) {
      await reportError(domain, `Only found ${inputs.length} nameserver inputs, need ${newNameservers.length}`, REGISTRAR);
      return;
    }

    await fillNameserverInputs(inputs, newNameservers);
    await wait(1000);

    const saveButton = findButton(['save', 'confirm', 'update', 'apply']);
    if (!saveButton) {
      await reportError(domain, 'Could not find save button', REGISTRAR);
      return;
    }

    saveButton.click();
    await wait(4000);

    const newPageText = document.body.innerText.toLowerCase();

    // Success cases
    if (newPageText.includes('success') || newPageText.includes('updated') || newPageText.includes('saved')) {
      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: { action: 'updateNameservers', domain, registrar: REGISTRAR }
      });
      return;
    }

    // Already set (redundant change)
    if (newPageText.includes('redundant') || newPageText.includes('already')) {
      const closeBtn = findButton(['cancel', 'close', 'x', 'ok']);
      if (closeBtn) closeBtn.click();
      await chrome.runtime.sendMessage({
        action: 'actionComplete',
        data: { action: 'updateNameservers', domain, registrar: REGISTRAR }
      });
      return;
    }

    // Error - try once more
    if (newPageText.includes('failed') || newPageText.includes('error')) {
      const closeBtn = findButton(['cancel', 'close', 'x']);
      if (closeBtn) {
        closeBtn.click();
        await wait(2000);
        const retryBtn = findButton(['change nameservers', 'change', 'edit']);
        if (retryBtn) {
          retryBtn.click();
          await wait(2000);
          const retryInputs = findNameserverInputs();
          if (retryInputs.length >= 2) {
            await fillNameserverInputs(retryInputs, newNameservers);
            await wait(500);
            const retrySave = findButton(['save']);
            if (retrySave) {
              retrySave.click();
              await wait(4000);
              const finalText = document.body.innerText.toLowerCase();
              if (!finalText.includes('failed') && !finalText.includes('error')) {
                await chrome.runtime.sendMessage({
                  action: 'actionComplete',
                  data: { action: 'updateNameservers', domain, registrar: REGISTRAR }
                });
                return;
              }
            }
          }
        }
      }
      await reportError(domain, 'Nameserver update failed after retry - please check manually', REGISTRAR);
      return;
    }

    // No clear error, assume success
    await chrome.runtime.sendMessage({
      action: 'actionComplete',
      data: { action: 'updateNameservers', domain, registrar: REGISTRAR }
    });
  }
})();
