const ALARM_NAME = 'tab-cleanup-check';
const BADGE_ALARM = 'badge-update';
const CHECK_INTERVAL_MINUTES = 15;
const BADGE_INTERVAL_MINUTES = 5;
const DEFAULT_EXPIRE_DAYS = 3;
const NOTIFY_BEFORE_MS = 60 * 60 * 1000; // 1 hour before closing

// Protected URL schemes that should never be auto-closed
const PROTECTED_SCHEMES = ['chrome://', 'chrome-extension://', 'devtools://'];

// ─── Lifecycle ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarms();
  // Seed existing tabs with current timestamp (don't overwrite existing records)
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  const tabs = await chrome.tabs.query({});
  const now = Date.now();
  let changed = false;
  for (const tab of tabs) {
    if (!tabActivity[tab.id]) {
      tabActivity[tab.id] = now;
      changed = true;
    }
  }
  if (changed) await chrome.storage.local.set({ tabActivity });
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarms();
  await updateBadge();
});

async function setupAlarms() {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: CHECK_INTERVAL_MINUTES });
  await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: BADGE_INTERVAL_MINUTES });
}

// ─── Activity tracking ──────────────────────────────────────

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await recordActivity(activeInfo.tabId);
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.url || changeInfo.status === 'complete') {
    await recordActivity(tabId);
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  await recordActivity(tab.id);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  delete tabActivity[tabId];
  await chrome.storage.local.set({ tabActivity });
  await updateBadge();
});

// Also track window focus changes — the active tab in the focused window is "active"
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  if (activeTab) await recordActivity(activeTab.id);
});

async function recordActivity(tabId) {
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  tabActivity[tabId] = Date.now();
  await chrome.storage.local.set({ tabActivity });
}

// ─── Alarms ─────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await cleanupInactiveTabs();
    await updateBadge();
  }
  if (alarm.name === BADGE_ALARM) {
    await updateBadge();
  }
});

// ─── Settings helpers ───────────────────────────────────────

async function getSettings() {
  const defaults = {
    expireDays: DEFAULT_EXPIRE_DAYS,
    enabled: true,
    whitelist: [],
    notifyBeforeClose: true,
    skipGroupedTabs: true,
  };
  const stored = await chrome.storage.sync.get(Object.keys(defaults));
  return { ...defaults, ...stored };
}

function isWhitelisted(url, whitelist) {
  if (!url) return false;
  try {
    const hostname = new URL(url).hostname;
    return whitelist.some((pattern) => {
      // Support wildcards: "*.github.com" matches "gist.github.com"
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

// ─── Badge ──────────────────────────────────────────────────

async function updateBadge() {
  const settings = await getSettings();
  if (!settings.enabled) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }

  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  const tabs = await chrome.tabs.query({});
  const expireMs = settings.expireDays * 24 * 60 * 60 * 1000;
  const soonMs = expireMs * 0.75;
  const now = Date.now();

  let count = 0;
  for (const tab of tabs) {
    if (tab.pinned || tab.active) continue;
    const lastActive = tabActivity[tab.id];
    if (!lastActive) continue;
    if (now - lastActive > soonMs) count++;
  }

  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#e53e3e' : '#4f46e5' });
}

// ─── Cleanup ────────────────────────────────────────────────

async function cleanupInactiveTabs() {
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  const { notifiedTabs = {} } = await chrome.storage.local.get('notifiedTabs');
  const settings = await getSettings();

  if (!settings.enabled) return;

  const expireMs = settings.expireDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const tabs = await chrome.tabs.query({});

  // Never close the last tab in a window
  const windowTabCounts = {};
  for (const tab of tabs) {
    windowTabCounts[tab.windowId] = (windowTabCounts[tab.windowId] || 0) + 1;
  }

  const closedTabs = [];
  const aboutToExpire = [];

  for (const tab of tabs) {
    if (tab.pinned) continue;
    if (tab.active) continue;
    if (PROTECTED_SCHEMES.some((s) => tab.url?.startsWith(s))) continue;
    if (windowTabCounts[tab.windowId] <= 1) continue;
    if (isWhitelisted(tab.url, settings.whitelist)) continue;

    // Skip grouped tabs if setting enabled
    if (settings.skipGroupedTabs && tab.groupId !== -1) continue;

    const lastActive = tabActivity[tab.id];
    if (!lastActive) {
      tabActivity[tab.id] = now;
      continue;
    }

    const elapsed = now - lastActive;
    const timeLeft = expireMs - elapsed;

    // Tab has expired → close it
    if (timeLeft <= 0) {
      closedTabs.push({
        title: tab.title,
        url: tab.url,
        favIconUrl: tab.favIconUrl,
        closedAt: now,
      });
      await chrome.tabs.remove(tab.id);
      delete tabActivity[tab.id];
      delete notifiedTabs[tab.id];
      windowTabCounts[tab.windowId]--;
      continue;
    }

    // Tab is about to expire → notify
    if (settings.notifyBeforeClose && timeLeft <= NOTIFY_BEFORE_MS && !notifiedTabs[tab.id]) {
      aboutToExpire.push(tab);
      notifiedTabs[tab.id] = true;
    }
  }

  // Send notification for tabs about to expire
  if (aboutToExpire.length > 0) {
    const titles = aboutToExpire
      .slice(0, 3)
      .map((t) => t.title?.slice(0, 40) || 'Untitled')
      .join('\n');
    const extra = aboutToExpire.length > 3 ? `\n...and ${aboutToExpire.length - 3} more` : '';
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${aboutToExpire.length} tab(s) closing soon`,
      message: titles + extra,
    });
  }

  // Save closed tabs history (keep last 200)
  if (closedTabs.length > 0) {
    const { closedHistory = [] } = await chrome.storage.local.get('closedHistory');
    const updated = [...closedTabs, ...closedHistory].slice(0, 200);
    await chrome.storage.local.set({ closedHistory: updated });
  }

  // Clean up notifiedTabs for tabs that no longer exist
  const tabIds = new Set(tabs.map((t) => t.id));
  for (const id of Object.keys(notifiedTabs)) {
    if (!tabIds.has(Number(id))) delete notifiedTabs[id];
  }

  await chrome.storage.local.set({ tabActivity, notifiedTabs });
}

// ─── Message handler (for popup communication) ─────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === 'keepAlive') {
    recordActivity(msg.tabId).then(() => {
      updateBadge();
      sendResponse({ ok: true });
    });
    return true; // async response
  }
  if (msg.action === 'closeTab') {
    chrome.tabs.remove(msg.tabId).then(() => {
      updateBadge();
      sendResponse({ ok: true });
    });
    return true;
  }
  if (msg.action === 'runCleanup') {
    cleanupInactiveTabs().then(() => {
      updateBadge();
      sendResponse({ ok: true });
    });
    return true;
  }
});
