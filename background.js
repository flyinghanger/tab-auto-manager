const ALARM_NAME = 'tab-cleanup-check';
const BADGE_ALARM = 'badge-update';
const DEFAULT_EXPIRE_SECONDS = 3 * 24 * 60 * 60; // 3 days

// Protected URL schemes that should never be auto-closed
const PROTECTED_SCHEMES = ['chrome://', 'chrome-extension://', 'devtools://'];

// ─── Lifecycle ───────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarms();
  await reconcileTabs();
  await updateBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await setupAlarms();
  await reconcileTabs();
  await updateBadge();
});

// Rebuild tabIdToUrl mapping and recover activity timestamps by URL
async function reconcileTabs() {
  const { tabActivity = {} } = await chrome.storage.local.get('tabActivity');
  const tabs = await chrome.tabs.query({});
  const now = Date.now();

  const newTabIdToUrl = {};
  const activeUrls = new Set();

  for (const tab of tabs) {
    if (!tab.url) continue;
    newTabIdToUrl[tab.id] = tab.url;
    activeUrls.add(tab.url);
    // Only seed if no existing record for this URL
    if (!tabActivity[tab.url]) {
      tabActivity[tab.url] = now;
    }
  }

  // Clean up URLs that no longer have any open tab
  for (const url of Object.keys(tabActivity)) {
    if (!activeUrls.has(url)) {
      delete tabActivity[url];
    }
  }

  await chrome.storage.local.set({ tabActivity, tabIdToUrl: newTabIdToUrl });
}

async function setupAlarms() {
  const settings = await getSettings();
  // Use shorter check interval for short expire times (min 0.5 min for MV3)
  const checkMinutes = settings.expireSeconds < 120 ? 0.5 : 15;
  const badgeMinutes = settings.expireSeconds < 120 ? 0.5 : 5;
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: checkMinutes });
  await chrome.alarms.create(BADGE_ALARM, { periodInMinutes: badgeMinutes });
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
  const { tabActivity = {}, tabIdToUrl = {} } = await chrome.storage.local.get(['tabActivity', 'tabIdToUrl']);
  const url = tabIdToUrl[tabId];
  delete tabIdToUrl[tabId];

  if (url) {
    // Only delete URL record if no other tab has the same URL
    const sameTabs = Object.values(tabIdToUrl).filter((u) => u === url);
    if (sameTabs.length === 0) {
      delete tabActivity[url];
    }
  }

  await chrome.storage.local.set({ tabActivity, tabIdToUrl });
  await updateBadge();
});

// Also track window focus changes — the active tab in the focused window is "active"
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  const [activeTab] = await chrome.tabs.query({ active: true, windowId });
  if (activeTab) await recordActivity(activeTab.id);
});

async function recordActivity(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) return;
  const { tabActivity = {}, tabIdToUrl = {} } = await chrome.storage.local.get(['tabActivity', 'tabIdToUrl']);
  tabActivity[tab.url] = Date.now();
  tabIdToUrl[tabId] = tab.url;
  await chrome.storage.local.set({ tabActivity, tabIdToUrl });
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
  const stored = await chrome.storage.sync.get({
    expireSeconds: null,
    expireDays: null,
    enabled: true,
    whitelist: [],
    notifyBeforeClose: true,
    skipGroupedTabs: true,
  });
  // Backward compat: migrate expireDays to expireSeconds
  if (stored.expireSeconds == null) {
    stored.expireSeconds = (stored.expireDays || 3) * 24 * 60 * 60;
  }
  delete stored.expireDays;
  return stored;
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
  const expireMs = settings.expireSeconds * 1000;
  const soonMs = expireMs * 0.75;
  const now = Date.now();

  let count = 0;
  for (const tab of tabs) {
    if (tab.pinned || tab.active) continue;
    if (!tab.url || PROTECTED_SCHEMES.some((s) => tab.url.startsWith(s))) continue;
    if (isWhitelisted(tab.url, settings.whitelist)) continue;
    if (settings.skipGroupedTabs && tab.groupId !== -1) continue;
    const lastActive = tabActivity[tab.url];
    if (!lastActive) continue;
    if (now - lastActive > soonMs) count++;
  }

  await chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: count > 0 ? '#e53e3e' : '#4f46e5' });
}

// ─── Cleanup ────────────────────────────────────────────────

async function cleanupInactiveTabs() {
  const { tabActivity = {}, tabIdToUrl = {} } = await chrome.storage.local.get(['tabActivity', 'tabIdToUrl']);
  const { notifiedUrls = {} } = await chrome.storage.local.get('notifiedUrls');
  const settings = await getSettings();

  if (!settings.enabled) return;

  const expireMs = settings.expireSeconds * 1000;
  const notifyBeforeMs = Math.min(expireMs * 0.1, 60 * 60 * 1000);
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
    if (!tab.url) continue;
    if (PROTECTED_SCHEMES.some((s) => tab.url.startsWith(s))) continue;
    if (windowTabCounts[tab.windowId] <= 1) continue;
    if (isWhitelisted(tab.url, settings.whitelist)) continue;

    // Skip grouped tabs if setting enabled
    if (settings.skipGroupedTabs && tab.groupId !== -1) continue;

    const lastActive = tabActivity[tab.url];
    if (!lastActive) {
      tabActivity[tab.url] = now;
      tabIdToUrl[tab.id] = tab.url;
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
      delete tabIdToUrl[tab.id];
      // Only delete URL record if no other tab has the same URL
      const sameTabs = Object.entries(tabIdToUrl).filter(([, u]) => u === tab.url);
      if (sameTabs.length === 0) {
        delete tabActivity[tab.url];
        delete notifiedUrls[tab.url];
      }
      windowTabCounts[tab.windowId]--;
      continue;
    }

    // Tab is about to expire → notify
    if (settings.notifyBeforeClose && timeLeft <= notifyBeforeMs && !notifiedUrls[tab.url]) {
      aboutToExpire.push(tab);
      notifiedUrls[tab.url] = true;
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

  // Clean up notifiedUrls for URLs that no longer have open tabs
  const openUrls = new Set(tabs.map((t) => t.url).filter(Boolean));
  for (const url of Object.keys(notifiedUrls)) {
    if (!openUrls.has(url)) delete notifiedUrls[url];
  }

  await chrome.storage.local.set({ tabActivity, tabIdToUrl, notifiedUrls });
}

// Re-setup alarms when expire time changes
chrome.storage.sync.onChanged.addListener((changes) => {
  if (changes.expireSeconds) setupAlarms();
});

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
