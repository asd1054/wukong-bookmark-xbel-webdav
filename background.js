// background.js — 悟空书签同步 后台服务 v0.6
// 定时自动同步 + 书签变更监听 + badge 徽章 + 状态记录（共享模式）

import {
  getStoredCfg, doSync,
  LAST_SYNC_KEY, LAST_SYNC_STATUS_KEY, SYNC_LOG_KEY,
  getEngineVersion,
  bookmarksApi, storageApi
} from './sync-engine.js';

const bgStorage = chrome.storage || storageApi;
const bookmarks = bookmarksApi || chrome.bookmarks;

// ── 未同步计数 + Badge ──
let pendingChanges = 0;
let syncDebounceTimer = null;
const SYNC_DEBOUNCE_MS = 5000; // 变更后 5 秒触发同步

function incrementPending() {
  pendingChanges++;
  updateBadge();
}

function resetPending() {
  pendingChanges = 0;
  updateBadge();
}

function updateBadge() {
  if (!chrome.action || !chrome.action.setBadgeText) return;
  if (pendingChanges > 0) {
    chrome.action.setBadgeText({ text: String(Math.min(pendingChanges, 99)) });
    chrome.action.setBadgeBackgroundColor({ color: '#f44336' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── 书签变更监听 ──
function setupBookmarkListeners() {
  if (!bookmarks || !bookmarks.onCreated) return;

  bookmarks.onCreated.addListener((id, node) => {
    incrementPending();
    console.log('[悟空书签] 检测到新书签:', node.title);
    scheduleDebouncedSync();
  });

  bookmarks.onChanged.addListener((id, changeInfo) => {
    incrementPending();
    console.log('[悟空书签] 检测到书签变更:', id);
    scheduleDebouncedSync();
  });

  bookmarks.onMoved.addListener((id, moveInfo) => {
    incrementPending();
    console.log('[悟空书签] 检测到书签移动:', id);
    scheduleDebouncedSync();
  });

  bookmarks.onRemoved.addListener((id, removeInfo) => {
    incrementPending();
    console.log('[悟空书签] 检测到书签删除:', id);
    scheduleDebouncedSync();
  });

  // 批量操作时可能触发 childrenReordered 而不触发单个变更
  bookmarks.onChildrenReordered?.addListener((id, reorderInfo) => {
    incrementPending();
    console.log('[悟空书签] 检测到书签排序变更');
    scheduleDebouncedSync();
  });

  console.log('[悟空书签] 书签变更监听已就绪');
}

function scheduleDebouncedSync() {
  if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
  syncDebounceTimer = setTimeout(() => {
    console.log('[悟空书签] 防抖时间到，触发自动同步...');
    runBackgroundSync();
  }, SYNC_DEBOUNCE_MS);
}

// ── 安装时注册定时任务 ──
chrome.runtime.onInstalled.addListener((details) => {
  console.log(`[悟空书签 v${getEngineVersion()}] 扩展已安装/更新 (reason: ${details.reason})`);

  chrome.alarms.clear('sync', () => {
    chrome.alarms.create('sync', { periodInMinutes: 60 });
    console.log('[悟空书签] 定时同步已注册（每 60 分钟）');
  });

  if (details.reason === 'install') {
    bgStorage.local.set({
      [LAST_SYNC_STATUS_KEY]: 'never',
      [SYNC_LOG_KEY]: []
    });
  }

  resetPending();
});

// 浏览器启动时确保 alarm 存在 + 注册监听
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get('sync', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('sync', { periodInMinutes: 60 });
      console.log('[悟空书签] 启动时重新注册定时同步');
    }
  });
  resetPending();
});

// ── 同步日志记录 ──
async function appendLog(entry) {
  const { [SYNC_LOG_KEY]: log } = await bgStorage.local.get([SYNC_LOG_KEY]);
  const entries = (log || []).slice(-49);
  entries.push({ ...entry, time: Date.now() });
  await bgStorage.local.set({ [SYNC_LOG_KEY]: entries });
}

// ── 执行后台同步 ──
async function runBackgroundSync() {
  console.log('[悟空书签] 后台同步触发...');

  const cfg = await getStoredCfg();
  if (!cfg.webdavUrl || !cfg.webdavUser) {
    console.log('[悟空书签] 未配置 WebDAV，跳过自动同步');
    await bgStorage.local.set({ [LAST_SYNC_STATUS_KEY]: 'unconfigured' });
    resetPending();
    return;
  }

  try {
    console.log('[悟空书签] 开始后台同步...');
    const result = await doSync(
      {
        webdavUrl: cfg.webdavUrl,
        webdavUser: cfg.webdavUser,
        webdavPass: cfg.webdavPass,
        encPass: cfg.encPass,
        scopeParentId: cfg.scopeParentId
      },
      (msg) => console.log('[悟空书签 后台]', msg)
    );

    console.log('[悟空书签] 后台同步完成:', result.result.split('\n')[0]);
    await bgStorage.local.set({
      [LAST_SYNC_KEY]: Date.now(),
      [LAST_SYNC_STATUS_KEY]: 'ok'
    });
    await appendLog({ status: 'ok', summary: result.result.split('\n')[0] });
    resetPending();
  } catch (e) {
    console.error('[悟空书签] 后台同步失败:', e.message);
    await bgStorage.local.set({
      [LAST_SYNC_KEY]: Date.now(),
      [LAST_SYNC_STATUS_KEY]: 'error'
    });
    await appendLog({ status: 'error', error: e.message });
    // 失败时保留 pending 计数，提醒用户手动同步
  }
}

// ── Alarm 监听 ──
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'sync') {
    return runBackgroundSync();
  }
});

// ── 消息监听 ──
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'triggerSync') {
    runBackgroundSync().then(() => sendResponse({ status: 'triggered' }))
      .catch((e) => sendResponse({ status: 'error', error: e.message }));
    return true;
  }

  if (message.action === 'getSyncStatus') {
    bgStorage.local.get([LAST_SYNC_KEY, LAST_SYNC_STATUS_KEY, SYNC_LOG_KEY])
      .then((data) => {
        sendResponse({ ...data, pendingChanges });
      });
    return true;
  }

  if (message.action === 'resetPending') {
    resetPending();
    sendResponse({ ok: true });
    return true;
  }
});

// ── 启动 ──
setupBookmarkListeners();
console.log(`[悟空书签 v${getEngineVersion()}] 后台 Service Worker 已启动`);
