// sync-engine.js — 悟空书签同步引擎
// 共享模式：云端 XBEL 是唯一真相，所有浏览器都是它的镜像
// 被 popup.js 和 background.js 共同引用
//
// ⚠️ 如果你需要「合并模式」（合并 = 多设备互相补缺、永不加删），请使用 Floccus：
//     https://github.com/marcelklehr/floccus
//     本扩展只做共享模式：云端覆盖本地，或本地覆盖云端。

// ── 浏览��� API 兼容 ──
const api = (typeof browser !== 'undefined' && browser.bookmarks)
  ? browser.bookmarks : chrome.bookmarks;
const bgStorage = (typeof browser !== 'undefined' && browser.storage)
  ? browser.storage : chrome.storage;

// ── 常量 ──
const ENGINE_VERSION = '0.5';
export const LAST_SYNC_KEY = 'wukong_last_sync';
export const LAST_SYNC_STATUS_KEY = 'wukong_last_sync_status';

// 顶层系统文件夹别名（中英/Edge/旧版）— folderType 优先
const ROOT_ALIASES = {
  'bookmarks-bar': [
    'bookmarks bar', 'bookmark bar', 'book marks bar',
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

export function matchRootType(title) {
  const t = normFolderTitle(title);
  for (const [type, aliases] of Object.entries(ROOT_ALIASES)) {
    if (aliases.some(a => normFolderTitle(a) === t)) return type;
  }
  return null;
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

// webdavGet 返回 { text, etag } — text 为空串表示 404
export async function webdavGet(url, u, p) {
  const r = await fetchWithTimeout(url, { headers: authHeader(u, p) }, 60000);
  if (!r.ok && r.status !== 404) throw new Error('GET失败 ' + r.status);
  if (r.status === 404) return { text: '', etag: null };
  const text = await r.text();
  const etag = r.headers.get('ETag') || r.headers.get('etag') || null;
  return { text, etag };
}

// webdavPut — 支持 ETag 乐观锁（If-Match），防止并发覆盖
export async function webdavPut(url, u, p, body, etag = null) {
  const headers = {
    'Content-Type': 'application/xml; charset=UTF-8',
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

// 在覆盖前备份云端文件到同目录下的 .backup 文件
export async function backupCloud(url, u, p) {
  try {
    const { text } = await webdavGet(url, u, p);
    if (!text) return;
    const backupUrl = url.replace(/\.xbel$/i, '.backup.xbel');
    const backupXml = text.replace(
      /(<xbel[^>]*>)/i,
      `$1\n  <!-- BACKUP: ${new Date().toISOString()} -->`
    );
    await webdavPut(backupUrl, u, p, backupXml);
    return backupUrl;
  } catch (e) {
    console.warn('[悟空书签] 备份失败（非致命）:', e.message);
    return null;
  }
}

// 测试连接
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

// ── 浏览器书签 API 封装 ──
export function bmCreate(details) {
  return new Promise((resolve, reject) => {
    api.create(details, (node) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(node);
    });
  });
}

export function bmRemove(id) {
  return new Promise((resolve, reject) => {
    api.remove(id, () => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

export function bmGetChildren(id) {
  return new Promise((resolve, reject) => {
    api.getChildren(id, (nodes) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(nodes || []);
    });
  });
}

export function bmGetTree() {
  return new Promise((resolve, reject) => {
    api.getTree((tree) => {
      const err = chrome.runtime?.lastError;
      if (err) reject(new Error(err.message));
      else resolve(tree);
    });
  });
}

// ── 文件夹路径解析 ──
export async function getSpecialFolders() {
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
  const children = await bmGetChildren(parentId);
  const found = children.find(c => !c.url && c.title === name);
  if (found) return found.id;
  const node = await bmCreate({ parentId, title: name });
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
export async function exportXBEL() {
  const tree = await bmGetTree();
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>\n<xbel version="1.0">'];
  lines.push(`  <!-- LAST_SYNC: ${new Date().toISOString()} -->`);
  lines.push(`  <!-- ENGINE: wukong-bookmark-xbel v${ENGINE_VERSION} -->`);
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
  // 一轮循环同时收集 folder 和 bookmark（修复顶层 bookmark 丢失的 bug）
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
// 与旧版「全量清空 → 重建」不同，此函数使用增量操作：
//   1. 快照所有本地书签 URL
//   2. 遍历 XBEL 树：URL 不在本地 → 新建；在本地但文件夹不对 → 移动；已在对的位置 → 跳过
//   3. 删除本地有但 XBEL 没有的书签（逐条，不触发浏览器同步的批量事件）
//   4. 清理空文件夹
//
// 增量操作可以跟 Chrome/Edge 自带书签同步共存，不会互相干扰。

export async function diffSyncFromCloud(roots, flat) {
  const cloudUrlSet = new Set(flat.map(b => b.url));

  // ── Step 1：快照全部本地书签，建 URL → 节点 索引 ──
  const allLocal = await new Promise((resolve) => {
    chrome.bookmarks.search({}, resolve);
  });
  const localByUrl = new Map();
  for (const bm of allLocal) {
    if (!localByUrl.has(bm.url)) localByUrl.set(bm.url, []);
    localByUrl.get(bm.url).push({ id: bm.id, parentId: bm.parentId, title: bm.title });
  }
  const matchedIds = new Set();

  let created = 0, moved = 0;

  // ── Step 2：增量建文件夹 + 书签（复用已有，只新建/移动差异） ──
  async function createFolder(parentId, title) {
    const children = await bmGetChildren(parentId);
    const found = children.find(c => !c.url && c.title === title);
    if (found) return found.id;
    const node = await bmCreate({ parentId, title });
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
          // URL 存在但文件夹不对 → 移动
          try {
            await new Promise((resolve, reject) => {
              chrome.bookmarks.move(entries[0].id, { parentId: pid }, (r) => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(r);
              });
            });
            matchedIds.add(entries[0].id);
            moved++;
          } catch (e) {
            // 移动失败 → 新建
            try {
              await bmCreate({ parentId: pid, title: n.title || n.url, url: n.url });
              created++;
            } catch {}
          }
        } else {
          // URL 不存在 → 新建
          await bmCreate({ parentId: pid, title: n.title || n.url, url: n.url });
          created++;
        }
      }
    }
  }

  // 顶层：区分文件夹（进对应根容器）和书签（进默认书签栏）
  const barId = await defaultBarId();
  for (const r of roots) {
    if (r.type === 'folder') {
      const fid = await resolveTopParent(r.title);
      await ensureNodes(r.children || [], async () => fid);
    } else if (r.type === 'bookmark' && r.url) {
      const entries = localByUrl.get(r.url) || [];
      if (entries.length === 0) {
        await bmCreate({ parentId: barId, title: r.title || r.url, url: r.url });
        created++;
      } else {
        matchedIds.add(entries[0].id);
      }
    }
  }

  // ── Step 3：删除本地有但 XBEL 没有的书签（逐条，不触发批量事件） ──
  let deleted = 0, stubborn = 0;
  for (const bm of allLocal) {
    if (matchedIds.has(bm.id)) continue;
    try {
      await bmRemove(bm.id);
      deleted++;
    } catch (e) {
      stubborn++;
    }
  }

  // ── Step 4：清理空文件夹（自底向上递归） ──
  async function removeEmptyFolders(parentId) {
    const children = await bmGetChildren(parentId);
    for (const child of children) {
      if (!child.url) {
        await removeEmptyFolders(child.id);
        const remaining = await bmGetChildren(child.id);
        if (remaining.length === 0) {
          try { await bmRemove(child.id); } catch {}
        }
      }
    }
  }
  const rootContainers = await bmGetChildren('0');
  for (const c of rootContainers) {
    if (!c.url) await removeEmptyFolders(c.id);
  }

  return { created, moved, deleted, stubborn };
}

// ── 两种核心操作 ──
//
// 共享模式只有两个方向：
//   同步到云端：本地覆盖云端（日常操作）
//   从云端恢复：云端覆盖本地（新设备初始化 / 恢复数据）
//
// 没有"合并""补缺"——共享模式 = 一端是权威，另一端是镜像。

// doSync：同步本地到云端（本地 = 权威，覆盖云端）
//
// 流程：
//   1. 读取本地书签树，导为 XBEL
//   2. GET 云端 XBEL（取 ETag + 云端书签数用于安全阈值检查）
//   3. 安全阈值：如果本地数 < 云端数 × 10%，拒绝推送（防误删清空云端）
//   4. 备份云端文件
//   5. PUT 本地 XBEL 到云端（携带 ETag 防并发覆盖）

export async function doSync(cfg, onProgress = null) {
  if (onProgress) onProgress('【同步】读取本地书签树...');
  const exp = await exportXBEL();

  // 获取云端数据用于安全阈值检查和 ETag
  let cloudCount = 0;
  let etag = null;
  try {
    const { text: cloudXml, etag: cloudEtag } = await webdavGet(
      cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass
    );
    etag = cloudEtag;
    if (cloudXml) {
      const { flat } = parseXBELTree(cloudXml);
      cloudCount = flat.length;
    }
  } catch (e) {
    // GET 失败不阻断——可能是首次使用云端无文件，或网络问题
    if (onProgress) onProgress(`【同步】获取云端信息失败（${e.message}），跳过安全检查...`);
  }

  // ── 安全阈值：防误删清空云端 ──
  if (cloudCount > 0 && exp.count < cloudCount * 0.1) {
    throw new Error(
      `⚠️ 安全阈值触发！\n` +
      `本地只有 ${exp.count} 个书签，但云端有 ${cloudCount} 个。\n` +
      `（本地不足云端的 10%，疑似误清空）\n\n` +
      `如果确实要清空云端，请手动删除云端 XBEL 文件后再操作。`
    );
  }

  // 备份
  if (onProgress) onProgress('【同步】备份云端文件...');
  backupCloud(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass).catch(() => {});

  // 上传
  const cloudLabel = cloudCount > 0 ? `（云端原有 ${cloudCount} 个）` : '';
  if (onProgress) onProgress(`【同步】上传 ${exp.count} 个书签...${cloudLabel}`);
  await webdavPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, exp.xml, etag);
  await bgStorage.local.set({ [LAST_SYNC_KEY]: Date.now(), [LAST_SYNC_STATUS_KEY]: 'ok' });

  return {
    result:
      `✅ 同步完成\n` +
      `→ ${exp.count} 个书签已推送到云端\n` +
      `→ 其他设备执行「从云端恢复」即可获得最新数据`
  };
}

// doPull：从云端恢复（云端 = 权威，覆盖本地）
//
// 流程：GET 云端 XBEL → 增量 diff 同步到本地（新建/移动/删除）。
// 不写回云端——纯拉取。适合新设备初始化或恢复数据。
// 使用增量操作，可以跟浏览器自带书签同步并存。

export async function doPull(cfg, onProgress = null) {
  if (onProgress) onProgress('【恢复】下载云端书签...');

  const { text: xml } = await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);

  if (!xml) {
    return {
      result: '⚠️ 云端没有书签文件。\n请先在另一台设备上执行「同步到云端」创建云端书签。'
    };
  }

  if (onProgress) onProgress('【恢复】解析 XBEL...');
  const { roots, flat } = parseXBELTree(xml);

  if (onProgress) onProgress(`【恢复】增量同步 ${flat.length} 个书签...`);
  const { created, moved, deleted, stubborn } = await diffSyncFromCloud(roots, flat);

  let note = '';
  if (stubborn > 0) note += `\n→ ${stubborn} 个系统书签无法删除（浏览器保护）`;

  return {
    result:
      `✅ 恢复完成\n` +
      `→ 新建 ${created} 个书签\n` +
      `→ 移动 ${moved} 个书签\n` +
      `→ 删除 ${deleted} 个本地多余书签` +
      note +
      `\n→ 云端 ${flat.length} 个书签现已镜像到本地`
  };
}

// ── 获取配置 ──
export async function getStoredCfg() {
  return bgStorage.local.get(['webdavUrl', 'webdavUser', 'webdavPass']);
}

export function getEngineVersion() {
  return ENGINE_VERSION;
}
