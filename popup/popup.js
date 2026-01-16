// Domain Migrator - Popup Controller
// State-driven UI with inline notifications

const ACTIVE_STATES = [
  'getting_auth', 'adding_to_cloudflare', 'selecting_plan',
  'getting_cf_nameservers', 'updating_nameservers', 'waiting_for_2fa'
];

const STATE_LABELS = {
  queued: 'Queued',
  getting_auth: 'Getting auth code...',
  waiting_for_2fa: '⏳ Complete 2FA in browser',
  adding_to_cloudflare: 'Adding to Cloudflare...',
  selecting_plan: 'Selecting plan...',
  getting_cf_nameservers: 'Getting nameservers...',
  updating_nameservers: 'Updating nameservers...',
  complete: 'Complete',
  error: 'Error'
};

// App state
let state = {
  domains: [],
  isRunning: false,
  isPaused: false,
  currentDomain: null,
  currentState: null,
  stats: { queued: 0, active: 0, done: 0, errors: 0 }
};

// DOM elements cache
const el = {};

document.addEventListener('DOMContentLoaded', init);

async function init() {
  cacheElements();
  setupEventListeners();
  await refresh();

  // Listen for background updates
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'statusUpdate') refresh();
  });

  // Periodic refresh
  setInterval(refresh, 2000);
}

function cacheElements() {
  el.statusPill = document.getElementById('status-pill');
  el.statusText = document.getElementById('status-text');
  el.toast = document.getElementById('toast');
  el.toastIcon = document.getElementById('toast-icon');
  el.toastContent = document.getElementById('toast-content');
  el.stateEmpty = document.getElementById('state-empty');
  el.stateReady = document.getElementById('state-ready');
  el.stateRunning = document.getElementById('state-running');
  el.domainsSection = document.getElementById('domains-section');
  el.readyCount = document.getElementById('ready-count');
  el.runningDomain = document.getElementById('running-domain');
  el.runningState = document.getElementById('running-state');
  el.runningProgress = document.getElementById('running-progress');
  el.progressFill = document.getElementById('progress-fill');
  el.btnPause = document.getElementById('btn-pause');
  el.domainList = document.getElementById('domain-list');
  el.statQueued = document.getElementById('stat-queued');
  el.statActive = document.getElementById('stat-active');
  el.statDone = document.getElementById('stat-done');
  el.statErrors = document.getElementById('stat-errors');
  el.modalOverlay = document.getElementById('modal-overlay');
  el.modalDomains = document.getElementById('modal-domains');
  el.modalRegistrar = document.getElementById('modal-registrar');
}

function setupEventListeners() {
  // Import buttons (empty state)
  document.getElementById('import-godaddy').addEventListener('click', () => importFrom('godaddy'));
  document.getElementById('import-squarespace').addEventListener('click', () => importFrom('squarespace'));
  document.getElementById('import-manual').addEventListener('click', showModal);

  // Add more buttons (ready state)
  document.getElementById('add-godaddy').addEventListener('click', () => importFrom('godaddy'));
  document.getElementById('add-squarespace').addEventListener('click', () => importFrom('squarespace'));
  document.getElementById('add-manual').addEventListener('click', showModal);

  // Control buttons
  document.getElementById('btn-start').addEventListener('click', startMigration);
  document.getElementById('btn-pause').addEventListener('click', togglePause);
  document.getElementById('btn-stop').addEventListener('click', stopMigration);
  document.getElementById('btn-clear').addEventListener('click', clearAll);

  // Modal
  document.getElementById('modal-cancel').addEventListener('click', hideModal);
  document.getElementById('modal-confirm').addEventListener('click', addManualDomains);
  document.getElementById('toast-dismiss').addEventListener('click', hideToast);

  // Close modal on overlay click
  el.modalOverlay.addEventListener('click', (e) => {
    if (e.target === el.modalOverlay) hideModal();
  });
}

// ============ Data Fetching ============

