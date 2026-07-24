// background.js — 悟空书签同步 后台服务
// 定时自动同步 + 状态记录（共享模式）

import {
  getStoredCfg, doSync, doPull,
  LAST_SYNC_KEY, LAST_SYNC_STATUS_KEY,
  getEngineVersion
} from './sync-engine.js';

const bgStorage = chrome.storage;
const SYNC_LOG_KEY = 'wukong_sync_log';

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
});

// 浏览器启动时确保 alarm 存在
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.get('sync', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('sync', { periodInMinutes: 60 });
      console.log('[悟空书签] 启动时重新注册定时同步');
    }
  });
});

// ── 同步日志记录 ──
async function appendLog(entry) {
  const { [SYNC_LOG_KEY]: log } = await bgStorage.local.get([SYNC_LOG_KEY]);
  const entries = (log || []).slice(-49); // 保留最近 50 条
  entries.push({ ...entry, time: Date.now() });
  await bgStorage.local.set({ [SYNC_LOG_KEY]: entries });
}

// ── 执行后台同步 ──
async function runBackgroundSync() {
  console.log('[悟空书签] 后台定时同步触发...');

  const cfg = await getStoredCfg();
  if (!cfg.webdavUrl || !cfg.webdavUser) {
    console.log('[悟空书签] 未配置 WebDAV，跳过自动同步');
    await bgStorage.local.set({ [LAST_SYNC_STATUS_KEY]: 'unconfigured' });
    return;
  }

  try {
    console.log('[悟空书签] 开始后台同步...');
    const result = await doSync(
      { webdavUrl: cfg.webdavUrl, webdavUser: cfg.webdavUser, webdavPass: cfg.webdavPass },
      (msg) => console.log('[悟空书签 后台]', msg)
    );

    console.log('[悟空书签] 后台同步完成:', result.result.split('\n')[0]);
    await bgStorage.local.set({
      [LAST_SYNC_KEY]: Date.now(),
      [LAST_SYNC_STATUS_KEY]: 'ok'
    });
    await appendLog({
      status: 'ok',
      summary: result.result.split('\n')[0]
    });
  } catch (e) {
    console.error('[悟空书签] 后台同步失败:', e.message);
    await bgStorage.local.set({
      [LAST_SYNC_KEY]: Date.now(),
      [LAST_SYNC_STATUS_KEY]: 'error'
    });
    await appendLog({
      status: 'error',
      error: e.message
    });
  }
}

// ── Alarm 监听：返回 Promise 确保 SW 不被提前终止 ──
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
      .then((data) => sendResponse(data));
    return true;
  }
});

console.log(`[悟空书签 v${getEngineVersion()}] 后台 Service Worker 已启动`);
