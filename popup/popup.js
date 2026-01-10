// Domain Migrator - Popup Controller
// Handles UI interactions and communicates with background orchestrator

const ACTIVE_STATES = [
  'getting_auth',
  'adding_to_cloudflare',
  'selecting_plan',
  'getting_cf_nameservers',
  'updating_nameservers'
];

const STATE_LABELS = {
  queued: 'Queued',
  getting_auth: 'Getting Auth',
  adding_to_cloudflare: 'Adding to CF',
  selecting_plan: 'Selecting Plan',
  getting_cf_nameservers: 'Getting NS',
  updating_nameservers: 'Updating NS',
  complete: 'Complete',
  error: 'Error'
};

let elements = {};
let isRunning = false;
let isPaused = false;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  setupEventListeners();
  await refreshStatus();
  await loadDomains();

  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'statusUpdate') {
      updateUIFromStatus(message.status);
      loadDomains();
    }
  });

  setInterval(async () => {
    await refreshStatus();
    await loadDomains();
  }, 3000);
}

function cacheElements() {
  elements = {
    statusIndicator: document.getElementById('status-indicator'),
    statusText: document.getElementById('status-text'),
    btnStart: document.getElementById('btn-start'),
    btnPause: document.getElementById('btn-pause'),
    btnStop: document.getElementById('btn-stop'),
    currentTask: document.getElementById('current-task'),
    currentDomain: document.getElementById('current-domain'),
    currentState: document.getElementById('current-state'),
    domainList: document.getElementById('domain-list'),
    statQueued: document.getElementById('stat-queued'),
    statActive: document.getElementById('stat-active'),
    statComplete: document.getElementById('stat-complete'),
    statError: document.getElementById('stat-error')
  };
}

function setupEventListeners() {
  elements.btnStart.addEventListener('click', handleStart);
  elements.btnPause.addEventListener('click', handlePause);
  elements.btnStop.addEventListener('click', handleStop);

  document.getElementById('import-godaddy').addEventListener('click', () => importFromRegistrar('godaddy'));
  document.getElementById('import-squarespace').addEventListener('click', () => importFromRegistrar('squarespace'));
  document.getElementById('import-manual').addEventListener('click', showManualAddDialog);
  document.getElementById('btn-clear').addEventListener('click', handleClearAll);
}

async function handleStart() {
  const action = isPaused ? 'resumeMigration' : 'startMigration';
  const response = await chrome.runtime.sendMessage({ action });
  console.log(`${action} response:`, response);

  if (response.error) {
    alert(response.error);
    return;
  }
  await refreshStatus();
}

async function handlePause() {
  const action = isPaused ? 'resumeMigration' : 'pauseMigration';
  await chrome.runtime.sendMessage({ action });
  await refreshStatus();
}

async function handleStop() {
  await chrome.runtime.sendMessage({ action: 'stopMigration' });
  await refreshStatus();
}

async function handleClearAll() {
  if (!confirm('Clear all tracked domains? This cannot be undone.')) return;
  await chrome.runtime.sendMessage({ action: 'clearAllDomains' });
  await loadDomains();
}

async function importFromRegistrar(registrar) {
  const response = await chrome.runtime.sendMessage({
    action: 'importFromRegistrar',
    data: { registrar }
  });

  if (response.error) {
    alert(response.error);
    return;
  }

  window.close();
}

function showManualAddDialog() {
  const input = prompt('Enter domain names (comma-separated):');
  if (!input) return;

  const domains = input.split(',')
    .map(d => d.trim().toLowerCase())
    .filter(d => d.match(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/));

  if (domains.length === 0) {
    alert('No valid domains entered');
    return;
  }

  const registrar = prompt('Source registrar (godaddy/squarespace):', 'godaddy') || 'godaddy';

  chrome.runtime.sendMessage({
    action: 'addDomainsToQueue',
    data: { domains, sourceRegistrar: registrar }
  }).then(response => {
    if (response.success) {
      alert(`Added ${response.added} domains`);
      loadDomains();
    }
  });
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    updateUIFromStatus(status);
  } catch (e) {
    console.error('Failed to get status:', e);
  }
}

function updateUIFromStatus(status) {
  if (!status) return;

  isRunning = status.isRunning;
  isPaused = status.isPaused;

  updateStatusIndicator();
  updateButtons();
  updateCurrentTask(status);
}

function updateStatusIndicator() {
  elements.statusIndicator.className = 'status-indicator';

  if (isRunning && !isPaused) {
    elements.statusIndicator.classList.add('running');
    elements.statusText.textContent = 'Running';
  } else if (isPaused) {
    elements.statusIndicator.classList.add('paused');
    elements.statusText.textContent = 'Paused';
  } else {
    elements.statusIndicator.classList.add('idle');
    elements.statusText.textContent = 'Idle';
  }
}

function updateButtons() {
  elements.btnStart.disabled = isRunning && !isPaused;
  elements.btnStart.innerHTML = isPaused ? '<span>&#9654;</span> Resume' : '<span>&#9654;</span> Start';
  elements.btnPause.disabled = !isRunning;
  elements.btnPause.innerHTML = isPaused ? '<span>&#9654;</span> Resume' : '<span>&#10074;&#10074;</span> Pause';
  elements.btnStop.disabled = !isRunning;
}

function updateCurrentTask(status) {
  if (isRunning && status.currentDomain) {
    elements.currentTask.classList.add('active');
    elements.currentDomain.textContent = status.currentDomain;
    elements.currentState.textContent = formatState(status.currentState);
  } else {
    elements.currentTask.classList.remove('active');
  }
}

async function loadDomains() {
  try {
    const domains = await chrome.runtime.sendMessage({ action: 'getDomains' });
    const domainArray = Object.values(domains || {});

    updateStats(domainArray);
    renderDomainList(domainArray);
  } catch (e) {
    console.error('Failed to load domains:', e);
  }
}

function updateStats(domains) {
  const stats = { queued: 0, active: 0, complete: 0, error: 0 };

  for (const domain of domains) {
    const state = domain.state || 'queued';
    if (state === 'complete') {
      stats.complete++;
    } else if (state === 'error') {
      stats.error++;
    } else if (ACTIVE_STATES.includes(state)) {
      stats.active++;
    } else {
      stats.queued++;
    }
  }

  elements.statQueued.textContent = stats.queued;
  elements.statActive.textContent = stats.active;
  elements.statComplete.textContent = stats.complete;
  elements.statError.textContent = stats.error;
}

function renderDomainList(domains) {
  if (domains.length === 0) {
    elements.domainList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&#128269;</div>
        <h3>No domains yet</h3>
        <p>Import domains from GoDaddy or Squarespace,<br>or add them manually to get started.</p>
      </div>
    `;
    return;
  }

  const stateOrder = {
    getting_auth: 0,
    adding_to_cloudflare: 0,
    selecting_plan: 0,
    getting_cf_nameservers: 0,
    updating_nameservers: 0,
    queued: 1,
    complete: 2,
    error: 3
  };

  domains.sort((a, b) => (stateOrder[a.state] ?? 1) - (stateOrder[b.state] ?? 1));

  elements.domainList.innerHTML = domains.map(domain => {
    const state = domain.state || 'queued';
    return `
      <div class="domain-item ${state}">
        <span class="domain-name">${escapeHtml(domain.name)}</span>
        <span class="domain-state ${state}">${formatState(state)}</span>
      </div>
    `;
  }).join('');
}

function formatState(state) {
  return STATE_LABELS[state] || state || 'Queued';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}
