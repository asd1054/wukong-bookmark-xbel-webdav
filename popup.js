// 悟空书签同步xbel-ByWebdav - 稳定反馈版 + XBEL (参考 Floccus) + 默认正确URL
console.log('%c[悟空书签] popup.js 加载', 'color:green');

const api = (typeof browser !== 'undefined' && browser.bookmarks) ? browser.bookmarks : chrome.bookmarks;
const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage : chrome.storage;

const DEFAULT_URL = 'https://webdav.123pan.cn/webdav/bookmarks.xbel';

const els = {
  url: document.getElementById('url'),
  user: document.getElementById('user'),
  pass: document.getElementById('pass'),
  status: document.getElementById('status'),
  save: document.getElementById('save'),
  test: document.getElementById('test'),
  sync: document.getElementById('sync'),
  exp: document.getElementById('export'),
  imp: document.getElementById('import')
};

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

function setBtn(btn, loading) {
  if (!btn) return;
  if (loading) {
    btn.dataset.old = btn.textContent;
    btn.textContent = '处理中...';
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.old || btn.textContent;
    btn.disabled = false;
  }
}

async function getCfg() {
  return {
    webdavUrl: els.url.value.trim(),
    webdavUser: els.user.value.trim(),
    webdavPass: els.pass.value
  };
}

function authHeader(u, p) {
  if (!u) return {};
  return { 'Authorization': 'Basic ' + btoa(u + ':' + p) };
}

async function webdavGet(url, u, p) {
  const r = await fetch(url, { headers: authHeader(u, p) });
  if (!r.ok && r.status !== 404) throw new Error('GET失败 ' + r.status);
  return r.status === 404 ? '' : await r.text();
}

async function webdavPut(url, u, p, body) {
  const r = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/xml; charset=UTF-8', ...authHeader(u, p) },
    body
  });
  if (!r.ok) throw new Error('PUT失败 ' + r.status);
  return r;
}

async function testConn(cfg) {
  try {
    const o = await fetch(cfg.webdavUrl, { method: 'OPTIONS', headers: authHeader(cfg.webdavUser, cfg.webdavPass) });
    if (o.ok || o.status === 200 || o.status === 204) return {ok: true};
    await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);
    return {ok: true};
  } catch (e) {
    let m = e.message || String(e);
    if (m.includes('405')) m = '405: URL是目录不是文件！请用完整路径 https://webdav.123pan.cn/webdav/bookmarks.xbel';
    return {ok: false, err: m};
  }
}

// XBEL (参考 Floccus)
function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

async function exportXBEL() {
  const tree = await api.getTree();
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<xbel version="1.0">\n';
  xml += `  <!-- LAST_SYNC: ${new Date().toISOString()} -->\n`;
  if (tree[0] && tree[0].children) {
    for (const c of tree[0].children) xml += xbelNode(c, 1);
  }
  xml += '</xbel>';
  return xml;
}

function xbelNode(n, lv) {
  const ind = '  '.repeat(lv);
  if (n.children) {
    let s = `${ind}<folder>\n${ind}  <title>${esc(n.title)}</title>\n`;
    for (const c of n.children) s += xbelNode(c, lv+1);
    s += `${ind}</folder>\n`;
    return s;
  }
  if (n.url) {
    return `${ind}<bookmark href="${esc(n.url)}">\n${ind}  <title>${esc(n.title || n.url)}</title>\n${ind}</bookmark>\n`;
  }
  return '';
}

function parseXBEL(xml) {
  const out = [];
  if (!xml) return out;
  try {
    const d = new DOMParser().parseFromString(xml, 'application/xml');
    function w(el) {
      if (!el) return;
      if (el.tagName === 'bookmark') {
        const h = el.getAttribute('href');
        const t = (el.querySelector('title') || {}).textContent || '';
        if (h) out.push({url: h, title: t.trim()});
      }
      for (const ch of el.children || []) w(ch);
    }
    w(d.documentElement);
  } catch (e) {}
  return out;
}

