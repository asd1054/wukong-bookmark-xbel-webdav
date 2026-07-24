// 悟空书签同步xbel-ByWebdav - URL 并集 + 文件夹路径 + 少埋坑
console.log('%c[悟空书签] popup.js 加载', 'color:green');

const api = (typeof browser !== 'undefined' && browser.bookmarks) ? browser.bookmarks : chrome.bookmarks;
const storage = (typeof browser !== 'undefined' && browser.storage) ? browser.storage : chrome.storage;

const DEFAULT_URL = 'https://webdav.123pan.cn/webdav/bookmarks.xbel';

// 防连点：同步中再点会覆盖写坏
let busy = false;

// 顶层系统文件夹别名（中英/Edge/旧版）— 不要只认 id=1 或单一中文名
// Chrome 官方：name 随语言变，id 不保证恒为 1，优先 folderType
const ROOT_ALIASES = {
  'bookmarks-bar': [
    'bookmarks bar', 'bookmarks bar', 'bookmark bar', 'book marks bar',
    '书签栏', '书签工具栏', '收藏夹栏', '收藏栏', '我的最爱栏',
    'favorites bar', 'favourites bar', 'favorites', 'favourites'
  ],
  'other': [
    'other bookmarks', 'other bookmark',
    '其他书签', '其它书签', '其他收藏夹', '其它收藏夹',
    'other favorites', 'other favourites'
  ],
  'mobile': [
    'mobile bookmarks', 'mobile bookmark',
    '移动设备书签', '手机书签', '移动书签', 'mobile'
  ]
};

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

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    if (e.name === 'AbortError') {
      throw new Error(`网络请求超时（>${Math.round(timeoutMs / 1000)}秒）`);
    }
    throw e;
  }
}

async function webdavGet(url, u, p) {
  // 3000+ 书签 XBEL 可能较大，15s 不够
  const r = await fetchWithTimeout(url, { headers: authHeader(u, p) }, 60000);
  if (!r.ok && r.status !== 404) throw new Error('GET失败 ' + r.status);
  return r.status === 404 ? '' : await r.text();
}

async function webdavPut(url, u, p, body) {
  const r = await fetchWithTimeout(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/xml; charset=UTF-8', ...authHeader(u, p) },
    body
  }, 180000);
  if (!r.ok) throw new Error('PUT失败 ' + r.status);
  return r;
}

async function testConn(cfg) {
  try {
    const o = await fetchWithTimeout(cfg.webdavUrl, {
      method: 'OPTIONS',
      headers: authHeader(cfg.webdavUser, cfg.webdavPass)
    }, 15000);
    if (o.ok || o.status === 200 || o.status === 204) return { ok: true };
    await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);
    return { ok: true };
  } catch (e) {
    let m = e.message || String(e);
    if (m.includes('405')) m = '405: URL是目录不是文件！请用完整路径 .../bookmarks.xbel';
    return { ok: false, err: m };
  }
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function normUrl(u) {
  try {
    const x = new URL(String(u || '').trim());
    x.hash = '';
    let s = x.href;
    if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
    return s;
  } catch {
    return String(u || '').trim().replace(/\/$/, '');
  }
}

function normFolderTitle(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function matchRootType(title) {
  const t = normFolderTitle(title);
  for (const [type, aliases] of Object.entries(ROOT_ALIASES)) {
    if (aliases.some(a => normFolderTitle(a) === t)) return type;
  }
  return null;
}

// ---------- bookmarks API ----------
function bmCreate(details) {
  return new Promise((resolve, reject) => {
    api.create(details, (node) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(node);
    });
  });
}

function bmGetChildren(id) {
  return new Promise((resolve, reject) => {
    api.getChildren(id, (nodes) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(nodes || []);
    });
  });
}

function bmGetTree() {
  return new Promise((resolve, reject) => {
    api.getTree((tree) => {
      const err = chrome.runtime && chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(tree);
    });
  });
}

// 找书签栏/其他/手机：folderType > 别名 > 旧 id
async function getSpecialFolders() {
  const roots = await bmGetChildren('0');
  const byType = {};

  for (const c of roots) {
    if (!c || c.url) continue;
    if (c.folderType) {
      byType[c.folderType] = c;
      continue;
    }
    const t = matchRootType(c.title);
    if (t && !byType[t]) byType[t] = c;
  }

  // 老 Chromium 习惯 id
  if (!byType['bookmarks-bar']) {
    const bar = roots.find(r => r.id === '1');
    if (bar) byType['bookmarks-bar'] = bar;
  }
  if (!byType['other']) {
    const o = roots.find(r => r.id === '2');
    if (o) byType['other'] = o;
  }

  return { roots, byType };
}