async function refresh() {
  try {
    const [status, domains] = await Promise.all([
      chrome.runtime.sendMessage({ action: 'getStatus' }),
      chrome.runtime.sendMessage({ action: 'getDomains' })
    ]);

    state.isRunning = status?.isRunning || false;
    state.isPaused = status?.isPaused || false;
    state.currentDomain = status?.currentDomain;
    state.currentState = status?.currentState;
    state.domains = Object.values(domains || {});

    calculateStats();
    render();
  } catch (e) {
    console.error('Refresh failed:', e);
  }
}

function calculateStats() {
  state.stats = { queued: 0, active: 0, done: 0, errors: 0 };

  for (const d of state.domains) {
    if (d.state === 'complete') state.stats.done++;
    else if (d.state === 'error') state.stats.errors++;
    else if (ACTIVE_STATES.includes(d.state)) state.stats.active++;
    else state.stats.queued++;
  }
}

// ============ Rendering ============

function render() {
  renderStatus();
  renderStateView();
  renderStats();
  renderDomainList();
}

function renderStatus() {
  el.statusPill.className = 'status-pill';

  if (state.isRunning && !state.isPaused) {
    el.statusPill.classList.add('running');
    el.statusText.textContent = 'Running';
  } else if (state.isPaused) {
    el.statusPill.classList.add('paused');
    el.statusText.textContent = 'Paused';
  } else {
    el.statusPill.classList.add('idle');
    el.statusText.textContent = 'Idle';
  }
}

function renderStateView() {
  // Hide all state views
  el.stateEmpty.classList.remove('active');
  el.stateReady.classList.remove('active');
  el.stateRunning.classList.remove('active');

  const hasDomains = state.domains.length > 0;
  const pendingCount = state.stats.queued + state.stats.active;

  // Show domains section when we have domains
  el.domainsSection.style.display = hasDomains ? 'block' : 'none';

  if (state.isRunning) {
    // Running state
    el.stateRunning.classList.add('active');
    renderRunningState();
  } else if (hasDomains && pendingCount > 0) {
    // Ready to start
    el.stateReady.classList.add('active');
    el.readyCount.textContent = pendingCount;
  } else if (hasDomains) {
    // Has domains but all done/error - show ready state anyway
    el.stateReady.classList.add('active');
    el.readyCount.textContent = '0';
  } else {
    // Empty state
    el.stateEmpty.classList.add('active');
  }
}

function renderRunningState() {
  const total = state.domains.length;
  const completed = state.stats.done + state.stats.errors;
  const current = completed + 1;

  el.runningDomain.textContent = state.currentDomain || '...';
  el.runningState.textContent = STATE_LABELS[state.currentState] || 'Processing...';
  el.runningProgress.textContent = `${current} of ${total}`;

  const progress = total > 0 ? (completed / total) * 100 : 0;
  el.progressFill.style.width = `${Math.max(progress, 5)}%`;

  // Update pause button
  el.btnPause.innerHTML = state.isPaused
    ? '<span>▶</span> Resume'
    : '<span>⏸</span> Pause';
}

function renderStats() {
  el.statQueued.textContent = state.stats.queued;
  el.statActive.textContent = state.stats.active;
  el.statDone.textContent = state.stats.done;
  el.statErrors.textContent = state.stats.errors;
}

function renderDomainList() {
  if (state.domains.length === 0) {
    el.domainList.innerHTML = '';
    return;
  }

  // Sort: active first, then queued, then complete, then error
  const sorted = [...state.domains].sort((a, b) => {
    const order = { active: 0, queued: 1, complete: 2, error: 3 };
    const getOrder = (s) => ACTIVE_STATES.includes(s) ? 0 : (order[s] ?? 1);
    return getOrder(a.state) - getOrder(b.state);
  });

  el.domainList.innerHTML = sorted.map(d => {
    const stateClass = ACTIVE_STATES.includes(d.state) ? 'active' : (d.state || 'queued');
    const label = STATE_LABELS[d.state] || 'Queued';

    // Show completion checkmarks for complete domains
    const checks = d.state === 'complete' ? `
      <span class="domain-checks">
        ${d.authCode ? '✓Auth ' : ''}${d.cloudflareAdded ? '✓CF ' : ''}${d.nameservers?.cloudflare?.length ? '✓NS' : ''}
      </span>
    ` : '';

    return `
      <div class="domain-item ${stateClass}" data-domain="${escapeHtml(d.name)}" style="cursor: pointer;">
        <div style="display: flex; flex-direction: column; gap: 2px;">
          <span class="domain-name">${escapeHtml(d.name)}</span>
          ${checks}
        </div>
        <span class="domain-badge ${stateClass}">${label}</span>
      </div>
    `;
  }).join('');

  // Add click handlers for domain details
  el.domainList.querySelectorAll('.domain-item').forEach(item => {
    item.addEventListener('click', () => showDomainDetails(item.dataset.domain));
  });
}

