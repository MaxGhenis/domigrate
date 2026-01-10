// Domain Migrator - Background Orchestrator
// Coordinates domain transfers between registrars

const STORAGE_KEY = 'domainMigrations';

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

const orchestrator = {
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

chrome.runtime.onInstalled.addListener(() => {
  console.log('Domain Migrator installed');
  initializeStorage();
});

async function initializeStorage() {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  if (!storage[STORAGE_KEY]) {
    await chrome.storage.local.set({
      [STORAGE_KEY]: {
        domains: {},
        settings: { targetRegistrar: 'cloudflare', autoStart: false }
      }
    });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch(err => {
    console.error('Message handler error:', err);
    sendResponse({ error: err.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  const { action, data } = message;

  const handlers = {
    startMigration: () => startMigration(data),
    pauseMigration: pauseMigration,
    resumeMigration: resumeMigration,
    stopMigration: stopMigration,
    getStatus: getStatus,
    addDomainsToQueue: () => addDomainsToQueue(data.domains, data.sourceRegistrar),
    importFromRegistrar: () => importFromRegistrar(data.registrar),
    getDomains: getDomains,
    clearAllDomains: clearAllDomains,
    pageReady: () => handlePageReady(sender.tab, data),
    actionComplete: () => handleActionComplete(sender.tab, data),
    actionError: () => handleActionError(sender.tab, data),
    domainsFound: () => handleDomainsFound(sender.tab, data),
    saveDomain: () => saveDomain(data),
    saveAuthCode: () => saveAuthCode(data.domain, data.authCode),
    saveNameservers: () => saveNameservers(data.domain, data.nameservers, data.registrar),
    updateDomainStatus: () => updateDomainState(data.domain, data.status),
    getNameservers: () => getNameserversForDomain(data.domain)
  };

  const handler = handlers[action];
  if (handler) return handler();

  console.warn('Unknown action:', action);
  return { error: 'Unknown action' };
}

// Orchestrator Controls

async function startMigration(options = {}) {
  if (orchestrator.isRunning && !orchestrator.isPaused) {
    return { error: 'Migration already running' };
  }

  console.log('Starting migration');
  orchestrator.isRunning = true;
  orchestrator.isPaused = false;
  orchestrator.retryCount = 0;

  const domains = await getDomains();
  orchestrator.queue = Object.values(domains)
    .filter(d => d.state !== States.COMPLETE && d.state !== States.ERROR)
    .map(d => d.name);

  if (orchestrator.queue.length === 0) {
    orchestrator.isRunning = false;
    return { error: 'No domains to migrate. Add domains first!' };
  }

  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  orchestrator.activeTabId = tab.id;

  broadcastStatus();
  await processNextDomain();

  return { success: true, queueLength: orchestrator.queue.length };
}

function pauseMigration() {
  orchestrator.isPaused = true;
  console.log('Migration paused');
  broadcastStatus();
  return { success: true };
}

async function resumeMigration() {
  if (!orchestrator.isRunning) {
    return startMigration();
  }
  orchestrator.isPaused = false;
  console.log('Migration resumed');
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
  console.log('Migration stopped');
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

// Domain Processing

async function processNextDomain() {
  if (!orchestrator.isRunning || orchestrator.isPaused) return;

  if (orchestrator.queue.length === 0) {
    console.log('All domains processed');
    orchestrator.isRunning = false;
    orchestrator.currentDomain = null;
    orchestrator.currentState = null;
    broadcastStatus();

    chrome.notifications?.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: 'Migration Complete',
      message: 'All domains have been processed.'
    });
    return;
  }

  const domainName = orchestrator.queue.shift();
  orchestrator.currentDomain = domainName;
  orchestrator.retryCount = 0;

  console.log(`Processing: ${domainName} (${orchestrator.queue.length} remaining)`);

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

  console.log(`State: ${state}`);
  broadcastStatus();

  const stateHandlers = {
    [States.QUEUED]: () => goToGetAuthCode(domain),
    [States.GETTING_AUTH]: () => goToGetAuthCode(domain),
    [States.ADDING_TO_CLOUDFLARE]: () => goToAddToCloudflare(domain),
    [States.SELECTING_PLAN]: () => goToSelectPlan(domain),
    [States.GETTING_CF_NAMESERVERS]: () => goToGetCloudflareNS(domain),
    [States.UPDATING_NAMESERVERS]: () => goToUpdateNameservers(domain),
    [States.COMPLETE]: async () => {
      console.log('Already complete');
      await processNextDomain();
    },
    [States.ERROR]: async () => {
      console.log('In error state, skipping');
      await processNextDomain();
    }
  };

  const handler = stateHandlers[state];
  if (handler) {
    await handler();
  } else {
    console.log(`Unknown state: ${state}`);
    await updateDomainState(domain.name, States.QUEUED);
    await goToGetAuthCode(domain);
  }
}

// Navigation Functions

async function goToGetAuthCode(domain) {
  if (domain.authCode) {
    console.log('Already have auth code, advancing...');
    await updateDomainState(domain.name, States.ADDING_TO_CLOUDFLARE);
    await continueCurrentDomain();
    return;
  }

  const registrar = domain.sourceRegistrar || 'godaddy';
  const config = Registrars[registrar];

  await updateDomainState(domain.name, States.GETTING_AUTH);
  orchestrator.pendingAction = 'extractAuthCode';

  const url = config.domainUrl(domain.name);
  console.log(`Going to ${registrar} for auth code: ${url}`);
  await navigateTo(url);
}

async function goToAddToCloudflare(domain) {
  if (domain.cloudflareAdded) {
    console.log('Already in Cloudflare, getting NS...');
    await updateDomainState(domain.name, States.GETTING_CF_NAMESERVERS);
    await continueCurrentDomain();
    return;
  }

  await updateDomainState(domain.name, States.ADDING_TO_CLOUDFLARE);
  orchestrator.pendingAction = 'addDomainToCloudflare';

  const url = 'https://dash.cloudflare.com/?to=/:account/add-site';
  console.log(`Going to Cloudflare to add domain: ${url}`);
  await navigateTo(url);
}

async function goToSelectPlan(domain) {
  orchestrator.pendingAction = 'selectFreePlan';
}

async function goToGetCloudflareNS(domain) {
  if (domain.nameservers?.cloudflare?.length > 0) {
    console.log('Already have CF nameservers, updating at source...');
    await updateDomainState(domain.name, States.UPDATING_NAMESERVERS);
    await continueCurrentDomain();
    return;
  }

  await updateDomainState(domain.name, States.GETTING_CF_NAMESERVERS);
  orchestrator.pendingAction = 'extractCloudflareNameservers';

  const accountId = orchestrator.cloudflareAccountId || '010d8d7f3b423be5ce36c7a5a49e91e4';
  const url = `https://dash.cloudflare.com/${accountId}/${domain.name}/dns/records`;
  console.log(`Going to Cloudflare DNS: ${url}`);
  await navigateTo(url);
}

async function goToUpdateNameservers(domain) {
  const registrar = domain.sourceRegistrar || 'godaddy';
  const config = Registrars[registrar];

  await updateDomainState(domain.name, States.UPDATING_NAMESERVERS);
  orchestrator.pendingAction = 'updateNameservers';

  const url = config.dnsUrl(domain.name);
  console.log(`Going to ${registrar} to update NS: ${url}`);
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

// Content Script Handlers

async function handlePageReady(tab, data) {
  console.log(`Page ready: ${data.registrar} / ${data.pageType}`);

  if (orchestrator.pendingAction === 'scanForDomains' && tab?.id === orchestrator.activeTabId) {
    console.log('Triggering domain scan...');
    orchestrator.pendingAction = null;
    return { action: 'scanForDomains' };
  }

  if (!orchestrator.isRunning || orchestrator.isPaused) {
    return { action: 'none', reason: 'Not running' };
  }

  if (tab?.id !== orchestrator.activeTabId) {
    return { action: 'none', reason: 'Not active tab' };
  }

  const domain = orchestrator.currentDomain;
  const pendingAction = orchestrator.pendingAction;

  if (!domain || !pendingAction) {
    return { action: 'none', reason: 'No pending action' };
  }

  const domainData = await getDomainByName(domain);

  return {
    action: pendingAction,
    domain: domain,
    nameservers: domainData?.nameservers?.cloudflare || []
  };
}

async function handleActionComplete(tab, data) {
  console.log(`Action complete: ${data.action}`);

  orchestrator.pendingAction = null;
  orchestrator.retryCount = 0;

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

  const nextStateMap = {
    extractAuthCode: States.ADDING_TO_CLOUDFLARE,
    addDomainToCloudflare: States.SELECTING_PLAN,
    selectFreePlan: States.GETTING_CF_NAMESERVERS,
    extractCloudflareNameservers: States.UPDATING_NAMESERVERS,
    updateNameservers: States.COMPLETE
  };

  const nextState = nextStateMap[data.action];

  if (nextState) {
    await updateDomainState(data.domain, nextState);
  }

  setTimeout(async () => {
    if (nextState === States.COMPLETE) {
      console.log(`Domain ${data.domain} COMPLETE`);
      await processNextDomain();
    } else {
      await continueCurrentDomain();
    }
  }, 1500);

  return { success: true };
}

async function handleActionError(tab, data) {
  console.error(`Action error: ${data.error}`);

  orchestrator.retryCount++;

  if (orchestrator.retryCount < orchestrator.maxRetries) {
    console.log(`Retrying... (${orchestrator.retryCount}/${orchestrator.maxRetries})`);
    setTimeout(() => continueCurrentDomain(), 3000);
  } else {
    console.log('Max retries reached, marking as error');
    await updateDomainState(data.domain, States.ERROR, { error: data.error });
    orchestrator.retryCount = 0;
    setTimeout(() => processNextDomain(), 1000);
  }

  return { success: true };
}

async function handleDomainsFound(tab, data) {
  console.log(`Found ${data.domains.length} domains from ${data.registrar}`);
  await addDomainsToQueue(data.domains, data.registrar);
  broadcastStatus();
  return { success: true };
}

// Storage Functions

async function getStorageData() {
  const storage = await chrome.storage.local.get(STORAGE_KEY);
  return storage[STORAGE_KEY] || { domains: {}, settings: {} };
}

async function saveStorageData(data) {
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}

async function updateDomain(domainName, updater) {
  const data = await getStorageData();
  if (!data.domains[domainName]) {
    data.domains[domainName] = { name: domainName, state: States.QUEUED };
  }
  updater(data.domains[domainName]);
  data.domains[domainName].lastUpdated = new Date().toISOString();
  await saveStorageData(data);
}

async function addDomainsToQueue(domains, sourceRegistrar) {
  const data = await getStorageData();
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

  await saveStorageData(data);
  console.log(`Added ${added} new domains to queue`);

  return { success: true, added, total: Object.keys(data.domains).length };
}

async function importFromRegistrar(registrar) {
  const config = Registrars[registrar];
  if (!config) return { error: 'Unknown registrar' };

  orchestrator.pendingAction = 'scanForDomains';

  const tab = await chrome.tabs.create({ url: config.portfolioUrl, active: true });
  orchestrator.activeTabId = tab.id;

  return { success: true, message: `Navigating to ${config.name} to scan domains...` };
}

async function getDomains() {
  const data = await getStorageData();
  return data.domains;
}

async function getDomainByName(name) {
  const domains = await getDomains();
  return domains[name];
}

async function updateDomainState(domainName, newState, extra = {}) {
  await updateDomain(domainName, domain => {
    domain.state = newState;
    Object.assign(domain, extra);
  });
  broadcastStatus();
}

async function updateDomainField(domainName, field, value) {
  await updateDomain(domainName, domain => {
    domain[field] = value;
  });
}

async function saveDomain(domainData) {
  await updateDomain(domainData.name, domain => {
    Object.assign(domain, domainData);
  });
  return { success: true };
}

async function saveAuthCode(domainName, authCode) {
  await updateDomain(domainName, domain => {
    domain.authCode = authCode;
  });
  console.log(`Saved auth code for ${domainName}`);
  return { success: true };
}

async function saveNameservers(domainName, nameservers, registrar) {
  await updateDomain(domainName, domain => {
    domain.nameservers = domain.nameservers || {};
    domain.nameservers[registrar] = nameservers;
  });
  console.log(`Saved ${registrar} nameservers for ${domainName}: ${nameservers.join(', ')}`);
  return { success: true };
}

async function getNameserversForDomain(domainName) {
  const data = await getStorageData();
  return data.domains[domainName]?.nameservers || {};
}

async function clearAllDomains() {
  await saveStorageData({ domains: {}, settings: {} });
  return { success: true };
}

// Utilities

function broadcastStatus() {
  const status = getStatus();
  chrome.runtime.sendMessage({ action: 'statusUpdate', status }).catch(() => {});
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === orchestrator.activeTabId) {
    orchestrator.activeTabId = null;
    if (orchestrator.isRunning) {
      console.log('Automation tab closed, pausing migration');
      pauseMigration();
    }
  }
});

console.log('Domain Migrator background script loaded');
