// Domain Migrator - Autonomous Background Orchestrator
// This is the brain that coordinates fully automatic domain transfers

const STORAGE_KEY = 'domainMigrations';

// Domain transfer states
const States = {
  QUEUED: 'queued',
  GETTING_AUTH: 'getting_auth',
  ADDING_TO_CLOUDFLARE: 'adding_to_cloudflare',
  SELECTING_PLAN: 'selecting_plan',
  GETTING_CF_NAMESERVERS: 'getting_cf_nameservers',
  UPDATING_NAMESERVERS: 'updating_nameservers',
  COMPLETE: 'complete',
  ERROR: 'error'
};

// Registrar configurations
const Registrars = {
  godaddy: {
    name: 'GoDaddy',
    portfolioUrl: 'https://dcc.godaddy.com/control/portfolio',
    domainUrl: (domain) => `https://dcc.godaddy.com/control/portfolio/${domain}/settings`,
    dnsUrl: (domain) => `https://dcc.godaddy.com/control/dnsmanagement?domainName=${domain}&subtab=nameservers`
  },
  squarespace: {
    name: 'Squarespace',
    portfolioUrl: 'https://account.squarespace.com/domains/managed',
    domainUrl: (domain) => `https://account.squarespace.com/domains/managed/${domain}/dns-settings`,
    dnsUrl: (domain) => `https://account.squarespace.com/domains/managed/${domain}/dns-settings`
  },
  cloudflare: {
    name: 'Cloudflare',
    dashboardUrl: 'https://dash.cloudflare.com',
    addDomainUrl: 'https://dash.cloudflare.com/?to=/:account/add-site',
    dnsUrl: (domain, accountId) => `https://dash.cloudflare.com/${accountId}/${domain}/dns/records`
  }
};

// Migration orchestrator state
let orchestrator = {
  isRunning: false,
  isPaused: false,
  currentDomain: null,
  currentState: null,
  activeTabId: null,
  queue: [],
  cloudflareAccountId: null,
  pendingAction: null,
  retryCount: 0,
  maxRetries: 3
};

// Initialize
chrome.runtime.onInstalled.addListener(() => {
  console.log('🚀 Domain Migrator installed - Autonomous mode ready');
  initializeStorage();
});

async function initializeStorage() {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  if (!storage[STORAGE_KEY]) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        domains: {},
        settings: {
          targetRegistrar: 'cloudflare',
          autoStart: false
        }
      }
    });
  }
}

// Message handler - communication hub
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('Message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  const { action, data } = message;

  switch (action) {
    // Orchestrator controls
    case 'startMigration':
      return await startMigration(data);
    case 'pauseMigration':
      return pauseMigration();
    case 'resumeMigration':
      return await resumeMigration();
    case 'stopMigration':
      return stopMigration();
    case 'getStatus':
      return getStatus();

    // Domain management
    case 'addDomainsToQueue':
      return await addDomainsToQueue(data.domains, data.sourceRegistrar);
    case 'importFromRegistrar':
      return await importFromRegistrar(data.registrar);
    case 'getDomains':
      return await getDomains();
    case 'clearAllDomains':
      return await clearAllDomains();

    // Content script reports - THE KEY TO AUTOMATION
    case 'pageReady':
      return await handlePageReady(sender.tab, data);
    case 'actionComplete':
      return await handleActionComplete(sender.tab, data);
    case 'actionError':
      return await handleActionError(sender.tab, data);
    case 'domainsFound':
      return await handleDomainsFound(sender.tab, data);

    // Legacy support
    case 'saveDomain':
      return await saveDomain(data);
    case 'saveAuthCode':
      return await saveAuthCode(data.domain, data.authCode);
    case 'saveNameservers':
      return await saveNameservers(data.domain, data.nameservers, data.registrar);
    case 'updateDomainStatus':
      return await updateDomainState(data.domain, data.status);
    case 'getNameservers':
      return await getNameserversForDomain(data.domain);

    default:
      console.warn('Unknown action:', action);
      return { error: 'Unknown action' };
  }
}

// ============ ORCHESTRATOR CONTROLS ============

async function startMigration(options = {}) {
  if (orchestrator.isRunning && !orchestrator.isPaused) {
    return { error: 'Migration already running' };
  }

  console.log('🚀 Starting autonomous migration');
  orchestrator.isRunning = true;
  orchestrator.isPaused = false;
  orchestrator.retryCount = 0;

  // Load domains from storage
  const domains = await getDomains();

  // Build queue from domains that need processing
  orchestrator.queue = Object.values(domains)
    .filter(d => d.state !== States.COMPLETE && d.state !== States.ERROR)
    .map(d => d.name);

  if (orchestrator.queue.length === 0) {
    orchestrator.isRunning = false;
    return { error: 'No domains to migrate. Add domains first!' };
  }

  // Create tab for automation
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  orchestrator.activeTabId = tab.id;

  broadcastStatus();

  // Start processing
  await processNextDomain();

  return { success: true, queueLength: orchestrator.queue.length };
}

