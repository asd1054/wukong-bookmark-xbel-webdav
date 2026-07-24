// popup.js — 悟空书签同步 UI 层
// 所有同步逻辑委托给 sync-engine.js（共享模式：云端 XBEL 即唯一真相）

import {
  getStoredCfg, testConn,
  doSync, doExport, doImport,
  getEngineVersion
} from './sync-engine.js';

const storage = (typeof browser !== 'undefined' && browser.storage)
  ? browser.storage : chrome.storage;

const DEFAULT_URL = 'https://webdav.123pan.cn/webdav/bookmarks.xbel';

// 防连点锁
let busy = false;

// DOM 引用
const els = {
  url: document.getElementById('url'),
  user: document.getElementById('user'),
  pass: document.getElementById('pass'),
  status: document.getElementById('status'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  sync: document.getElementById('sync'),
  exp: document.getElementById('export'),
  imp: document.getElementById('import'),
};

// ── UI 辅助 ──
function setStatus(m, isSuccess = null) {
  const time = new Date().toLocaleTimeString();
  const full = `[${time}] ${m}`;
  if (els.status) {
    els.status.textContent = full;
    els.status.className = 'status';
    if (isSuccess === true) els.status.classList.add('success');
    if (isSuccess === false) els.status.classList.add('error');
  }
  console.log('%c[悟空书签]', 'color:#0066cc', full);
}

function setBtn(btn, loading, textOverride = null) {
  if (!btn) return;
  if (loading) {
    btn.dataset.old = btn.textContent;
    btn.textContent = textOverride || '处理中...';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.old || btn.textContent;
    btn.disabled = false;
  }
}

function setAllBtns(disabled) {
  [els.save, els.test, els.sync, els.exp, els.imp].forEach(b => {
    if (b) b.disabled = disabled;
  });
}

// ── 弹窗关闭保护 ──
window.addEventListener('beforeunload', (e) => {
  if (busy) {
    e.preventDefault();
    e.returnValue = '同步进行中，关闭弹窗将中断操作。确定离开吗？';
    return e.returnValue;
  }
});

// ── 读取表单配置 ──
function getFormCfg() {
  return {
    webdavUrl: els.url.value.trim(),
    webdavUser: els.user.value.trim(),
    webdavPass: els.pass.value
  };
}

// ── 保存并测试 ──
async function saveAndTest() {
  const url = els.url.value.trim();
  if (!url) {
    setStatus('❌ 请填写完整URL（必须带文件名 .xbel）', false);
    return;
  }
  await storage.local.set({
    webdavUrl: url,
    webdavUser: els.user.value.trim(),
    webdavPass: els.pass.value
  });
  setStatus('配置已保存，正在自动测试连接...', null);
  const c = getFormCfg();
  const t = await testConn(c);
  if (t.ok) {
    setStatus('✅ 配置保存成功 + 连接测试通过！', true);
  } else {
    setStatus('⚠️ 配置已保存，但连接失败：' + t.err, false);
  }
}

// ── 按钮绑定工具 ──
function bind(el, fn, label) {
  if (!el) return;
  el.addEventListener('click', async () => {
    console.log('%c[悟空书签] ' + label + ' 点击', 'color:orange');
    if (busy) {
      setStatus('⏳ 上一次操作还在进行，请等结束（保持弹窗打开）', false);
      return;
    }
    const c = getFormCfg();
    if (!c.webdavUrl) {
      setStatus('❌ 请先填写完整文件URL', false);
      return;
    }
    busy = true;
    setAllBtns(true);
    setStatus('【正在' + label + '】请保持弹窗打开...', null);
    setBtn(el, true);
    try {
      const progress = (msg) => setStatus(msg, null);
      const result = await fn(c, progress);
      setStatus(result.result, true);
    } catch (e) {
      let m = e.message || String(e);
      if (m.includes('405')) m += ' （URL必须是完整文件路径）';
      if (m.includes('412')) m = '⚠️ ' + m;
      setStatus('❌ ' + label + '失败: ' + m, false);
    } finally {
      setBtn(el, false);
      setAllBtns(false);
      busy = false;
    }
  });
}

// ── 主入口 ──
async function main() {
  console.log('%c[悟空书签] popup.js 加载 v' + getEngineVersion(), 'color:green');

  // 显示版本号
  const verEl = document.getElementById('version');
  if (verEl) verEl.textContent = 'v' + getEngineVersion();

  const cfg = await getStoredCfg();
  els.url.value = cfg.webdavUrl || DEFAULT_URL;
  if (cfg.webdavUser) els.user.value = cfg.webdavUser;
  if (cfg.webdavPass) els.pass.value = cfg.webdavPass;

  // 保存按钮
  if (els.save) {
    els.save.addEventListener('click', async () => {
      try { await saveAndTest(); }
      catch (e) { setStatus('❌ 保存失败: ' + (e.message || e), false); }
    });
  }

  // 测试按钮
  if (els.test) {
    els.test.addEventListener('click', async () => {
      const c = getFormCfg();
      if (!c.webdavUrl) { setStatus('❌ 先填URL', false); return; }
      setBtn(els.test, true);
      setStatus('正在测试连接...', null);
      const r = await testConn(c);
      setStatus(r.ok ? '✅ 测试连接正常' : '❌ 测试失败: ' + r.err, r.ok);
      setBtn(els.test, false);
    });
  }

  // ── 三个核心按钮 ──

  // 同步：拉取云端覆盖本地 → 推送本地回云端
  bind(els.sync, async (cfg, progress) => {
    return await doSync(cfg, progress);
  }, '同步');

  // 推送：本地覆盖云端（整理好文件夹后用）
  bind(els.exp, async (cfg, progress) => {
    return await doExport(cfg, progress);
  }, '推送本地到云端');

  // 拉取：云端覆盖本地（新设备初始化用）
  bind(els.imp, async (cfg, progress) => {
    return await doImport(cfg, progress);
  }, '从云端拉取');

  console.log('%c[悟空书签] 所有按钮已绑定', 'color:green');
  setStatus(
    '就绪 v' + getEngineVersion() + ' — 共享模式\n' +
    '• 日常跨设备 → 点「同步」\n' +
    '• 整理文件夹后 → 点「推送本地到云端」\n' +
    '• 新设备初始化 → 点「从云端拉取」',
    null
  );
}

main();