async function showDomainDetails(domainName) {
  const details = await chrome.runtime.sendMessage({
    action: 'getDomainDetails',
    data: { domain: domainName }
  });

  if (details.error) {
    showToast('error', details.error);
    return;
  }

  const status = details.completionStatus;
  const checks = [
    status.hasAuthCode ? '✓ Auth code obtained' : '✗ Auth code missing',
    status.hasCloudflareAdded ? '✓ Added to Cloudflare' : '✗ Not in Cloudflare',
    status.hasCloudflareNameservers ? `✓ NS: ${details.nameservers?.cloudflare?.join(', ')}` : '✗ No Cloudflare NS'
  ];

  const message = `${domainName}\n${checks.join('\n')}\nState: ${details.state}`;

  // Use alert for now - could be a modal later
  alert(message);
}

// ============ Actions ============

async function importFrom(registrar) {
  showToast('info', `Opening ${registrar === 'godaddy' ? 'GoDaddy' : 'Squarespace'}...`);

  const response = await chrome.runtime.sendMessage({
    action: 'importFromRegistrar',
    data: { registrar }
  });

  if (response.error) {
    showToast('error', response.error);
  } else {
    // Close popup - the import will happen on the registrar page
    window.close();
  }
}

async function startMigration() {
  const response = await chrome.runtime.sendMessage({
    action: state.isPaused ? 'resumeMigration' : 'startMigration'
  });

  if (response.error) {
    showToast('error', response.error);
  } else {
    showToast('success', 'Migration started!');
    await refresh();
  }
}

async function togglePause() {
  const action = state.isPaused ? 'resumeMigration' : 'pauseMigration';
  await chrome.runtime.sendMessage({ action });
  await refresh();
}

async function stopMigration() {
  await chrome.runtime.sendMessage({ action: 'stopMigration' });
  showToast('info', 'Migration stopped');
  await refresh();
}

async function clearAll() {
  if (state.isRunning) {
    showToast('error', 'Stop migration before clearing');
    return;
  }

  await chrome.runtime.sendMessage({ action: 'clearAllDomains' });
  showToast('info', 'All domains cleared');
  await refresh();
}

// ============ Modal ============

function showModal() {
  el.modalDomains.value = '';
  el.modalOverlay.classList.add('visible');
  el.modalDomains.focus();
}

function hideModal() {
  el.modalOverlay.classList.remove('visible');
}

async function addManualDomains() {
  const input = el.modalDomains.value;
  const registrar = el.modalRegistrar.value;

  const domains = input.split(',')
    .map(d => d.trim().toLowerCase())
    .filter(d => d.match(/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/));

  if (domains.length === 0) {
    showToast('error', 'No valid domains entered');
    return;
  }

  hideModal();

  const response = await chrome.runtime.sendMessage({
    action: 'addDomainsToQueue',
    data: { domains, sourceRegistrar: registrar }
  });

  if (response.success) {
    showToast('success', `Added ${response.added} domain${response.added !== 1 ? 's' : ''}`);
    await refresh();
  } else {
    showToast('error', response.error || 'Failed to add domains');
  }
}

// ============ Toast Notifications ============

function showToast(type, message) {
  el.toast.className = `toast visible ${type}`;
  el.toastIcon.textContent = type === 'error' ? '⚠' : type === 'success' ? '✓' : 'ℹ';
  el.toastContent.textContent = message;

  // Auto-hide after 4 seconds
  setTimeout(hideToast, 4000);
}

function hideToast() {
  el.toast.classList.remove('visible');
}

// ============ Utilities ============

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text || '';
  return div.innerHTML;
}
