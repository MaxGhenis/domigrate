// Domain Migrator - Pure Functions Library
// Testable, side-effect-free functions for domain migration logic

'use strict';

const DOMAIN_PATTERN = /([a-z0-9][a-z0-9-]*\.[a-z]{2,})/i;

/**
 * Validates an authorization code.
 * Must be 8-30 chars, no spaces, contain both letters and numbers.
 */
function isValidAuthCode(text) {
  return text.length >= 8 && text.length <= 30 &&
         !text.includes(' ') && !!text.match(/[A-Za-z]/) && !!text.match(/[0-9]/);
}

/**
 * Detect GoDaddy page type from URL.
 * Order matters: more specific checks before general ones.
 */
function detectGoDaddyPageType(url, path) {
  if (url.includes('sso.godaddy.com') || url.includes('login') || url.includes('verify')) {
    return 'verification_required';
  }
  if (url.includes('transferOut')) return 'transfer_out';
  if (url.includes('/transfers')) return 'transfers';
  if (url.includes('portfolio') && !path.includes('.')) return 'portfolio_list';
  if (url.includes('/settings') || url.includes('settings')) return 'domain_settings';
  if (url.includes('subtab=nameservers')) return 'nameservers';
  if (url.includes('dnsmanagement') || url.includes('dns')) return 'dns_management';
  if (path.match(/\/portfolio\/[^\/]+$/)) return 'domain_overview';

  return 'unknown';
}

/**
 * Detect Cloudflare page type from URL.
 * Order matters: more specific checks before general ones.
 */
function detectCloudflarePageType(url, path) {
  if (url.includes('add-site') || url.includes('to=/:account/add-site')) return 'add_domain';
  if (path.includes('/dns')) return 'domain_dns';
  if (path.match(/\/[a-f0-9]{32}\/home/) || path.match(/\/[a-f0-9]{32}$/)) return 'account_home';
  if (path.match(/\/[a-f0-9]{32}\/[^\/]+$/)) return 'domain_overview';

  return 'unknown';
}

/**
 * Extract account ID and domain from Cloudflare URL path.
 */
function extractCloudflareUrlInfo(path, documentTitle) {
  let accountId = null;
  let domain = null;

  const match = path.match(/\/([a-f0-9]{32})\/([a-z0-9][a-z0-9-]*\.[a-z]{2,})/i);
  if (match) {
    accountId = match[1];
    domain = match[2];
    return { accountId, domain };
  }

  const accountMatch = path.match(/\/([a-f0-9]{32})/i);
  if (accountMatch) {
    accountId = accountMatch[1];
  }

  if (documentTitle) {
    const domainMatch = documentTitle.match(DOMAIN_PATTERN);
    if (domainMatch && !domainMatch[1].includes('cloudflare')) {
      domain = domainMatch[1];
    }
  }

  return { accountId, domain };
}

/**
 * Extract Cloudflare nameservers from page text.
 */
function findCloudflareNameservers(bodyText) {
  const matches = bodyText.match(/[a-z]+\.ns\.cloudflare\.com/gi);
  return matches ? [...new Set(matches)] : [];
}

/**
 * Check if element text indicates a promo/ad (should be skipped in domain scan).
 */
function isPromoElement(combinedText) {
  return combinedText.includes('add to cart') ||
         combinedText.includes('get ') ||
         combinedText.includes('buy ') ||
         combinedText.includes('safeguard') ||
         combinedText.includes('ensure its authenticity') ||
         combinedText.includes('protect your brand') ||
         combinedText.includes('/yr') ||
         combinedText.includes('/year') ||
         combinedText.includes('$');
}

/**
 * Extract domain from URL path using pattern matching.
 */
function extractDomainFromPath(path) {
  const pathParts = path.split('/').filter(Boolean);
  for (const part of pathParts) {
    if (part.match(DOMAIN_PATTERN)) {
      return part;
    }
  }
  return null;
}

/**
 * Check if page indicates nameservers are already set to Cloudflare.
 */
function hasCloudflareNameservers(pageText) {
  return pageText.toLowerCase().includes('.ns.cloudflare.com');
}

/**
 * Check if specific nameservers are present on page.
 */
function nameserversAlreadySet(pageText, nameservers) {
  const lowerPageText = pageText.toLowerCase();
  return nameservers.every(ns => lowerPageText.includes(ns.toLowerCase()));
}

/**
 * Check if GoDaddy page has a pending event blocking changes.
 */
function hasPendingEvent(pageText) {
  const lowerText = pageText.toLowerCase();
  return lowerText.includes('pending event') || lowerText.includes('pending operation');
}

/**
 * Check if GoDaddy page shows Step 1 of transfer flow.
 */
function isTransferStep1(pageText) {
  return pageText.includes('Step 1 of 2');
}

// Status bar constants
const STATE_LABELS = {
  queued: 'Queued',
  getting_auth: 'Getting auth code...',
  waiting_for_2fa: '⏳ Complete 2FA verification',
  adding_to_cloudflare: 'Adding to Cloudflare...',
  selecting_plan: 'Selecting plan...',
  getting_cf_nameservers: 'Getting nameservers...',
  updating_nameservers: 'Updating nameservers...',
  complete: 'Complete',
  error: 'Error'
};

const MIGRATION_STEPS = [
  { state: 'getting_auth', label: 'Get auth code' },
  { state: 'adding_to_cloudflare', label: 'Add to Cloudflare' },
  { state: 'selecting_plan', label: 'Select plan' },
  { state: 'getting_cf_nameservers', label: 'Get nameservers' },
  { state: 'updating_nameservers', label: 'Update nameservers' },
  { state: 'complete', label: 'Done' }
];

/**
 * Get step index for a given state.
 */
function getStepIndex(state) {
  const idx = MIGRATION_STEPS.findIndex(s => s.state === state);
  return idx === -1 ? 0 : idx;
}

/**
 * Get state label for display.
 */
function getStateLabel(state) {
  return STATE_LABELS[state] || state;
}

/**
 * Calculate migration progress.
 */
function calculateProgress(domains) {
  const total = Object.keys(domains).length;
  const completed = Object.values(domains).filter(d =>
    d.state === 'complete' || d.state === 'error'
  ).length;
  return { completed, total };
}

/**
 * Get step status relative to current step.
 */
function getStepStatus(stepIndex, currentStepIndex) {
  if (stepIndex < currentStepIndex) return 'completed';
  if (stepIndex === currentStepIndex) return 'current';
  return 'pending';
}

// Export for testing (in browser, these are global)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    DOMAIN_PATTERN,
    STATE_LABELS,
    MIGRATION_STEPS,
    isValidAuthCode,
    detectGoDaddyPageType,
    detectCloudflarePageType,
    extractCloudflareUrlInfo,
    findCloudflareNameservers,
    isPromoElement,
    extractDomainFromPath,
    hasCloudflareNameservers,
    nameserversAlreadySet,
    hasPendingEvent,
    isTransferStep1,
    getStepIndex,
    getStateLabel,
    calculateProgress,
    getStepStatus
  };
}
