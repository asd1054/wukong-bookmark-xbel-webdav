// popup.js — 悟空书签同步 UI 层 v0.6
// 所有同步逻辑委托给 sync-engine.js（共享模式：云端 XBEL 即唯一真相）

import {
  getStoredCfg, testConn,
  doSync, doPull,
  getEngineVersion
} from './sync-engine.js';

const storage = (typeof browser !== 'undefined' && browser.storage)
  ? browser.storage : chrome.storage;

const DEFAULT_URL = 'https://webdav.123pan.cn/webdav/bookmarks.xbel';

// ── 状态 ──
let busy = false;
let currentLang = 'zh_CN';

// DOM 引用
const els = {};
function cacheEls() {
  els.url = document.getElementById('url');
  els.user = document.getElementById('user');
  els.pass = document.getElementById('pass');
  els.encPass = document.getElementById('encPass');
  els.scope = document.getElementById('scope');
  els.status = document.getElementById('status');
  els.save = document.getElementById('save');
  els.test = document.getElementById('test');
  els.sync = document.getElementById('sync');
  els.pull = document.getElementById('pull');
  els.exportCfg = document.getElementById('exportCfg');
  els.importCfg = document.getElementById('importCfg');
  els.langSwitch = document.getElementById('langSwitch');
  els.extTitle = document.getElementById('extTitle');
}

// ── i18n ──
function t(key) {
  try { return chrome.i18n.getMessage(key) || key; }
  catch { return key; }
}

function applyI18n() {
  document.title = t('extName');
  if (els.extTitle) els.extTitle.textContent = t('extName');

  // data-i18n 属性
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });

  // data-i18n-placeholder 属性
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });

  // lang switch button
  if (els.langSwitch) {
    els.langSwitch.textContent = currentLang === 'zh_CN' ? 'EN' : '中文';
    els.langSwitch.title = currentLang === 'zh_CN' ? 'Switch to English' : '切换到中文';
  }
}

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
    btn.textContent = textOverride || '...';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.old || btn.textContent;
    btn.disabled = false;
  }
}

function setAllBtns(disabled) {
  [els.save, els.test, els.sync, els.pull, els.exportCfg, els.importCfg].forEach(b => {
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
    webdavPass: els.pass.value,
    encPass: els.encPass ? els.encPass.value : '',
    scopeParentId: els.scope ? (els.scope.value || '') : '',
    scopeTitle: els.scope ? els.scope.options[els.scope.selectedIndex]?.text || '' : ''
  };
}

// ── 同步范围：加载顶层书签文件夹 ──
async function loadScopeOptions() {
  if (!els.scope) return;
  try {
    const bookmarks = chrome.bookmarks;
    const roots = await new Promise((resolve) => {
      bookmarks.getTree((tree) => resolve(tree));
    });

    // 收集所有顶层文件夹（排除系统空容器）
    const folders = [];
    function collect(node, depth) {
      if (node.children) {
        for (const child of node.children) {
          if (!child.url) {
            folders.push({ id: child.id, title: child.title || '(Untitled)', depth });
            collect(child, depth + 1);
          }
        }
      }
    }
    collect(tree[0], 0);

    // 重建 select option
    els.scope.innerHTML = `<option value="">${t('optionAll')}</option>`;
    for (const f of folders) {
      const prefix = '  '.repeat(f.depth);
      els.scope.innerHTML += `<option value="${f.id}">${prefix}📁 ${f.title}</option>`;
    }
  } catch (e) {
    console.warn('[悟空书签] 加载同步范围失败:', e);
  }
}

// ── 保存并测试 ──
async function saveAndTest() {
  const url = els.url.value.trim();
  if (!url) {
    setStatus('❌ ' + (currentLang === 'en' ? 'Please fill in the full URL (.xbel file)' : '请填写完整URL（必须带文件名 .xbel）'), false);
    return;
  }
  const cfg = getFormCfg();
  await storage.local.set({
    webdavUrl: url,
    webdavUser: cfg.webdavUser,
    webdavPass: cfg.webdavPass,
    encPass: cfg.encPass,
    scopeParentId: cfg.scopeParentId,
    scopeTitle: cfg.scopeTitle
  });
  setStatus(currentLang === 'en' ? 'Config saved. Testing connection...' : '配置已保存，正在自动测试连接...', null);
  const t = await testConn(cfg);
  if (t.ok) {
    setStatus(currentLang === 'en' ? '✅ Config saved + connection OK!' : '✅ 配置保存成功 + 连接测试通过！', true);
  } else {
    setStatus((currentLang === 'en' ? '⚠️ Config saved, but connection failed: ' : '⚠️ 配置已保存，但连接失败：') + t.err, false);
  }
}

// ── 配置导出 ──
async function exportConfig() {
  const cfg = await getStoredCfg();
  // 不导出密码，只导出 URL 和用户名
  const exportData = {
    version: getEngineVersion(),
    exportedAt: new Date().toISOString(),
    url: cfg.webdavUrl,
    user: cfg.webdavUser,
    hasEncPass: !!cfg.encPass,
    scopeParentId: cfg.scopeParentId || '',
    scopeTitle: cfg.scopeTitle || ''
  };
  const json = JSON.stringify(exportData, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'wukong-bookmark-config.json';
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(
    (currentLang === 'en'
      ? '✅ Config exported (password NOT included)\n→ Save this file, import on other browsers'
      : '✅ 配置已导出（不含密码）\n→ 保存此文件，在其他浏览器上导入'),
    true
  );
}

// ── 配置导入 ──
async function importConfig() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!data.url) throw new Error('Invalid config file');

      els.url.value = data.url || '';
      if (data.user) els.user.value = data.user;
      // 密码和加密密码不导入（需要用户手动输入）
      if (data.scopeParentId) {
        await loadScopeOptions();
        setTimeout(() => { if (els.scope && data.scopeParentId) els.scope.value = data.scopeParentId; }, 200);
      }

      setStatus(
        (currentLang === 'en'
          ? '✅ Config imported!\n→ Please enter your WebDAV password and encryption password'
          : '✅ 配置已导入！\n→ 请手动输入 WebDAV 密码和加密密码'),
        true
      );
    } catch (err) {
      setStatus(
        (currentLang === 'en' ? '❌ Invalid config file: ' : '❌ 配置文件无效：') + err.message,
        false
      );
    }
  };
  input.click();
}