function pauseMigration() {
  orchestrator.isPaused = true;
  console.log('⏸️ Migration paused');
  broadcastStatus();
  return { success: true };
}

async function resumeMigration() {
  if (!orchestrator.isRunning) {
    return startMigration();
  }
  orchestrator.isPaused = false;
  console.log('▶️ Migration resumed');
  broadcastStatus();
  await continueCurrentDomain();
  return { success: true };
}

function stopMigration() {
  orchestrator.isRunning = false;
  orchestrator.isPaused = false;
  orchestrator.currentDomain = null;
  orchestrator.currentState = null;
  orchestrator.pendingAction = null;
  console.log('⏹️ Migration stopped');
  broadcastStatus();
  return { success: true };
}

function getStatus() {
  return {
    isRunning: orchestrator.isRunning,
    isPaused: orchestrator.isPaused,
    currentDomain: orchestrator.currentDomain,
    currentState: orchestrator.currentState,
    queueLength: orchestrator.queue.length,
    queue: orchestrator.queue,
    pendingAction: orchestrator.pendingAction
  };
}

// ============ DOMAIN PROCESSING ============

async function processNextDomain() {
  if (!orchestrator.isRunning || orchestrator.isPaused) return;

  if (orchestrator.queue.length === 0) {
    console.log('✅ All domains processed!');
    orchestrator.isRunning = false;
    orchestrator.currentDomain = null;
    orchestrator.currentState = null;
    broadcastStatus();

    // Show completion notification
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Migration Complete!',
      message: 'All domains have been processed.'
    });
    return;
  }

  const domainName = orchestrator.queue.shift();
  orchestrator.currentDomain = domainName;
  orchestrator.retryCount = 0;

  console.log(`\n📍 Processing: ${domainName} (${orchestrator.queue.length} remaining)`);

  const domain = await getDomainByName(domainName);
  if (!domain) {
    console.error(`Domain ${domainName} not found in storage`);
    await processNextDomain();
    return;
  }

  await continueCurrentDomain();
}

async function continueCurrentDomain() {
  const domain = await getDomainByName(orchestrator.currentDomain);
  if (!domain) return;

  const state = domain.state || States.QUEUED;
  orchestrator.currentState = state;

  console.log(`   State: ${state}`);
  broadcastStatus();

  switch (state) {
    case States.QUEUED:
    case States.GETTING_AUTH:
      await goToGetAuthCode(domain);
      break;

    case States.ADDING_TO_CLOUDFLARE:
      await goToAddToCloudflare(domain);
      break;

    case States.SELECTING_PLAN:
      await goToSelectPlan(domain);
      break;

    case States.GETTING_CF_NAMESERVERS:
      await goToGetCloudflareNS(domain);
      break;

    case States.UPDATING_NAMESERVERS:
      await goToUpdateNameservers(domain);
      break;

    case States.COMPLETE:
      console.log(`   ✅ Already complete`);
      await processNextDomain();
      break;

    case States.ERROR:
      console.log(`   ❌ In error state, skipping`);
      await processNextDomain();
      break;

    default:
      console.log(`   Unknown state: ${state}`);
      await updateDomainState(domain.name, States.QUEUED);
      await goToGetAuthCode(domain);
  }
}

// ============ NAVIGATION FUNCTIONS ============

async function goToGetAuthCode(domain) {
  const registrar = domain.sourceRegistrar || 'godaddy';
  const config = Registrars[registrar];

  // If we already have an auth code, skip to next step
  if (domain.authCode) {
    console.log(`   Already have auth code, advancing...`);
    await updateDomainState(domain.name, States.ADDING_TO_CLOUDFLARE);
    await continueCurrentDomain();
    return;
  }

  await updateDomainState(domain.name, States.GETTING_AUTH);
  orchestrator.pendingAction = 'extractAuthCode';

  const url = config.domainUrl(domain.name);
  console.log(`   🔗 Going to ${registrar} for auth code: ${url}`);

  await navigateTo(url);
}

async function goToAddToCloudflare(domain) {
  // Check if domain already exists in Cloudflare
  if (domain.cloudflareAdded) {
    console.log(`   Already in Cloudflare, getting NS...`);
    await updateDomainState(domain.name, States.GETTING_CF_NAMESERVERS);
    await continueCurrentDomain();
    return;
  }

  await updateDomainState(domain.name, States.ADDING_TO_CLOUDFLARE);
  orchestrator.pendingAction = 'addDomainToCloudflare';

  // Go to Cloudflare add domain page
  const url = 'https://dash.cloudflare.com/?to=/:account/add-site';
  console.log(`   🔗 Going to Cloudflare to add domain: ${url}`);

  await navigateTo(url);
}

