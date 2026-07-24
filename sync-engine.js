// sync-engine.js — 悟空书签同步引擎 v0.6
// 共享模式：云端 XBEL 是唯一真相，所有浏览器都是它的镜像
// 被 popup.js 和 background.js 共同引用
//
// ⚠️ 如果你需要「合并模式」（合并 = 多设备互相补缺、永不加删），请使用 Floccus：
//     https://github.com/marcelklehr/floccus
//     本扩展只做共享模式：云端覆盖本地，或本地覆盖云端。

// ── WebExtension Polyfill ──
// 统一 browser.* 命名空间，兼容 Chrome/Edge/Firefox
const _browser = (typeof browser !== 'undefined') ? browser : chrome;
const _api = _browser.bookmarks || chrome.bookmarks;
const _storage = _browser.storage || chrome.storage;

// Promise 化的书签 API（兼容 callback 式 chrome.bookmarks.*）
function _promisify(fn) {
  return (...args) => new Promise((resolve, reject) => {
    fn(...args, (result) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

const bm = {
  create:    _promisify(_api.create.bind(_api)),
  get:       _promisify(_api.get.bind(_api)),
  getChildren: _promisify(_api.getChildren.bind(_api)),
  getTree:   _promisify(_api.getTree.bind(_api)),
  move:      _promisify(_api.move.bind(_api)),
  remove:    _promisify(_api.remove.bind(_api)),
  removeTree:_promisify(_api.removeTree.bind(_api)),
  search:    _promisify(_api.search.bind(_api)),
  update:    _promisify(_api.update.bind(_api)),
};

// 加密模块（动态导入以避免 crypto.js 不存在时崩溃）
let _crypto = null;
async function _loadCrypto() {
  if (!_crypto) {
    try { _crypto = await import('./crypto.js'); }
    catch { _crypto = null; }
  }
  return _crypto;
}

// ── 常量 ──
const ENGINE_VERSION = '0.6';
export const LAST_SYNC_KEY = 'wukong_last_sync';
export const LAST_SYNC_STATUS_KEY = 'wukong_last_sync_status';
export const SYNC_LOG_KEY = 'wukong_sync_log';
const MAX_BACKUPS = 10; // 保留最近 10 份云端备份

// ── 跨浏览器文件夹名规范化 ──
//
// 不同浏览器对系统书签文件夹的命名不同：
//   Chrome  : "书签栏" / "Bookmarks bar" / "其他书签" / "Other bookmarks"
//   Edge    : "收藏夹栏" / "Favorites bar" / "其他收藏夹" / "Other favorites"
//   Firefox : "书签工具栏" / "Bookmarks Toolbar" / "其他书签" / "Other Bookmarks"
//
// FOLDER_MAPPING 将所有变体统一映射到标准 key，
// xbelName 是导出到 XBEL 时使用的规范名称。

const FOLDER_MAPPING = {
  'bookmarks-bar': {
    xbelName: 'Bookmarks bar',
    aliases: [
      'bookmarks bar', 'bookmark bar', 'book marks bar',
      '书签栏', '书签工具栏', '收藏夹栏', '收藏栏', '我的最爱栏',
      'favorites bar', 'favourites bar', 'favorites', 'favourites',
      'bookmarks toolbar', 'personal toolbar',
    ]
  },
  'other': {
    xbelName: 'Other bookmarks',
    aliases: [
      'other bookmarks', 'other bookmark',
      '其他书签', '其它书签', '其他收藏夹', '其它收藏夹',
      'other favorites', 'other favourites', 'unfiled bookmarks',
    ]
  },
  'mobile': {
    xbelName: 'Mobile bookmarks',
    aliases: [
      'mobile bookmarks', 'mobile bookmark',
      '移动设备书签', '手机书签', '移动书签', 'mobile',
    ]
  }
};

// 双向查询表：别名 → 标准 key
const ALIAS_TO_KEY = {};
for (const [key, def] of Object.entries(FOLDER_MAPPING)) {
  for (const alias of def.aliases) {
    ALIAS_TO_KEY[alias] = key;
  }
}

// ── 工具函数 ──
export function esc(s) {
  return String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function normUrl(u) {
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

export function normFolderTitle(t) {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 根据文件夹标题返回标准 key（bookmarks-bar / other / mobile / null） */
export function matchRootType(title) {
  const t = normFolderTitle(title);
  return ALIAS_TO_KEY[t] || null;
}

/** 获取标准 key 在 XBEL 中应使用的名称 */
export function folderXbelName(key) {
  const def = FOLDER_MAPPING[key];
  return def ? def.xbelName : null;
}

/** 跨浏览器规范化文件夹标题 → 标准名称 */
export function normalizeFolderTitle(title, folderType) {
  // folderType 优先（Chrome/Edge 的 folderType 属性）
  if (folderType === 'bookmarks-bar') return FOLDER_MAPPING['bookmarks-bar'].xbelName;
  if (folderType === 'other') return FOLDER_MAPPING['other'].xbelName;
  if (folderType === 'mobile') return FOLDER_MAPPING['mobile'].xbelName;
  // 退回到别名匹配
  const key = matchRootType(title);
  if (key) return FOLDER_MAPPING[key].xbelName;
  return title; // 用户自定义文件夹，保持原名
}

// ── HTTP / WebDAV ──
export function authHeader(u, p) {
  if (!u) return {};
  return { 'Authorization': 'Basic ' + btoa(u + ':' + p) };
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
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

/** webdavGet 返回 { text, etag } — text 为空串表示 404 */
export async function webdavGet(url, u, p) {
  const r = await fetchWithTimeout(url, { headers: authHeader(u, p) }, 60000);
  if (!r.ok && r.status !== 404) throw new Error('GET失败 ' + r.status);
  if (r.status === 404) return { text: '', etag: null };
  const text = await r.text();
  const etag = r.headers.get('ETag') || r.headers.get('etag') || null;
  return { text, etag };
}

/** webdavPut — 支持 ETag 乐观锁 */
export async function webdavPut(url, u, p, body, etag = null) {
  const headers = {
    'Content-Type': 'application/octet-stream',
    ...authHeader(u, p)
  };
  if (etag) headers['If-Match'] = etag;

  const r = await fetchWithTimeout(url, { method: 'PUT', headers, body }, 180000);
  if (!r.ok) {
    if (r.status === 412) {
      throw new Error(
        '并发冲突（412）：自上次下载后云端已被其他设备修改。\n' +
        '请重新点击同步按钮重试。'
      );
    }
    throw new Error('PUT失败 ' + r.status);
  }
  return r;
}

/** 列出云端备份目录下的文件 */
async function listBackups(url, u, p) {
  try {
    const base = url.replace(/\/[^/]*\.xbel$/i, '/.xbel-backups/');
    const r = await fetchWithTimeout(base, {
      method: 'PROPFIND',
      headers: { ...authHeader(u, p), 'Depth': '1' }
    }, 15000);
    if (!r.ok) return [];
    const text = await r.text();
    // 简易解析 PROPFIND 返回的 href 列表
    const hrefs = [];
    const re = /<D:href>([^<]+)<\/D:href>/gi;
    let m;
    while ((m = re.exec(text)) !== null) hrefs.push(m[1]);
    return hrefs.filter(h => h.endsWith('.xbel') && h !== base && !h.endsWith('/'));
  } catch {
    return [];
  }
}

/** 版本化云端备份：上传到 .xbel-backups/YYYY-MM-DD-HHmmss.xbel，保留最近 MAX_BACKUPS 份 */
export async function backupCloudVersioned(url, u, p) {
  try {
    const { text } = await webdavGet(url, u, p);
    if (!text) return null;

    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const base = url.replace(/\/[^/]*\.xbel$/i, '/.xbel-backups/');
    const backupUrl = base + ts + '.xbel';

    // 创建备份目录（尝试 PUT 一个空标记文件，失败也不阻塞）
    try {
      await fetchWithTimeout(base, {
        method: 'MKCOL',
        headers: authHeader(u, p)
      }, 10000);
    } catch {}

    await webdavPut(backupUrl, u, p, text);

    // 清理超出数量的旧备份
    const existing = await listBackups(url, u, p);
    if (existing.length > MAX_BACKUPS) {
      const toDelete = existing.slice(0, existing.length - MAX_BACKUPS);
      for (const old of toDelete) {
        try {
          await fetchWithTimeout(old, {
            method: 'DELETE',
            headers: authHeader(u, p)
          }, 10000);
        } catch {}
      }
    }

    return backupUrl;
  } catch (e) {
    console.warn('[悟空书签] 版本备份失败（非致命）:', e.message);
    return null;
  }
}

/** 测试连接 */
export async function testConn(cfg) {
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

// ── 文件夹路径解析 ──
export async function getSpecialFolders() {
  const roots = await bm.getChildren('0');
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

export async function ensureFolder(parentId, title) {
  const name = String(title || '').trim() || '未命名文件夹';
  const children = await bm.getChildren(parentId);
  const found = children.find(c => !c.url && c.title === name);
  if (found) return found.id;
  const node = await bm.create({ parentId, title: name });
  return node.id;
}

export async function resolveTopParent(folderTitle) {
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

export async function defaultBarId() {
  const { roots, byType } = await getSpecialFolders();
  if (byType['bookmarks-bar']) return byType['bookmarks-bar'].id;
  const bar = roots.find(r => r.id === '1') || roots.find(r => !r.url);
  if (!bar) throw new Error('找不到书签栏');
  return bar.id;
}

// ── 书签树导出为 XBEL ──
// scope: null = 全部，或 { parentId } = 仅指定文件夹

export async function exportXBEL(scope = null) {
  let tree;
  if (scope && scope.parentId) {
    const sub = await bm.getSubTree(scope.parentId);
    tree = sub.length ? [sub[0]] : [];
  } else {
    tree = await bm.getTree();
  }

  const lines = ['<?xml version="1.0" encoding="UTF-8"?>\n<xbel version="1.0">'];
  lines.push(`  <!-- LAST_SYNC: ${new Date().toISOString()} -->`);
  lines.push(`  <!-- ENGINE: wukong-bookmark-xbel v${ENGINE_VERSION} -->`);
  let raw = 0;

  function xbelNode(n, lv) {
    const ind = '  '.repeat(lv);
    if (n.children) {
      // 跨浏览器规范化：系统文件夹用标准名
      const title = normalizeFolderTitle(n.title, n.folderType);
      lines.push(`${ind}<folder>`);
      lines.push(`${ind}  <title>${esc(title)}</title>`);
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
  return { xml: lines.join('\n'), count: raw };
}

// ── XBEL 解析 ──
export function directTitle(el) {
  for (const ch of el.children || []) {
    if ((ch.tagName || '').toLowerCase() === 'title') {
      return (ch.textContent || '').trim();
    }
  }
  return '';
}

export function parseXBELNode(el) {
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

export function parseXBELTree(xml) {
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

// ── 共享模式核心：增量 diff 同步云端到本地 ──
//
// 增量操作（逐条新建/移动/删除），可与浏览器自带同步并存。

export async function diffSyncFromCloud(roots, flat, scope = null) {
  const cloudUrlSet = new Set(flat.map(b => b.url));

  // Step 1：快照本地书签 URL → 节点
  const allLocal = await bm.search({});
  const localByUrl = new Map();
  for (const bm of allLocal) {
    if (!localByUrl.has(bm.url)) localByUrl.set(bm.url, []);
    localByUrl.get(bm.url).push({ id: bm.id, parentId: bm.parentId, title: bm.title });
  }
  const matchedIds = new Set();
  let created = 0, moved = 0;

  // Step 2：增量建文件夹 + 书签
  async function createFolder(parentId, title) {
    const children = await bm.getChildren(parentId);
    const found = children.find(c => !c.url && c.title === title);
    if (found) return found.id;
    const node = await bm.create({ parentId, title });
    return node.id;
  }

  async function ensureNodes(nodes, parentResolve) {
    for (const n of nodes) {
      if (n.type === 'folder') {
        const pid = await parentResolve();
        const fid = await createFolder(pid, n.title);
        await ensureNodes(n.children || [], async () => fid);
      } else if (n.type === 'bookmark' && n.url) {
        const pid = await parentResolve();
        const entries = localByUrl.get(n.url) || [];
        const inPlace = entries.find(e => e.parentId === pid);
        if (inPlace) {
          matchedIds.add(inPlace.id);
        } else if (entries.length > 0) {
          try {
            await bm.move(entries[0].id, { parentId: pid });
            matchedIds.add(entries[0].id);
            moved++;
          } catch {
            try { await bm.create({ parentId: pid, title: n.title || n.url, url: n.url }); created++; } catch {}
          }
        } else {
          await bm.create({ parentId: pid, title: n.title || n.url, url: n.url });
          created++;
        }
      }
    }
  }

  const barId = await defaultBarId();
  for (const r of roots) {
    if (r.type === 'folder') {
      const fid = await resolveTopParent(r.title);
      await ensureNodes(r.children || [], async () => fid);
    } else if (r.type === 'bookmark' && r.url) {
      const entries = localByUrl.get(r.url) || [];
      if (entries.length === 0) {
        await bm.create({ parentId: barId, title: r.title || r.url, url: r.url });
        created++;
      } else {
        matchedIds.add(entries[0].id);
      }
    }
  }

  // Step 3：删除多余书签
  let deleted = 0, stubborn = 0;
  for (const bm of allLocal) {
    if (matchedIds.has(bm.id)) continue;
    // scope 限制时只删范围内的
    if (scope && scope.parentId) {
      const inScope = await _isUnder(bm.id, scope.parentId);
      if (!inScope) continue;
    }
    try {
      await bm.remove(bm.id);
      deleted++;
    } catch { stubborn++; }
  }

  // Step 4：清理空文件夹
  async function removeEmptyFolders(parentId) {
    const children = await bm.getChildren(parentId);
    for (const child of children) {
      if (!child.url) {
        await removeEmptyFolders(child.id);
        const remaining = await bm.getChildren(child.id);
        if (remaining.length === 0) {
          try { await bm.remove(child.id); } catch {}
        }
      }
    }
  }
  const rootContainers = await bm.getChildren('0');
  for (const c of rootContainers) {
    if (!c.url) await removeEmptyFolders(c.id);
  }

  return { created, moved, deleted, stubborn };
}

// 递归检查书签是否在目标子树下
async function _isUnder(nodeId, rootId) {
  if (nodeId === rootId) return true;
  try {
    const [node] = await bm.get(nodeId);
    if (!node || !node.parentId) return false;
    return _isUnder(node.parentId, rootId);
  } catch {
    return false;
  }
}

// ── 加密/解密集成 ──

async function _getCrypto() {
  return await _loadCrypto();
}

/** 加密后上传，未加密则直接上传 */
async function _encryptedPut(url, u, p, xml, encPass, etag) {
  const crypto = await _getCrypto();
  if (crypto && encPass) {
    const encrypted = await crypto.encryptData(xml, encPass);
    return webdavPut(url, u, p, encrypted, etag);
  }
  const headers = {
    'Content-Type': 'application/xml; charset=UTF-8',
    ...authHeader(u, p)
  };
  if (etag) headers['If-Match'] = etag;
  const r = await fetchWithTimeout(url, { method: 'PUT', headers, body: xml }, 180000);
  if (!r.ok) {
    if (r.status === 412) throw new Error('并发冲突（412）');
    throw new Error('PUT失败 ' + r.status);
  }
  return r;
}

/** GET 后自动解密 */
async function _decryptedGet(url, u, p, encPass) {
  const crypto = await _getCrypto();
  const { text, etag } = await webdavGet(url, u, p);
  if (!text) return { text, etag, encrypted: false };

  if (crypto && crypto.isEncrypted(text)) {
    if (!encPass) throw new Error('云端数据已加密，请在设置中填写「加密密码」');
    const decrypted = await crypto.decryptData(text, encPass);
    return { text: decrypted, etag, encrypted: true };
  }
  return { text, etag, encrypted: false };
}

// ── 两种核心操作 ──

// doSync：同步本地到云端（本地 = 权威，覆盖云端）
export async function doSync(cfg, onProgress = null) {
  const scope = cfg.scopeParentId ? { parentId: cfg.scopeParentId } : null;
  if (onProgress) onProgress('【同步】读取本地书签树...');
  const exp = await exportXBEL(scope);

  let cloudCount = 0;
  let etag = null;
  let cloudEncrypted = false;
  try {
    const { text: cloudText, etag: cloudEtag, encrypted } = await _decryptedGet(
      cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, cfg.encPass
    );
    etag = cloudEtag;
    cloudEncrypted = encrypted;
    if (cloudText) {
      const { flat } = parseXBELTree(cloudText);
      cloudCount = flat.length;
    }
  } catch (e) {
    if (onProgress) onProgress(`【同步】获取云端信息失败（${e.message}），跳过安全检查...`);
  }

  // 安全阈值
  if (cloudCount > 0 && exp.count < cloudCount * 0.1) {
    throw new Error(
      `⚠️ 安全阈值触发！\n` +
      `本地只有 ${exp.count} 个书签，但云端有 ${cloudCount} 个。\n` +
      `（本地不足云端的 10%，疑似误清空）\n\n` +
      `如果确实要清空云端，请手动删除云端 XBEL 文件后再操作。`
    );
  }

  // 版本化备份
  if (onProgress) onProgress('【同步】备份云端文件（版本化）...');
  backupCloudVersioned(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass).catch(() => {});

  // 上传（如果原来加密就加密，否则看有没有设加密密码）
  const useEnc = cloudEncrypted || !!cfg.encPass;
  if (onProgress) {
    const mode = useEnc ? '加密' : '明文';
    onProgress(`【同步】${mode}上传 ${exp.count} 个书签...`);
  }
  await _encryptedPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, exp.xml, cfg.encPass, etag);
  await _storage.local.set({ [LAST_SYNC_KEY]: Date.now(), [LAST_SYNC_STATUS_KEY]: 'ok' });

  return {
    result:
      `✅ 同步完成\n` +
      `→ ${exp.count} 个书签已推送到云端` +
      (useEnc ? '（加密传输）' : '') + '\n' +
      `→ 其他设备执行「从云端恢复」即可获得最新数据`
  };
}

// doPull：从云端恢复（云端 = 权威，覆盖本地）
export async function doPull(cfg, onProgress = null) {
  if (onProgress) onProgress('【恢复】下载云端书签...');

  const { text: xml, encrypted } = await _decryptedGet(
    cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, cfg.encPass
  );

  if (!xml) {
    return {
      result: '⚠️ 云端没有书签文件。\n请先在另一台设备上执行「同步到云端」创建云端书签。'
    };
  }

  if (onProgress) onProgress(`【恢复】解析 XBEL${encrypted ? '（已解密）' : ''}...`);
  const { roots, flat } = parseXBELTree(xml);

  const scope = cfg.scopeParentId ? { parentId: cfg.scopeParentId } : null;
  if (onProgress) onProgress(`【恢复】增量同步 ${flat.length} 个书签...`);
  const { created, moved, deleted, stubborn } = await diffSyncFromCloud(roots, flat, scope);

  let note = '';
  if (stubborn > 0) note += `\n→ ${stubborn} 个系统书签无法删除（浏览器保护）`;

  return {
    result:
      `✅ 恢复完成\n` +
      `→ 新建 ${created} 个书签\n` +
      `→ 移动 ${moved} 个书签\n` +
      `→ 删除 ${deleted} 个本地多余书签` +
      note +
      `\n→ 云端 ${flat.length} 个书签现已镜像到本地` +
      (encrypted ? '\n→ 数据已解密' : '')
  };
}

// ── 获取配置 ──
export async function getStoredCfg() {
  const data = await _storage.local.get([
    'webdavUrl', 'webdavUser', 'webdavPass',
    'encPass', 'scopeParentId', 'scopeTitle'
  ]);
  return data;
}

export function getEngineVersion() {
  return ENGINE_VERSION;
}

// ── 导出 API 命名空间（供 background.js 监听书签变更） ──
export { _api as bookmarksApi, _storage as storageApi, _browser as browserApi };