async function pullMerge(remoteList) {
  let added = 0, updated = 0;
  for (const it of remoteList) {
    const hits = await new Promise(r => api.search({url: it.url}, r));
    if (hits.length === 0) {
      await new Promise(r => api.create({parentId: '1', title: it.title, url: it.url}, r));
      added++;
    } else if (it.title && it.title !== hits[0].title) {
      await new Promise(r => api.update(hits[0].id, {title: it.title}, r));
      updated++;
    }
  }
  return {added, updated};
}

async function doExport(cfg) {
  const xml = await exportXBEL();
  await webdavPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, xml);
}

async function doImport(cfg) {
  const xml = await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);
  const list = parseXBEL(xml);
  const res = await pullMerge(list);
  setStatus(`✅ 导入完成。从云拉取：新增 ${res.added}，更新 ${res.updated}`, true);
}

async function doSync(cfg) {
  setStatus('【正在同步】从云下载 XBEL → 合并到本地 → 推送本地最新状态...', null);
  const xml = await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);
  const list = parseXBEL(xml);
  const res = await pullMerge(list);

  const out = await exportXBEL();
  await webdavPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, out);

  // 关键：统计真正推送到云端的本地书签数量（不管云端原来有没有）
  const tree = await api.getTree();
  let pushed = 0;
  function countBookmarks(node) {
    if (node.url) pushed++;
    if (node.children) node.children.forEach(countBookmarks);
  }
  if (tree[0] && tree[0].children) tree[0].children.forEach(countBookmarks);

  setStatus(`✅ 同步成功！从云拉取：新增 ${res.added}，更新 ${res.updated}。已推送本地 ${pushed} 个书签到云端。`, true);
}

// 保存配置：保存 + 自动测试
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
  const c = await getCfg();
  const t = await testConn(c);
  if (t.ok) {
    setStatus('✅ 配置保存成功 + 连接测试通过！', true);
  } else {
    setStatus('⚠️ 配置已保存，但连接失败：' + t.err, false);
  }
}

async function main() {
  console.log('%c[悟空书签] main 启动', 'color:green');
  const cfg = await storage.local.get(['webdavUrl', 'webdavUser', 'webdavPass']);
  els.url.value = cfg.webdavUrl || DEFAULT_URL;
  if (cfg.webdavUser) els.user.value = cfg.webdavUser;
  if (cfg.webdavPass) els.pass.value = cfg.webdavPass;

  // 保存
  if (els.save) {
    els.save.addEventListener('click', async () => {
      console.log('%c[悟空书签] 保存按钮点击', 'color:orange');
      try {
        await saveAndTest();
      } catch (e) {
        setStatus('❌ 保存失败: ' + (e.message || e), false);
      }
    });
  }

  // 测试
  if (els.test) {
    els.test.addEventListener('click', async () => {
      console.log('%c[悟空书签] 测试按钮点击', 'color:orange');
      const c = await getCfg();
      if (!c.webdavUrl) { setStatus('❌ 先填URL', false); return; }
      setBtn(els.test, true);
      setStatus('正在测试连接...', null);
      const r = await testConn(c);
      setStatus(r.ok ? '✅ 测试连接正常' : '❌ 测试失败: ' + r.err, r.ok);
      setBtn(els.test, false);
    });
  }

  const bind = (el, fn, label) => {
    if (!el) return;
    el.addEventListener('click', async () => {
      console.log('%c[悟空书签] ' + label + ' 点击', 'color:orange');
      const c = await getCfg();
      if (!c.webdavUrl) { setStatus('❌ 请先填写完整文件URL', false); return; }
      setStatus('【正在' + label + '】请保持弹窗打开...', null);
      setBtn(el, true);
      try {
        await fn(c);
      } catch (e) {
        let m = e.message || String(e);
        if (m.includes('405')) m += ' （URL必须是完整文件路径，例如 .../bookmarks.xbel）';
        setStatus('❌ ' + label + '失败: ' + m, false);
      } finally {
        setBtn(el, false);
      }
    });
  };

  bind(els.exp, doExport, '导出');
  bind(els.imp, doImport, '导入');
  bind(els.sync, doSync, '同步');

  console.log('%c[悟空书签] 所有按钮已绑定', 'color:green');
  setStatus('就绪。推荐URL: https://webdav.123pan.cn/webdav/bookmarks.xbel （先在云盘创建这个空文件）', null);
}

main();