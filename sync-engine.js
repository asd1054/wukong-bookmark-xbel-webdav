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
const ENGINE_VERSION = '0.3';
const LAST_SYNC_KEY = 'wukong_last_sync';
const LAST_SYNC_STATUS_KEY = 'wukong_last_sync_status';

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
  return { xml: lines.join('\n'), unique: raw };
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

// ── 共享模式核心：清空本地 → 从云端 XBEL 树重建 ──
//
// 这是共享模式的关键函数。它做两件事：
//   1. 删除所有浏览器根级文件夹（书签栏/其他书签/移动书签）内的全部内容
//   2. 从 XBEL 解析树重新创建所有书签和文件夹
//
// 注意：系统根文件夹本身（如"书签栏"）不会被删除，只清空其子内容。
//       这与单纯「合并补缺」不同——合并永远只增不减，共享模式是「全量替换」。

export async function replaceLocalFromTree(roots) {
  // ── 第一步：清空所有根级容器的子内容 ──
  const rootContainers = await bmGetChildren('0');
  let cleared = 0;
  const clearErrors = [];

  // 清空函数：递归删除一个容器内的所有子节点
  async function clearContainer(containerId, label) {
    let passCleared = 0;
    const children = await bmGetChildren(containerId);
    for (const child of children) {
      await bmRemove(child.id); // bmRemove 递归删除文件夹+内容
      passCleared++;
    }
    return passCleared;
  }

  for (const container of rootContainers) {
    const label = container.title || container.id;
    try {
      // 第一轮：正常清空
      cleared += await clearContainer(container.id, label);
    } catch (e) {
      clearErrors.push(`${label}: ${e.message}`);
    }
  }

  // ── 验证清空：检查所有根容器是否确实为空 ──
  const containersAfter = await bmGetChildren('0');
  let stillHasChildren = false;
  for (const c of containersAfter) {
    const children = await bmGetChildren(c.id);
    if (children.length > 0) {
      stillHasChildren = true;
      console.warn(`[悟空书签] 容器 "${c.title || c.id}" 清空后仍有 ${children.length} 个子节点，重试清空...`);
    }
  }

  if (stillHasChildren) {
    // 第二轮：强制清空残留（包括之前失败的容器）
    const containersRetry = await bmGetChildren('0');
    for (const c of containersRetry) {
      try {
        const children = await bmGetChildren(c.id);
        if (children.length > 0) {
          let retry = 0;
          for (const child of children) {
            await bmRemove(child.id);
            retry++;
          }
          cleared += retry;
          console.log(`[悟空书签] 第二轮清空 "${c.title || c.id}"：删除了 ${retry} 个残留子节点`);
        }
      } catch (e) {
        clearErrors.push(`${c.title || c.id}(重试): ${e.message}`);
      }
    }
  }

  // ── 最终验证 ──
  const containersFinal = await bmGetChildren('0');
  for (const c of containersFinal) {
    const children = await bmGetChildren(c.id);
    if (children.length > 0) {
      const titles = children.slice(0, 5).map(ch => ch.title || '(未命名)').join(', ');
      throw new Error(
        `清空本地书签失败！容器 "${c.title}" 仍有 ${children.length} 条残留。\n` +
        `前 5 条: ${titles}\n` +
        `请关掉 Chrome 自带的「书签同步」功能后重试。`
      );
    }
  }

  if (clearErrors.length) {
    console.warn('[悟空书签] 清空时有个别错误（已通过重试解决）:', clearErrors.join('; '));
  }

  // ── 第二步：从 XBEL 树重建 ──
  const barId = await defaultBarId();
  let built = 0;
  let foldersCreated = 0;
  const buildErrors = [];

  async function createFolder(parentId, title) {
    const name = String(title || '').trim() || '未命名文件夹';
    const children = await bmGetChildren(parentId);
    const existing = children.find(c => !c.url && c.title === name);
    if (existing) return existing.id;
    const node = await bmCreate({ parentId, title: name });
    foldersCreated++;
    return node.id;
  }

  async function buildNodes(nodes, parentResolve, isTop) {
    for (const n of nodes) {
      if (n.type === 'folder') {
        let cachedId = null;
        const childResolve = async () => {
          if (cachedId) return cachedId;
          const parentId = await parentResolve();
          if (isTop) {
            cachedId = await resolveTopParent(n.title);
          } else {
            cachedId = await createFolder(parentId, n.title);
          }
          return cachedId;
        };
        await buildNodes(n.children || [], childResolve, false);
      } else if (n.type === 'bookmark' && n.url) {
        try {
          const parentId = await parentResolve();
          await bmCreate({ parentId, title: n.title || n.url, url: n.url });
          built++;
        } catch (e) {
          buildErrors.push(`${n.url}: ${e.message}`);
        }
      }
    }
  }

  const topFolders = roots.filter(n => n.type === 'folder');
  const topMarks = roots.filter(n => n.type === 'bookmark');

  await buildNodes(topFolders, async () => barId, true);
  if (topMarks.length) await buildNodes(topMarks, async () => barId, false);

  if (buildErrors.length) {
    throw new Error(`重建书签时有 ${buildErrors.length} 个失败。例: ${buildErrors[0]}`);
  }

  return { built, foldersCreated, cleared };
}

// ── 三种核心操作 ──