async function goToSelectPlan(domain) {
  orchestrator.pendingAction = 'selectFreePlan';
  // Content script should auto-select free plan when page loads
}

async function goToGetCloudflareNS(domain) {
  // Check if we already have Cloudflare nameservers
  if (domain.nameservers?.cloudflare?.length > 0) {
    console.log(`   Already have CF nameservers, updating at source...`);
    await updateDomainState(domain.name, States.UPDATING_NAMESERVERS);
    await continueCurrentDomain();
    return;
  }

  await updateDomainState(domain.name, States.GETTING_CF_NAMESERVERS);
  orchestrator.pendingAction = 'extractCloudflareNameservers';

  // Navigate to the domain's DNS page in Cloudflare
  const accountId = orchestrator.cloudflareAccountId || '010d8d7f3b423be5ce36c7a5a49e91e4';
  const url = `https://dash.cloudflare.com/${accountId}/${domain.name}/dns/records`;
  console.log(`   🔗 Going to Cloudflare DNS: ${url}`);

  await navigateTo(url);
}

async function goToUpdateNameservers(domain) {
  const registrar = domain.sourceRegistrar || 'godaddy';
  const config = Registrars[registrar];

  await updateDomainState(domain.name, States.UPDATING_NAMESERVERS);
  orchestrator.pendingAction = 'updateNameservers';

  const url = config.dnsUrl(domain.name);
  console.log(`   🔗 Going to ${registrar} to update NS: ${url}`);

  await navigateTo(url);
}

async function navigateTo(url) {
  if (!orchestrator.activeTabId) {
    const tab = await chrome.tabs.create({ url, active: true });
    orchestrator.activeTabId = tab.id;
  } else {
    await chrome.tabs.update(orchestrator.activeTabId, { url });
  }
}

// ============ CONTENT SCRIPT HANDLERS ============

async function handlePageReady(tab, data) {
  if (!orchestrator.isRunning || orchestrator.isPaused) {
    return { action: 'none', reason: 'Not running' };
  }

  if (tab?.id !== orchestrator.activeTabId) {
    return { action: 'none', reason: 'Not active tab' };
  }

  console.log(`   📄 Page ready: ${data.registrar} / ${data.pageType}`);

  const domain = orchestrator.currentDomain;
  const pendingAction = orchestrator.pendingAction;

  if (!domain || !pendingAction) {
    return { action: 'none', reason: 'No pending action' };
  }

  // Return instruction to content script
  const domainData = await getDomainByName(domain);

  return {
    action: pendingAction,
    domain: domain,
    nameservers: domainData?.nameservers?.cloudflare || []
  };
}

async function handleActionComplete(tab, data) {
  console.log(`   ✅ Action complete: ${data.action}`);

  orchestrator.pendingAction = null;
  orchestrator.retryCount = 0;

  // Save any extracted data
  if (data.authCode) {
    await saveAuthCode(data.domain, data.authCode);
  }
  if (data.nameservers) {
    await saveNameservers(data.domain, data.nameservers, data.registrar);
  }
  if (data.cloudflareAccountId) {
    orchestrator.cloudflareAccountId = data.cloudflareAccountId;
  }
  if (data.cloudflareAdded) {
    await updateDomainField(data.domain, 'cloudflareAdded', true);
  }

  // Determine next state
  const domain = await getDomainByName(data.domain);
  let nextState;

  switch (data.action) {
    case 'extractAuthCode':
      nextState = States.ADDING_TO_CLOUDFLARE;
      break;
    case 'addDomainToCloudflare':
      nextState = States.SELECTING_PLAN;
      break;
    case 'selectFreePlan':
      nextState = States.GETTING_CF_NAMESERVERS;
      break;
    case 'extractCloudflareNameservers':
      nextState = States.UPDATING_NAMESERVERS;
      break;
    case 'updateNameservers':
      nextState = States.COMPLETE;
      break;
    default:
      console.warn(`Unknown action completed: ${data.action}`);
      nextState = domain?.state;
  }

  if (nextState) {
    await updateDomainState(data.domain, nextState);
  }

  // Small delay then continue
  setTimeout(async () => {
    if (nextState === States.COMPLETE) {
      console.log(`   🎉 Domain ${data.domain} COMPLETE!\n`);
      await processNextDomain();
    } else {
      await continueCurrentDomain();
    }
  }, 1500);

  return { success: true };
}

async function handleActionError(tab, data) {
  console.error(`   ❌ Action error: ${data.error}`);

  orchestrator.retryCount++;

  if (orchestrator.retryCount < orchestrator.maxRetries) {
    console.log(`   Retrying... (${orchestrator.retryCount}/${orchestrator.maxRetries})`);
    setTimeout(() => continueCurrentDomain(), 3000);
  } else {
    console.log(`   Max retries reached, marking as error`);
    await updateDomainState(data.domain, States.ERROR, { error: data.error });
    orchestrator.retryCount = 0;
    setTimeout(() => processNextDomain(), 1000);
  }

  return { success: true };
}

