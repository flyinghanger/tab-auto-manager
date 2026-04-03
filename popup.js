const DEFAULT_EXPIRE_SECONDS = 3 * 24 * 60 * 60; // 3 days
const PROTECTED_SCHEMES = ['chrome://', 'chrome-extension://', 'devtools://'];
let refreshTimer = null;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

async function init() {
  await Promise.all([loadSettings(), loadStats(), loadWhitelist()]);
  setupListeners();
  startAutoRefresh();
}

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(loadStats, 1000);
}

// ─── Settings ───────────────────────────────────────────────

async function loadSettings() {
  const settings = await chrome.storage.sync.get({
    expireSeconds: null,
    expireDays: null,
    enabled: true,
    notifyBeforeClose: true,
    skipGroupedTabs: true,
  });

  // Backward compat
  let expireSeconds = settings.expireSeconds;
  if (expireSeconds == null) {
    expireSeconds = (settings.expireDays || 3) * 86400;
  }

  document.getElementById('enableToggle').checked = settings.enabled;
  document.getElementById('notifyToggle').checked = settings.notifyBeforeClose;
  document.getElementById('skipGroupToggle').checked = settings.skipGroupedTabs;

  // Highlight matching preset or fill custom input
  let matchedPreset = false;
  document.querySelectorAll('.day-btn').forEach((btn) => {
    const match = Number(btn.dataset.seconds) === expireSeconds;
    btn.classList.toggle('active', match);
    if (match) matchedPreset = true;
  });

  const customValue = document.getElementById('customValue');
  const customUnit = document.getElementById('customUnit');
  if (!matchedPreset) {
    // Find best unit to display
    const unit = getBestUnit(expireSeconds);
    customUnit.value = String(unit);
    customValue.value = expireSeconds / unit;
  } else {
    customValue.value = '';
  }
}

function getBestUnit(seconds) {
  if (seconds >= 86400 && seconds % 86400 === 0) return 86400;
  if (seconds >= 3600 && seconds % 3600 === 0) return 3600;
  if (seconds >= 60 && seconds % 60 === 0) return 60;
  return 1;
}

function isWhitelisted(url, whitelist) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return whitelist.some((pattern) => {
      if (pattern.startsWith('*.')) {
        const domain = pattern.slice(2);
        return hostname === domain || hostname.endsWith('.' + domain);
      }
      return hostname === pattern || hostname === 'www.' + pattern;
    });
  } catch {
    return false;
  }
}

// ─── Stats & Tab Lists ─────────────────────────────────────