async function ensureFolder(parentId, title) {
  const name = String(title || '').trim() || '未命名文件夹';
  const children = await bmGetChildren(parentId);
  const found = children.find(c => !c.url && c.title === name);
  if (found) return found.id;
  const node = await bmCreate({ parentId, title: name });
  return node.id;
}

// 顶层：系统夹用 folderType/别名；自定义夹挂到书签栏下（禁止硬编码只认「书签栏」四字）
async function resolveTopParent(folderTitle) {
  const { roots, byType } = await getSpecialFolders();
  const type = matchRootType(folderTitle);
  if (type && byType[type]) return byType[type].id;

  const name = String(folderTitle || '').trim();
  const exact = roots.find(c => !c.url && c.title === name);
  if (exact) return exact.id;

  const bar = byType['bookmarks-bar'] || roots.find(r => !r.url) || roots[0];
  if (!bar) throw new Error('找不到浏览器书签根/书签栏');
  if (!name) return bar.id;
  return ensureFolder(bar.id, name);
}

async function defaultBarId() {
  const { roots, byType } = await getSpecialFolders();
  if (byType['bookmarks-bar']) return byType['bookmarks-bar'].id;
  const bar = roots.find(r => r.id === '1') || roots.find(r => !r.url);
  if (!bar) throw new Error('找不到书签栏');
  return bar.id;
}

// ---------- 导出：保留文件夹结构，不做全局 URL 去重 ----------
// 浏览器允许同一 URL 出现在多个文件夹，导出时全部保留
async function exportXBEL() {
  const tree = await bmGetTree();
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>\n<xbel version="1.0">'];
  lines.push(`  <!-- LAST_SYNC: ${new Date().toISOString()} -->`);
  let raw = 0;

  function xbelNode(n, lv) {
    const ind = '  '.repeat(lv);
    if (n.children) {
      lines.push(`${ind}<folder>`);
      lines.push(`${ind}  <title>${esc(n.title)}</title>`);
      for (const c of n.children) xbelNode(c, lv + 1);
      lines.push(`${ind}</folder>`);
    } else if (n.url) {
      raw++;
      lines.push(`${ind}<bookmark href="${esc(n.url)}">`);
      lines.push(`${ind}  <title>${esc(n.title || n.url)}</title>`);
      lines.push(`${ind}</bookmark>`);
    }
  }

  if (tree[0] && tree[0].children) {
    for (const c of tree[0].children) xbelNode(c, 1);
  }
  lines.push('</xbel>');
  return { xml: lines.join('\n'), unique: raw, raw, skippedDup: 0 };
}

// ---------- 解析：树结构 ----------
function directTitle(el) {
  for (const ch of el.children || []) {
    if ((ch.tagName || '').toLowerCase() === 'title') {
      return (ch.textContent || '').trim();
    }
  }
  return '';
}

function parseXBELNode(el) {
  if (!el || !el.tagName) return null;
  const tag = el.tagName.toLowerCase();
  if (tag === 'bookmark') {
    const h = el.getAttribute('href') || el.getAttribute('HREF');
    if (!h) return null;
    return { type: 'bookmark', url: h.trim(), title: directTitle(el) || h.trim() };
  }
  if (tag === 'folder') {
    const children = [];
    for (const ch of el.children || []) {
      const t = (ch.tagName || '').toLowerCase();
      if (t === 'title' || t === 'desc' || t === 'info') continue;
      const n = parseXBELNode(ch);
      if (n) children.push(n);
    }
    return { type: 'folder', title: directTitle(el), children };
  }
  return null;
}