// ── 按钮绑定工具 ──
function bind(el, fn, label) {
  if (!el) return;
  el.addEventListener('click', async () => {
    if (busy) {
      setStatus('⏳ ' + (currentLang === 'en' ? 'Previous operation still running...' : '上一次操作还在进行，请等结束（保持弹窗打开）'), false);
      return;
    }
    const c = getFormCfg();
    if (!c.webdavUrl) {
      setStatus('❌ ' + (currentLang === 'en' ? 'Please fill in the file URL first' : '请先填写完整文件URL'), false);
      return;
    }
    busy = true;
    setAllBtns(true);
    setStatus('【' + label + '】' + (currentLang === 'en' ? ' Keep popup open...' : ' 请保持弹窗打开...'), null);
    setBtn(el, true);
    try {
      const progress = (msg) => setStatus(msg, null);
      const result = await fn(c, progress);
      setStatus(result.result, true);
    } catch (e) {
      let m = e.message || String(e);
      if (m.includes('405')) m += ' （URL必须是完整文件路径）';
      if (m.includes('412')) m = '⚠️ ' + m;
      setStatus('❌ ' + label + ': ' + m, false);
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
  cacheEls();

  // 版本号
  const verEl = document.getElementById('version');
  if (verEl) verEl.textContent = 'v' + getEngineVersion();

  // 恢复语言设置
  const { lang } = await storage.local.get(['lang']);
  if (lang) currentLang = lang;

  // 加载同步范围
  await loadScopeOptions();

  // 加载配置
  const cfg = await getStoredCfg();
  els.url.value = cfg.webdavUrl || DEFAULT_URL;
  if (cfg.webdavUser) els.user.value = cfg.webdavUser;
  if (cfg.webdavPass) els.pass.value = cfg.webdavPass;
  if (cfg.encPass && els.encPass) els.encPass.value = cfg.encPass;
  if (cfg.scopeParentId && els.scope) {
    setTimeout(() => { els.scope.value = cfg.scopeParentId; }, 300);
  }

  // 语言切换
  if (els.langSwitch) {
    els.langSwitch.addEventListener('click', async () => {
      currentLang = currentLang === 'zh_CN' ? 'en' : 'zh_CN';
      await storage.local.set({ lang: currentLang });
      applyI18n();
      // 更新状态消息
      setStatus(currentLang === 'en'
        ? 'Language switched to English. Restart popup for full effect.'
        : '语言已切换为中文。重新打开弹窗以完全生效。', null);
    });
  }

  // 保存按钮
  if (els.save) {
    els.save.addEventListener('click', async () => {
      try { await saveAndTest(); }
      catch (e) { setStatus('❌ ' + (e.message || e), false); }
    });
  }

  // 测试按钮
  if (els.test) {
    els.test.addEventListener('click', async () => {
      const c = getFormCfg();
      if (!c.webdavUrl) {
        setStatus('❌ ' + (currentLang === 'en' ? 'Fill in URL first' : '先填URL'), false);
        return;
      }
      setBtn(els.test, true);
      setStatus(currentLang === 'en' ? 'Testing connection...' : '正在测试连接...', null);
      const r = await testConn(c);
      setStatus(r.ok
        ? (currentLang === 'en' ? '✅ Connection OK' : '✅ 测试连接正常')
        : '❌ ' + (currentLang === 'en' ? 'Test failed: ' : '测试失败: ') + r.err, r.ok);
      setBtn(els.test, false);
    });
  }

  // 导出/导入配置
  if (els.exportCfg) els.exportCfg.addEventListener('click', exportConfig);
  if (els.importCfg) els.importCfg.addEventListener('click', importConfig);

  // ── 两个核心按钮 ──
  bind(els.sync, async (cfg, progress) => await doSync(cfg, progress),
    currentLang === 'en' ? 'Sync to Cloud' : '同步到云端');
  bind(els.pull, async (cfg, progress) => await doPull(cfg, progress),
    currentLang === 'en' ? 'Restore from Cloud' : '从云端恢复');

  // 初始 i18n 渲染
  applyI18n();

  console.log('%c[悟空书签] 所有按钮已绑定 v' + getEngineVersion(), 'color:green');
  setStatus(
    currentLang === 'en'
      ? 'Ready v' + getEngineVersion() + ' — Shared Mode\n• Daily use → Sync to Cloud\n• New device → Restore from Cloud'
      : '就绪 v' + getEngineVersion() + ' — 共享模式\n• 日常使用 → 点「同步到云端」\n• 新设备 / 恢复 → 点「从云端恢复」',
    null
  );
}

main();
