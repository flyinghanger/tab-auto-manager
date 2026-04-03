const DEFAULT_EXPIRE_DAYS = 3;

document.addEventListener('DOMContentLoaded', init);

async function init() {
  await loadSettings();
  await loadStats();
  await loadWhitelist();
  setupListeners();
}

// ─── Settings ───────────────────────────────────────────────

async function loadSettings() {
  const { expireDays = DEFAULT_EXPIRE_DAYS } = await chrome.storage.sync.get('expireDays');
  const { enabled = true } = await chrome.storage.sync.get('enabled');
  const { notifyBeforeClose = true } = await chrome.storage.sync.get('notifyBeforeClose');
  const { skipGroupedTabs = true } = await chrome.storage.sync.get('skipGroupedTabs');

  document.getElementById('enableToggle').checked = enabled;
  document.getElementById('notifyToggle').checked = notifyBeforeClose;
  document.getElementById('skipGroupToggle').checked = skipGroupedTabs;

  document.querySelectorAll('.day-btn').forEach((btn) => {
    btn.classList.toggle('active', Number(btn.dataset.days) === expireDays);
  });
}

// ─── Stats & Tab Lists ─────────────────────────────────────

async function loadStats() {
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  const { closedHistory = [] } = await chrome.storage.local.get('closedHistory');
  const { expireDays = DEFAULT_EXPIRE_DAYS } = await chrome.storage.sync.get('expireDays');

  const tabs = await chrome.tabs.query({});
  const expireMs = expireDays * 24 * 60 * 60 * 1000;
  const soonMs = expireMs * 0.75;
  const now = Date.now();

  const expiringTabs = [];

  for (const tab of tabs) {
    if (tab.pinned || tab.active) continue;
    const lastActive = tabActivity[tab.url];
    if (!lastActive) continue;

    const elapsed = now - lastActive;
    if (elapsed > soonMs) {
      expiringTabs.push({
        id: tab.id,
        windowId: tab.windowId,
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        timeLeft: expireMs - elapsed,
        elapsed,
        expireMs,
      });
    }
  }

  expiringTabs.sort((a, b) => a.timeLeft - b.timeLeft);

  document.getElementById('totalTabs').textContent = tabs.length;
  document.getElementById('expiringSoon').textContent = expiringTabs.length;
  document.getElementById('totalClosed').textContent = closedHistory.length;

  renderExpiringTabs(expiringTabs);
  renderHistory(closedHistory);
}

function renderExpiringTabs(tabs) {
  const list = document.getElementById('expiringList');
  if (tabs.length === 0) {
    list.innerHTML = '<div class="empty-state">No tabs expiring soon</div>';
    return;
  }

  list.innerHTML = '';
  for (const tab of tabs) {
    const isCritical = tab.timeLeft < 60 * 60 * 1000;
    const pct = Math.max(0, Math.min(100, (tab.timeLeft / tab.expireMs) * 100));
    const progressClass = pct < 10 ? 'progress-danger' : pct < 25 ? 'progress-warn' : 'progress-safe';

    const item = document.createElement('div');
    item.className = `tab-item tab-item-clickable ${isCritical ? 'tab-expire-soon' : ''}`;

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = tab.favIconUrl || 'icons/icon16.png';
    favicon.onerror = () => { favicon.src = 'icons/icon16.png'; };

    const info = document.createElement('div');
    info.className = 'tab-info';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.title = tab.title || '';
    title.textContent = tab.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    meta.textContent = formatTimeLeft(tab.timeLeft);

    const progress = document.createElement('div');
    progress.className = 'progress-bar';
    const fill = document.createElement('div');
    fill.className = `progress-fill ${progressClass}`;
    fill.style.width = `${pct}%`;
    progress.appendChild(fill);

    info.append(title, meta, progress);

    const actions = document.createElement('div');
    actions.className = 'tab-actions';

    const keepBtn = document.createElement('button');
    keepBtn.className = 'btn-sm';
    keepBtn.textContent = 'Keep';
    keepBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ action: 'keepAlive', tabId: tab.id });
      await loadStats();
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn-sm btn-danger';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await chrome.runtime.sendMessage({ action: 'closeTab', tabId: tab.id });
      await loadStats();
    });

    actions.append(keepBtn, closeBtn);

    // Click the row to navigate to that tab
    item.addEventListener('click', () => {
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    });

    item.append(favicon, info, actions);
    list.appendChild(item);
  }
}