async function handleDomainsFound(tab, data) {
  console.log(`📋 Found ${data.domains.length} domains from ${data.registrar}`);
  await addDomainsToQueue(data.domains, data.registrar);
  broadcastStatus();
  return { success: true };
}

// ============ STORAGE FUNCTIONS ============

async function addDomainsToQueue(domains, sourceRegistrar) {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  const data = storage[STORAGE_KEY] || { domains: {}, settings: {} };
  let added = 0;

  for (const domainName of domains) {
    if (!data.domains[domainName]) {
      data.domains[domainName] = {
        name: domainName,
        sourceRegistrar,
        state: States.QUEUED,
        addedAt: new Date().toISOString(),
        lastUpdated: new Date().toISOString()
      };
      added++;
    }
  }

  await chrome.storage.local.set({ [STORAGE_KEY]: data });
  console.log(`Added ${added} new domains to queue`);

  return { success: true, added, total: Object.keys(data.domains).length };
}

async function importFromRegistrar(registrar) {
  // Navigate to registrar's domain list page
  const config = Registrars[registrar];
  if (!config) return { error: 'Unknown registrar' };

  orchestrator.pendingAction = 'scanForDomains';

  const tab = await chrome.tabs.create({ url: config.portfolioUrl, active: true });
  orchestrator.activeTabId = tab.id;

  return { success: true, message: `Navigating to ${config.name} to scan domains...` };
}

async function getDomains() {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  return storage[STORAGE_KEY]?.domains || {};
}

async function getDomainByName(name) {
  const domains = await getDomains();
  return domains[name];
}

async function updateDomainState(domainName, newState, extra = {}) {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  const data = storage[STORAGE_KEY];

  if (data?.domains?.[domainName]) {
    data.domains[domainName].state = newState;
    data.domains[domainName].lastUpdated = new Date().toISOString();
    Object.assign(data.domains[domainName], extra);
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  }

  broadcastStatus();
}

async function updateDomainField(domainName, field, value) {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  const data = storage[STORAGE_KEY];

  if (data?.domains?.[domainName]) {
    data.domains[domainName][field] = value;
    data.domains[domainName].lastUpdated = new Date().toISOString();
    await chrome.storage.local.set({ [STORAGE_KEY]: data });
  }
}

async function saveDomain(domainData) {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  const data = storage[STORAGE_KEY] || { domains: {}, settings: {} };

  const existing = data.domains[domainData.name] || {};
  data.domains[domainData.name] = {
    ...existing,
    ...domainData,
    lastUpdated: new Date().toISOString()
  };

  await chrome.storage.local.set({ [STORAGE_KEY]: data });
  return { success: true };
}

async function saveAuthCode(domainName, authCode) {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  const data = storage[STORAGE_KEY];

  if (!data.domains[domainName]) {
    data.domains[domainName] = { name: domainName, state: States.QUEUED };
  }

  data.domains[domainName].authCode = authCode;
  data.domains[domainName].lastUpdated = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEY]: data });

  console.log(`   🔑 Saved auth code for ${domainName}`);
  return { success: true };
}

async function saveNameservers(domainName, nameservers, registrar) {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  const data = storage[STORAGE_KEY];

  if (!data.domains[domainName]) {
    data.domains[domainName] = { name: domainName, state: States.QUEUED };
  }

  if (!data.domains[domainName].nameservers) {
    data.domains[domainName].nameservers = {};
  }

  data.domains[domainName].nameservers[registrar] = nameservers;
  data.domains[domainName].lastUpdated = new Date().toISOString();
  await chrome.storage.local.set({ [STORAGE_KEY]: data });

  console.log(`   🌐 Saved ${registrar} nameservers for ${domainName}: ${nameservers.join(', ')}`);
  return { success: true };
}

async function getNameserversForDomain(domainName) {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  const domain = storage[STORAGE_KEY]?.domains?.[domainName];
  return domain?.nameservers || {};
}

async function clearAllDomains() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: { domains: {}, settings: {} }
  });
  return { success: true };
}

// ============ UTILITIES ============

function broadcastStatus() {
  const status = getStatus();

  // Send to popup and any listening content scripts
  chrome.runtime.sendMessage({ action: 'statusUpdate', status }).catch(() => {});
}

// Listen for tab closure
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === orchestrator.activeTabId) {
    orchestrator.activeTabId = null;
    if (orchestrator.isRunning) {
      console.log('⚠️ Automation tab closed, pausing migration');
      pauseMigration();
    }
  }
});

console.log('🤖 Domain Migrator background script loaded - Autonomous orchestrator ready');