async function loadStats() {
  const [{ tabActivity = {}, closedHistory = [] }, syncData] =
    await Promise.all([
      chrome.storage.local.get(['tabActivity', 'closedHistory']),
      chrome.storage.sync.get({ expireSeconds: null, expireDays: null, whitelist: [], skipGroupedTabs: true }),
    ]);
  const whitelist = syncData.whitelist || [];
  const skipGrouped = syncData.skipGroupedTabs !== false;

  const expireSeconds = syncData.expireSeconds ?? (syncData.expireDays || 3) * 86400;
  const tabs = await chrome.tabs.query({});
  const expireMs = expireSeconds * 1000;
  const soonMs = expireMs * 0.75;
  const now = Date.now();

  const expiringTabs = [];

  for (const tab of tabs) {
    if (tab.pinned || tab.active) continue;
    if (!tab.url || PROTECTED_SCHEMES.some((s) => tab.url.startsWith(s))) continue;
    if (isWhitelisted(tab.url, whitelist)) continue;
    if (skipGrouped && tab.groupId !== -1) continue;
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

  const userTabs = tabs.filter((t) => t.url && !PROTECTED_SCHEMES.some((s) => t.url.startsWith(s)));

  // Build expiry info map by tab id
  const expiryMap = {};
  for (const et of expiringTabs) {
    expiryMap[et.id] = et;
  }

  document.getElementById('totalTabs').textContent = userTabs.length;
  document.getElementById('expiringSoon').textContent = expiringTabs.length;
  document.getElementById('totalClosed').textContent = closedHistory.length;

  // Deduplicate history by URL, keeping the most recent entry
  const seenUrls = new Set();
  const dedupedHistory = closedHistory.filter((item) => {
    if (seenUrls.has(item.url)) return false;
    seenUrls.add(item.url);
    return true;
  });

  renderAllTabs(userTabs, expiryMap);
  renderHistory(dedupedHistory);
}

function renderAllTabs(tabs, expiryMap) {
  const list = document.getElementById('allTabsList');
  if (tabs.length === 0) {
    list.innerHTML = '<div class="empty-state">No open tabs</div>';
    return;
  }

  list.innerHTML = '';
  for (const tab of tabs) {
    const expiry = expiryMap[tab.id];
    const isCritical = expiry && expiry.timeLeft < expiry.expireMs * 0.1;

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
    const badges = [];
    if (tab.active) badges.push('active');
    if (tab.pinned) badges.push('pinned');
    if (tab.groupId !== -1) badges.push('grouped');
    try { badges.push(new URL(tab.url).hostname); } catch {}
    if (expiry) {
      badges.push(formatTimeLeft(expiry.timeLeft, expiry.expireMs));
    }
    meta.textContent = badges.join(' · ');

    info.append(title, meta);

    // Show progress bar for expiring tabs
    if (expiry) {
      const pct = Math.max(0, Math.min(100, (expiry.timeLeft / expiry.expireMs) * 100));
      const progressClass = pct < 10 ? 'progress-danger' : pct < 25 ? 'progress-warn' : 'progress-safe';
      const progress = document.createElement('div');
      progress.className = 'progress-bar';
      const fill = document.createElement('div');
      fill.className = `progress-fill ${progressClass}`;
      fill.style.width = `${pct}%`;
      progress.appendChild(fill);
      info.appendChild(progress);
    }

    const actions = document.createElement('div');
    actions.className = 'tab-actions';

    if (expiry) {
      const keepBtn = document.createElement('button');
      keepBtn.className = 'btn-sm';
      keepBtn.textContent = 'Keep';
      keepBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await chrome.runtime.sendMessage({ action: 'keepAlive', tabId: tab.id });
        await loadStats();
      });
      actions.appendChild(keepBtn);
    }

    if (!tab.active) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'btn-sm btn-danger';
      closeBtn.textContent = 'Close';
      closeBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await chrome.tabs.remove(tab.id);
        await loadStats();
      });
      actions.appendChild(closeBtn);
    }

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

  // Preset buttons
  document.querySelectorAll('.day-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const seconds = Number(btn.dataset.seconds);
      await chrome.storage.sync.set({ expireSeconds: seconds });
      document.querySelectorAll('.day-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('customValue').value = '';
      await loadStats();
    });
  });

  // Custom time input — only apply on button click
  document.getElementById('customApply').addEventListener('click', async () => {
    const val = Number(document.getElementById('customValue').value);
    if (!val || val <= 0) return;
    const seconds = val * Number(document.getElementById('customUnit').value);
    await chrome.storage.sync.set({ expireSeconds: seconds });
    document.querySelectorAll('.day-btn').forEach((b) => b.classList.remove('active'));
    await loadStats();
  });

  // Tab navigation
  const sections = { allTabs: 'allTabsSection', history: 'historySection', whitelist: 'whitelistSection' };
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

  // Quick-add current tab's domain
  document.getElementById('wlAddCurrent').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    try {
      const hostname = new URL(tab.url).hostname;
      if (!hostname) return;
      const { whitelist = [] } = await chrome.storage.sync.get('whitelist');
      if (whitelist.includes(hostname)) return;
      const updated = [...whitelist, hostname];
      await chrome.storage.sync.set({ whitelist: updated });
      renderWhitelist(updated);
      await loadStats();
    } catch {}
  });
}

// ─── Formatters ─────────────────────────────────────────────

function formatTimeLeft(ms, expireMs) {
  if (ms <= 0) return 'Closing soon...';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  // Only show seconds when in the critical zone (last 10% of expire time)
  const critical = expireMs ? ms < expireMs * 0.1 : minutes === 0;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${minutes}m left`;
  if (minutes > 0 && !critical) return `${minutes}m left`;
  if (minutes > 0) return `${minutes}m ${seconds}s left`;
  return `${seconds}s left`;
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