// doSync：共享模式同步（拉取 + 推送）
//
// 流程：
//   1. GET 云端 XBEL（同时获取 ETag 版本号）
//   2. 备份云端文件
//   3. 清空本地书签，从云端 XBEL 重建
//   4. 导出本地树，PUT 回云端（携带 ETag 防并发覆盖）
//
// ETag 保护：如果步骤 1 和步骤 4 之间另一个设备也推送了，
// 云端 ETag 会变 → PUT 收到 412 → 提示用户重试。

export async function doSync(cfg, onProgress = null) {
  if (onProgress) onProgress('【同步 1/3】下载云端书签...');

  const { text: xml, etag } = await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);

  // 异步备份，不阻塞主流程
  backupCloud(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass).catch(() => {});

  if (!xml) {
    // 云端无文件 → 首次推送
    if (onProgress) onProgress('【同步 2/3】云端无文件，首次推送本地书签...');
    const exp = await exportXBEL();
    if (onProgress) onProgress(`【同步 3/3】上传 ${exp.unique} 个书签...`);
    await webdavPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, exp.xml);
    await bgStorage.local.set({ [LAST_SYNC_KEY]: Date.now(), [LAST_SYNC_STATUS_KEY]: 'ok' });

    return {
      result: `✅ 同步完成（首次上传）\n${exp.unique} 个书签已推送到云端`
    };
  }

  // 解析 + 替换本地
  const { roots, flat } = parseXBELTree(xml);

  if (onProgress) onProgress(`【同步 2/3】以云端覆盖本地（${flat.length} 个书签）...`);
  const { built, cleared } = await replaceLocalFromTree(roots);

  // ── 数量一致性检查：导出数必须 ≈ 云端数（差异超过 5% 则中止） ──
  if (onProgress) onProgress('【同步 3/3】验证并写回云端...');
  const exp = await exportXBEL();

  if (flat.length > 0) {
    const diff = Math.abs(exp.unique - flat.length);
    const ratio = diff / flat.length;
    if (ratio > 0.05) {
      throw new Error(
        `数量一致性检查失败！\n` +
        `→ 云端下载: ${flat.length} 个书签\n` +
        `→ 本地重建: ${built} 个书签\n` +
        `→ 导出时发现: ${exp.unique} 个书签（多了 ${exp.unique - flat.length} 个！）\n\n` +
        `可能原因：\n` +
        `1. Chrome 自带「书签同步」功能未关闭 → chrome://settings/syncSetup → 关闭「书签」\n` +
        `2. Edge 或其他浏览器也在同步 → 暂时只在一台设备上操作\n\n` +
        `请关闭上述功能后，在新的 Chrome 窗口中重新点「同步」。`
      );
    }
  }

  await webdavPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, exp.xml, etag);
  await bgStorage.local.set({ [LAST_SYNC_KEY]: Date.now(), [LAST_SYNC_STATUS_KEY]: 'ok' });

  return {
    result:
      `✅ 同步完成\n` +
      `→ 云端 ${flat.length} 个书签已覆盖本地（清空 ${cleared} 条旧书签，重建 ${built} 条）\n` +
      `→ 已写回 ${exp.unique} 个书签到云端`
  };
}

// doExport：推送本地到云端（本地覆盖云端）
//
// 流程：读取本地书签树 → 备份云端 → PUT 覆盖云端 XBEL。
// 不使用 ETag——这是用户明确要求的"本地为准"操作，
// 会无条件覆盖云端。

export async function doExport(cfg, onProgress = null) {
  if (onProgress) onProgress('【推送】读取本地书签树...');
  const exp = await exportXBEL();

  if (onProgress) onProgress('【推送】备份云端文件...');
  backupCloud(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass).catch(() => {});

  if (onProgress) onProgress(`【推送】上传 ${exp.unique} 个书签（覆盖云端）...`);
  await webdavPut(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass, exp.xml);
  await bgStorage.local.set({ [LAST_SYNC_KEY]: Date.now(), [LAST_SYNC_STATUS_KEY]: 'ok' });

  return {
    result: `✅ 已用本地书签覆盖云端\n${exp.unique} 个书签已推送\n→ 其他设备执行「同步」即可获取最新`
  };
}

// doImport：从云端拉取（云端覆盖本地）
//
// 流程：GET 云端 XBEL → 清空本地书签 → 从 XBEL 重建。
// 不写回云端——纯拉取。适合新设备初始化或预览云端状态。

export async function doImport(cfg, onProgress = null) {
  if (onProgress) onProgress('【拉取】下载云端书签...');

  const { text: xml } = await webdavGet(cfg.webdavUrl, cfg.webdavUser, cfg.webdavPass);

  if (!xml) {
    return {
      result: '⚠️ 云端没有书签文件。\n请先在另一台设备上执行「推送」或「同步」创建云端书签。'
    };
  }

  if (onProgress) onProgress('【拉取】解析 XBEL...');
  const { roots, flat } = parseXBELTree(xml);

  if (onProgress) onProgress(`【拉取】清空本地并重建（${flat.length} 个书签）...`);
  const { built, cleared } = await replaceLocalFromTree(roots);

  return {
    result:
      `✅ 拉取完成\n` +
      `→ 清空本地 ${cleared} 条旧书签\n` +
      `→ 从云端重建 ${built} 个书签\n` +
      `→ 未写回云端（纯拉取）`
  };
}

// ── 获取配置 ──
export async function getStoredCfg() {
  return bgStorage.local.get(['webdavUrl', 'webdavUser', 'webdavPass']);
}

export function getEngineVersion() {
  return ENGINE_VERSION;
}