function renderHistory(history) {
  const list = document.getElementById('historyList');
  if (history.length === 0) {
    list.innerHTML = '<div class="empty-state">No tabs have been auto-closed yet</div>';
    return;
  }

  list.innerHTML = '';
  for (const item of history) {
    const row = document.createElement('div');
    row.className = 'tab-item';

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = item.favIconUrl || 'icons/icon16.png';
    favicon.onerror = () => { favicon.src = 'icons/icon16.png'; };

    const info = document.createElement('div');
    info.className = 'tab-info';

    const title = document.createElement('div');
    title.className = 'tab-title';
    title.title = item.title || '';
    title.textContent = item.title || 'Untitled';

    const meta = document.createElement('div');
    meta.className = 'tab-meta';
    meta.textContent = formatTimeAgo(item.closedAt);

    info.append(title, meta);

    const actions = document.createElement('div');
    actions.className = 'tab-actions';

    const restoreBtn = document.createElement('button');
    restoreBtn.className = 'btn-sm';
    restoreBtn.textContent = 'Restore';
    restoreBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: item.url });
    });

    actions.appendChild(restoreBtn);
    row.append(favicon, info, actions);
    list.appendChild(row);
  }
}

// ─── Whitelist ──────────────────────────────────────────────

async function loadWhitelist() {
  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  renderWhitelist(whitelist);
}

function renderWhitelist(whitelist) {
  const container = document.getElementById('wlTags');
  container.innerHTML = '';
  for (const domain of whitelist) {
    const tag = document.createElement('span');
    tag.className = 'wl-tag';
    tag.textContent = domain;

    const removeBtn = document.createElement('button');
    removeBtn.className = 'wl-tag-remove';
    removeBtn.textContent = '\u00d7';
    removeBtn.addEventListener('click', async () => {
      const { whitelist: current = [] } = await chrome.storage.sync.get('whitelist');
      const updated = current.filter((d) => d !== domain);
      await chrome.storage.sync.set({ whitelist: updated });
      renderWhitelist(updated);
    });

    tag.appendChild(removeBtn);
    container.appendChild(tag);
  }
}

async function addWhitelistDomain() {
  const input = document.getElementById('wlInput');
  let domain = input.value.trim().toLowerCase();
  if (!domain) return;

  // Strip protocol and path
  domain = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');

  const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
  if (whitelist.includes(domain)) {
    input.value = '';
    return;
  }

  const updated = [...whitelist, domain];
  await chrome.storage.sync.set({ whitelist: updated });
  renderWhitelist(updated);
  input.value = '';
}

// ─── Event listeners ────────────────────────────────────────

function setupListeners() {
  // Enable toggle
  document.getElementById('enableToggle').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ enabled: e.target.checked });
  });

  // Notify toggle
  document.getElementById('notifyToggle').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ notifyBeforeClose: e.target.checked });
  });

  // Skip grouped tabs toggle
  document.getElementById('skipGroupToggle').addEventListener('change', async (e) => {
    await chrome.storage.sync.set({ skipGroupedTabs: e.target.checked });
  });

  // Day selector
  document.querySelectorAll('.day-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const days = Number(btn.dataset.days);
      await chrome.storage.sync.set({ expireDays: days });
      document.querySelectorAll('.day-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      await loadStats();
    });
  });

  // Tab navigation
  const sections = { expiring: 'expiringSection', history: 'historySection', whitelist: 'whitelistSection' };
  document.querySelectorAll('.tabs-nav button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tabs-nav button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const active = btn.dataset.tab;
      for (const [key, id] of Object.entries(sections)) {
        document.getElementById(id).style.display = key === active ? '' : 'none';
      }
    });
  });

  // Whitelist add
  document.getElementById('wlAdd').addEventListener('click', addWhitelistDomain);
  document.getElementById('wlInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addWhitelistDomain();
  });
}

// ─── Formatters ─────────────────────────────────────────────

function formatTimeLeft(ms) {
  if (ms <= 0) return 'Closing soon...';
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h left`;
  if (hours > 0) return `${hours}h left`;
  const minutes = Math.floor(ms / (1000 * 60));
  return `${minutes}m left`;
}

function formatTimeAgo(timestamp) {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}