function parseXBELTree(xml) {
  if (!xml || !String(xml).trim()) return { roots: [], flat: [] };
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  if (d.querySelector('parsererror')) {
    throw new Error('XBEL 解析失败（远程文件不是合法 XML）');
  }
  const roots = [];
  const rootEl = d.documentElement;
  for (const ch of rootEl.children || []) {
    const n = parseXBELNode(ch);
    if (n) roots.push(n);
  }
  if (roots.length === 0) {
    for (const ch of rootEl.children || []) {
      if ((ch.tagName || '').toLowerCase() === 'bookmark') {
        const n = parseXBELNode(ch);
        if (n) roots.push(n);
      }
    }
  }
  const flat = [];
  (function walk(nodes) {
    for (const n of nodes) {
      if (n.type === 'bookmark') flat.push(n);
      else if (n.children) walk(n.children);
    }
  })(roots);

  if (flat.length === 0 && /<bookmark[\s>]/i.test(xml)) {
    throw new Error('远程含 <bookmark> 但解析为 0 条，已中止以免覆盖云端');
  }
  return { roots, flat };
}

// 云端去重：同一URL只保留最后一次出现（避免重复上传导致的膨胀）
function dedupeFlat(list) {
  const raw = list.length;
  const seen = new Map();
  for (const it of list) {
    if (!it.url) continue;
    const k = normUrl(it.url);
    // 保留最后一个出现的版本（标题可能更新过）
    seen.set(k, it);
  }
  return {
    raw,
    items: [...seen.values()],
    unique: seen.size,
    dups: raw - seen.size
  };
}

async function localUrlMap() {
  const tree = await bmGetTree();
  // 不再用Map全局去重——同一URL可能出现在多个文件夹
  // 改用数组存储所有书签实例
  const list = [];
  let raw = 0;
  function walk(n) {
    if (n.url) {
      raw++;
      list.push({
        id: n.id,
        title: n.title || '',
        url: normUrl(n.url),
        rawUrl: n.url,
        parentId: n.parentId
      });
    }
    if (n.children) for (const c of n.children) walk(c);
  }
  if (tree[0]) walk(tree[0]);
  list._raw = raw;
  return list;
}

// 按云端树合并：只补「本地没有的 URL」
// 关键：文件夹懒创建——只有真的要新建书签时才 ensure 路径
// 这样你本地整理好新文件夹后同步，不会把云端旧空目录整树请回来
async function pullMergeFromTree(roots, flatList) {
  const d = dedupeFlat(flatList);
  const local = await localUrlMap();
  const localUnique0 = local._raw || local.length;
  const localRaw0 = local._raw || local.length;
  let added = 0;
  let exists = 0;
  let foldersCreated = 0;
  const failed = [];
  const barId = await defaultBarId();

  async function ensureFolderCounted(parentId, title) {
    const name = String(title || '').trim() || '未命名文件夹';
    const children = await bmGetChildren(parentId);
    const found = children.find(c => !c.url && c.title === name);
    if (found) return found.id;
    const node = await bmCreate({ parentId, title: name });
    foldersCreated++;
    return node.id;
  }

  // parentResolve: async () => parentId，仅在需要创建子内容时调用
  async function walk(nodes, parentResolve, isTop) {
    for (const n of nodes) {
      if (n.type === 'folder') {
        let cachedId = null;
        const childResolve = async () => {
          if (cachedId) return cachedId;
          const parentId = await parentResolve();
          if (isTop) {
            cachedId = await resolveTopParent(n.title);
          } else {
            cachedId = await ensureFolderCounted(parentId, n.title);
          }
          return cachedId;
        };
        // 先扫子节点；若子树全是已有 URL，childResolve 永不调用 → 不建旧文件夹
        await walk(n.children || [], childResolve, false);
      } else if (n.type === 'bookmark' && n.url) {
        const key = normUrl(n.url);
        // 检查本地是否已有此URL（数组some）
        if (local.some(l => l.url === key)) {
          exists++;
          continue; // 已有：不重复建、不挪你整理好的位置
        }
        try {
          const parentId = await parentResolve();
          await bmCreate({
            parentId,
            title: n.title || n.url,
            url: n.url
          });
          local.push({ url: key, rawUrl: n.url, id: '_', title: n.title || n.url, parentId });
          added++;
        } catch (e) {
          failed.push(n.url + ' (' + (e.message || e) + ')');
        }
      }
    }
  }

  const topFolders = roots.filter(n => n.type === 'folder');
  const topMarks = roots.filter(n => n.type === 'bookmark');
  await walk(topFolders, async () => barId, true);
  if (topMarks.length) await walk(topMarks, async () => barId, false);

  const local2 = await localUrlMap();
  const stillMissing = [];
  for (const it of d.items) {
    if (!local2.some(l => l.url === normUrl(it.url))) stillMissing.push(it.url);
  }
  if (stillMissing.length || failed.length) {
    const n = Math.max(stillMissing.length, failed.length);
    const sample = String(stillMissing[0] || failed[0] || '').slice(0, 100);
    throw new Error(
      `合并失败：云端仍有 ${n} 个 URL 没进本地，已中止写回。例: ${sample}`
    );
  }

  return {
    added,
    exists,
    foldersCreated,
    remoteRaw: d.raw,
    remoteUnique: d.unique,
    remoteDups: d.dups,
    localUnique0,
    localRaw0,
    localUnique1: local2._raw || local2.length,
    localRaw1: local2._raw || local2.length
  };
}

