// Mock chrome APIs for browser preview (not as extension)
const MOCK_TABS = [
  { id: 1, windowId: 1, active: true, pinned: false, groupId: -1, title: 'Tab Auto Manager Preview', url: 'http://localhost:3000/preview.html', favIconUrl: '' },
  { id: 2, windowId: 1, active: false, pinned: true, groupId: -1, title: 'Gmail - Inbox', url: 'https://mail.google.com/mail/u/0/#inbox', favIconUrl: 'https://www.google.com/favicon.ico' },
  { id: 3, windowId: 1, active: false, pinned: false, groupId: -1, title: 'GitHub: Let\'s build from here', url: 'https://github.com/', favIconUrl: 'https://github.com/favicon.ico' },
  { id: 4, windowId: 1, active: false, pinned: false, groupId: -1, title: 'Stack Overflow - Where Developers Learn', url: 'https://stackoverflow.com/questions', favIconUrl: 'https://cdn.sstatic.net/Sites/stackoverflow/Img/favicon.ico' },
  { id: 5, windowId: 1, active: false, pinned: false, groupId: 1, title: 'React Documentation', url: 'https://react.dev/', favIconUrl: '' },
  { id: 6, windowId: 1, active: false, pinned: false, groupId: -1, title: 'YouTube - Trending', url: 'https://www.youtube.com/', favIconUrl: 'https://www.youtube.com/favicon.ico' },
  { id: 7, windowId: 1, active: false, pinned: false, groupId: -1, title: 'Twitter / X', url: 'https://x.com/home', favIconUrl: '' },
  { id: 8, windowId: 1, active: false, pinned: false, groupId: -1, title: 'Claude - Anthropic', url: 'https://claude.ai/new', favIconUrl: '' },
  { id: 9, windowId: 1, active: false, pinned: false, groupId: -1, title: 'MDN Web Docs', url: 'https://developer.mozilla.org/en-US/', favIconUrl: '' },
  { id: 10, windowId: 1, active: false, pinned: false, groupId: -1, title: 'Hacker News', url: 'https://news.ycombinator.com/', favIconUrl: '' },
];

const MOCK_EXPIRE_SECONDS = 5 * 60; // 5 minutes for visible spread

const mockSyncStorage = {
  expireSeconds: MOCK_EXPIRE_SECONDS,
  enabled: true,
  notifyBeforeClose: true,
  skipGroupedTabs: true,
  whitelist: ['mail.google.com'],
};

const mockLocalStorage = {
  tabActivity: {},
  tabIdToUrl: {},
  closedHistory: [
    { title: 'Reddit - Pair Programming', url: 'https://www.reddit.com/r/programming', favIconUrl: '', closedAt: Date.now() - 3600000 },
    { title: 'NPM - express', url: 'https://www.npmjs.com/package/express', favIconUrl: '', closedAt: Date.now() - 7200000 },
    { title: 'VS Code Docs', url: 'https://code.visualstudio.com/docs', favIconUrl: '', closedAt: Date.now() - 86400000 },
  ],
  notifiedUrls: {},
};

// Seed tab activity at various ages
(function seedActivity() {
  const now = Date.now();
  const expireMs = MOCK_EXPIRE_SECONDS * 1000;
  const ages = {
    'http://localhost:3000/preview.html': 0,         // active, just now
    'https://mail.google.com/mail/u/0/#inbox': 0.02, // whitelisted, almost fresh
    'https://github.com/': 0.1,                      // 10% — just opened
    'https://news.ycombinator.com/': 0.25,           // 25% — fairly recent
    'https://react.dev/': 0.3,                       // 30% — grouped
    'https://claude.ai/new': 0.5,                    // 50% — middle
    'https://developer.mozilla.org/en-US/': 0.7,     // 70% — getting old
    'https://stackoverflow.com/questions': 0.85,     // 85% — expiring soon
    'https://www.youtube.com/': 0.93,                // 93% — almost gone
    'https://x.com/home': 0.98,                      // 98% — critical
  };
  for (const [url, agePct] of Object.entries(ages)) {
    mockLocalStorage.tabActivity[url] = now - expireMs * agePct;
  }
  MOCK_TABS.forEach((t) => { mockLocalStorage.tabIdToUrl[t.id] = t.url; });
})();

// Mock chrome namespace
function mockStorageGet(store) {
  return (keysOrDefaults) => {
    const result = {};
    if (typeof keysOrDefaults === 'string') {
      result[keysOrDefaults] = store[keysOrDefaults];
    } else if (Array.isArray(keysOrDefaults)) {
      keysOrDefaults.forEach((k) => { result[k] = store[k]; });
    } else {
      for (const [k, def] of Object.entries(keysOrDefaults)) {
        result[k] = store[k] !== undefined ? store[k] : def;
      }
    }
    return Promise.resolve(result);
  };
}

window.chrome = {
  storage: {
    sync: {
      get: mockStorageGet(mockSyncStorage),
      set: (obj) => { Object.assign(mockSyncStorage, obj); return Promise.resolve(); },
      onChanged: { addListener: () => {} },
    },
    local: {
      get: mockStorageGet(mockLocalStorage),
      set: (obj) => { Object.assign(mockLocalStorage, obj); return Promise.resolve(); },
    },
  },
  tabs: {
    query: (q) => {
      let result = [...MOCK_TABS];
      if (q.active) result = result.filter((t) => t.active);
      if (q.currentWindow) result = result.filter((t) => t.windowId === 1);
      return Promise.resolve(result);
    },
    update: () => Promise.resolve(),
    remove: (id) => {
      const idx = MOCK_TABS.findIndex((t) => t.id === id);
      if (idx !== -1) {
        const url = MOCK_TABS[idx].url;
        MOCK_TABS.splice(idx, 1);
        delete mockLocalStorage.tabIdToUrl[id];
        if (!MOCK_TABS.some((t) => t.url === url)) {
          delete mockLocalStorage.tabActivity[url];
        }
      }
      return Promise.resolve();
    },
    create: (props) => { console.log('[mock] tabs.create', props.url); return Promise.resolve(); },
  },
  windows: { update: () => Promise.resolve() },
  runtime: {
    sendMessage: (msg) => {
      if (msg.action === 'keepAlive') {
        const tab = MOCK_TABS.find((t) => t.id === msg.tabId);
        if (tab) mockLocalStorage.tabActivity[tab.url] = Date.now();
      }
      if (msg.action === 'closeTab') {
        chrome.tabs.remove(msg.tabId);
      }
      return Promise.resolve({ ok: true });
    },
  },
  action: {
    setBadgeText: () => Promise.resolve(),
    setBadgeBackgroundColor: () => Promise.resolve(),
  },
};
