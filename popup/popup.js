// Domain Migrator - Popup Controller
// Handles UI interactions and communicates with background orchestrator

const STORAGE_KEY = 'domainMigrations';

// DOM Elements
let elements = {};

// State
let isRunning = false;
let isPaused = false;

// Initialize
document.addEventListener('DOMContentLoaded', init);

async function init() {
  // Cache DOM elements
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

  // Setup event listeners
  setupEventListeners();

  // Load initial state
  await refreshStatus();
  await loadDomains();

  // Listen for status updates from background
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'statusUpdate') {
      updateUIFromStatus(message.status);
      loadDomains(); // Refresh domain list too
    }
  });

  // Refresh periodically
  setInterval(async () => {
    await refreshStatus();
    await loadDomains();
  }, 3000);
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

// ============ CONTROL HANDLERS ============

async function handleStart() {
  if (isPaused) {
    const response = await chrome.runtime.sendMessage({ action: 'resumeMigration' });
    console.log('Resume response:', response);
  } else {
    const response = await chrome.runtime.sendMessage({ action: 'startMigration' });
    console.log('Start response:', response);

    if (response.error) {
      alert(response.error);
      return;
    }
  }
  await refreshStatus();
}

async function handlePause() {
  if (isPaused) {
    await chrome.runtime.sendMessage({ action: 'resumeMigration' });
  } else {
    await chrome.runtime.sendMessage({ action: 'pauseMigration' });
  }
  await refreshStatus();
}

async function handleStop() {
  await chrome.runtime.sendMessage({ action: 'stopMigration' });
  await refreshStatus();
}

async function handleClearAll() {
  if (confirm('Clear all tracked domains? This cannot be undone.')) {
    await chrome.runtime.sendMessage({ action: 'clearAllDomains' });
    await loadDomains();
  }
}

// ============ IMPORT HANDLERS ============

async function importFromRegistrar(registrar) {
  const response = await chrome.runtime.sendMessage({
    action: 'importFromRegistrar',
    data: { registrar }
  });

  if (response.error) {
    alert(response.error);
    return;
  }

  window.close(); // Close popup so user can see the tab
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

// ============ DATA LOADING ============

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

  // Update status indicator
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

  // Update buttons
  elements.btnStart.disabled = isRunning && !isPaused;
  elements.btnStart.innerHTML = isPaused ? '<span>&#9654;</span> Resume' : '<span>&#9654;</span> Start';
  elements.btnPause.disabled = !isRunning;
  elements.btnPause.innerHTML = isPaused ? '<span>&#9654;</span> Resume' : '<span>&#10074;&#10074;</span> Pause';
  elements.btnStop.disabled = !isRunning;

  // Update current task display
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

    // Update stats
    const stats = { queued: 0, active: 0, complete: 0, error: 0 };

    domainArray.forEach(d => {
      const state = d.state || 'queued';
      if (state === 'complete') stats.complete++;
      else if (state === 'error') stats.error++;
      else if (['getting_auth', 'adding_to_cloudflare', 'selecting_plan', 'getting_cf_nameservers', 'updating_nameservers'].includes(state)) stats.active++;
      else stats.queued++;
    });

    elements.statQueued.textContent = stats.queued;
    elements.statActive.textContent = stats.active;
    elements.statComplete.textContent = stats.complete;
    elements.statError.textContent = stats.error;

    // Render domain list
    renderDomainList(domainArray);
  } catch (e) {
    console.error('Failed to load domains:', e);
  }
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

  // Sort: active first, then queued, then complete, then error
  const stateOrder = {
    'getting_auth': 0,
    'adding_to_cloudflare': 0,
    'selecting_plan': 0,
    'getting_cf_nameservers': 0,
    'updating_nameservers': 0,
    'queued': 1,
    'complete': 2,
    'error': 3
  };

  domains.sort((a, b) => {
    const orderA = stateOrder[a.state] ?? 1;
    const orderB = stateOrder[b.state] ?? 1;
    return orderA - orderB;
  });

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

// ============ UTILITIES ============

function formatState(state) {
  const stateLabels = {
    'queued': 'Queued',
    'getting_auth': 'Getting Auth',
    'adding_to_cloudflare': 'Adding to CF',
    'selecting_plan': 'Selecting Plan',
    'getting_cf_nameservers': 'Getting NS',
    'updating_nameservers': 'Updating NS',
    'complete': 'Complete',
    'error': 'Error'
  };
  return stateLabels[state] || state || 'Queued';
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}