function formatMergeStatus(head, res, exp) {
  const ok = res.added === 0 ? 'URL 并集已对齐（未改你本地文件夹）' : `本次从云补进 ${res.added} 条`;
  return [
    `${head} — ${ok}`,
    `云端：${res.remoteRaw} 行 → 去重 ${res.remoteUnique}` +
      (res.remoteDups ? `（重复 ${res.remoteDups}）` : ''),
    `本地：${res.localRaw0} 条/去重 ${res.localUnique0} → 现 ${res.localRaw1} 条/去重 ${res.localUnique1}`,
    `新从云补进：${res.added}` + (res.foldersCreated ? `（仅为此新建文件夹 ${res.foldersCreated}）` : ''),
    `写回云端：${exp.unique} 个 URL`,
    `说明：已有URL不重复建；整理文件夹后请用「推送本地结构」覆盖云端旧目录`
  ].join('\n');
}

// 整理完文件夹后用这个：不拉云端，只把本地树写成云标准
async function doExport(cfg) {
  const exp = await exportXBEL();
  await webdavPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, exp.xml);
  setStatus(
    `✅ 已用本地文件夹结构覆盖云端\n写回：${exp.unique} 个 URL\n其它浏览器再点「同步」即可按新结构对齐`,
    true
  );
}

async function doImport(cfg) {
  const xml = await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);
  const { roots, flat } = parseXBELTree(xml);
  const res = await pullMergeFromTree(roots, flat);
  const exp = await exportXBEL();
  setStatus(
    formatMergeStatus('✅ 导入完成（未写回云）', res, { unique: exp.unique, skippedDup: 0 }),
    true
  );
}

async function doSync(cfg) {
  setStatus('【同步 1/3】下载云端...', null);
  const xml = await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);
  const { roots, flat } = parseXBELTree(xml);

  setStatus(`【同步 2/3】按文件夹并入（云 ${flat.length} 行）...`, null);
  const res = await pullMergeFromTree(roots, flat);

  setStatus('【同步 3/3】写回云端（保持弹窗打开）...', null);
  const exp = await exportXBEL();
  await webdavPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, exp.xml);

  setStatus(formatMergeStatus('✅ 同步完成', res, exp), true);
}

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

  if (els.save) {
    els.save.addEventListener('click', async () => {
      try {
        await saveAndTest();
      } catch (e) {
        setStatus('❌ 保存失败: ' + (e.message || e), false);
      }
    });
  }

  if (els.test) {
    els.test.addEventListener('click', async () => {
      const c = await getCfg();
      if (!c.webdavUrl) {
        setStatus('❌ 先填URL', false);
        return;
      }
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
      if (busy) {
        setStatus('⏳ 上一次操作还在进行，请等结束（保持弹窗打开）', false);
        return;
      }
      const c = await getCfg();
      if (!c.webdavUrl) {
        setStatus('❌ 请先填写完整文件URL', false);
        return;
      }
      busy = true;
      setStatus('【正在' + label + '】请保持弹窗打开...', null);
      setBtn(el, true);
      try {
        await fn(c);
      } catch (e) {
        let m = e.message || String(e);
        if (m.includes('405')) m += ' （URL必须是完整文件路径）';
        setStatus('❌ ' + label + '失败: ' + m, false);
      } finally {
        setBtn(el, false);
        busy = false;
      }
    });
  };

  bind(els.exp, doExport, '推送本地结构');
  bind(els.imp, doImport, '从云补缺');
  bind(els.sync, doSync, '同步');

  console.log('%c[悟空书签] 所有按钮已绑定', 'color:green');
  setStatus(
    '就绪。\n• 整理文件夹后 →「推送本地结构」\n• 平常跨端 →「同步」（只补缺，不重建旧夹）',
    null
  );
}

main();
