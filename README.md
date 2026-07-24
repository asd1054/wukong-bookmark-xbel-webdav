# 悟空书签同步 xbel-ByWebdav

通过任意 WebDAV 云盘在 Chrome / Edge / Firefox / 各类 Chromium 浏览器之间**共享书签**。

专为 123 云盘、坚果云等 WebDAV 服务优化，也兼容 Nextcloud、ownCloud、自建等。

---

## ⚠️ 共享模式 vs 合并模式

本扩展采用 **「共享模式」**：

```
云端 XBEL 文件 = 唯一真相（可选 AES-256-GCM 加密）
    ↙              ↘
Chrome 书签      Edge 书签
（都是云端的镜像）  （都是云端的镜像）
```

| | 共享模式（本项目） | 合并模式（Floccus） |
|---|---|---|
| **数据模型** | 云端是唯一真相，所有浏览器都是镜像 | 各浏览器各自独立，云端做汇集池 |
| **拉取** | 增量 diff：新建 / 移动 / 删除 | 云端补缺到本地（不删本地独有） |
| **推送** | 本地覆盖云端 | 本地并入云端（不删云端独有） |
| **删除** | 支持：推/拉都会删掉另一端删除的书签 | 不支持：一端删了另一端又回来 |
| **冲突处理** | ETag 乐观锁阻止并发覆盖 | 依赖时间戳/snapshot 检测 |
| **加密** | 可选 AES-256-GCM E2E 加密 | 部分后端支持 E2E 加密 |
| **适合谁** | 一个人维护一套书签，多设备共用 | 多人/多设备各有各的书签需互相补缺 |

**如果你需要「合并模式」— 请使用 Floccus：**

> https://github.com/marcelklehr/floccus

---

## 新功能 (v0.6)

| 功能 | 说明 |
|------|------|
| 🔐 **端到端加密** | 可选 AES-256-GCM 加密，PBKDF2 25 万轮密钥派生，加密密码 ≠ WebDAV 密码 |
| 📡 **实时变更监听** | 添加/修改/移动/删除书签即时感知，5 秒防抖后自动同步 |
| 🔴 **Badge 徽章** | 扩展图标上显示红色未同步数量 |
| 📦 **版本化备份** | 每次同步前自动备份到 `.xbel-backups/YYYY-MM-DD-HHmmss.xbel`，保留最近 10 份 |
| 🌐 **i18n 中英文** | 自动跟随浏览器语言，弹窗内可一键切换 |
| 📂 **同步范围** | 可选择「全部书签」或仅同步某个文件夹 |
| 📤 **配置导出/导入** | 一键导出配置（不含密码），在新浏览器上快速配置 |
| 🔄 **跨浏览器规范化** | 自动处理 Chrome「书签栏」/ Edge「收藏夹栏」/ Firefox「书签工具栏」的命名差异 |

---

## 浏览器兼容性

| 浏览器 | 平台 | 支持状态 | 备注 |
|--------|------|:--:|------|
| **Google Chrome** | Win / Mac / Linux | ✅ 完全支持 | Manifest V3, v88+ |
| **Microsoft Edge** | Win / Mac | ✅ 完全支持 | 含系统书签删除保护 |
| **Mozilla Firefox** | Win / Mac / Linux | ✅ 完全支持 | v109+, `browser.*` + Promise 原生 |
| **Opera** | Win / Mac | ✅ 支持 | 同 Chromium 内核 |
| **Brave** | Win / Mac / Linux | ✅ 支持 | 同 Chromium 内核 |
| **Vivaldi** | Win / Mac / Linux | ✅ 支持 | 同 Chromium 内核 |
| **Kiwi Browser** | Android | ✅ 支持 | 唯一支持 Chrome 扩展的 Android 浏览器 |
| **Firefox Android** | Android | ❌ 不支持 | Firefox Android 不开放 `bookmarks` API |
| **Safari** | macOS | ❌ 不支持 | WebKit 不支持 `bookmarks` 扩展 API |
| **Safari** | iOS | ❌ 不支持 | iOS 不支持任何浏览器扩展书签 API |

### 移动端替代方案

| 平台 | 方案 |
|------|------|
| **Android** | 安装 [Kiwi Browser](https://kiwibrowser.com/)，然后安装本扩展 |
| **iOS** | 无直接方案。建议：Safari → 导出书签 HTML → 导入桌面 Chrome → 同步到云端 |

> Safari 不支持书签扩展 API 是 WebKit 的硬限制，所有同类项目（Floccus、xBrowserSync）都一样无法支持 Safari 原生书签。

---

## 工作原理

两个按钮，两个方向，一切清晰：

| 按钮 | 操作 | 数据流向 | 何时用 |
|------|------|----------|--------|
| **同步到云端** | 本地覆盖云端 | 本地 → 云端 | 日常使用，改了书签就点（或等自动同步） |
| **从云端恢复** | 云端覆盖本地 | 云端 → 本地 | 新设备初始化，让本地跟云端一样 |

### 自动同步

- 书签变更后 **5 秒防抖**触发自动同步
- 每 **60 分钟**定时后台同步（Service Worker）
- 扩展图标显示红色 **Badge 徽章**表示未同步数量

### ETag 并发保护

如果你在 Chrome 上点了同步，同时 Edge 的后台同步也触发了——后到的那个会被 ETag 阻止：

```
Chrome 同步 → PUT(XBEL, ETag:"v1") → ✅ OK，云端 ETag 变为 "v2"
Edge 同步   → PUT(XBEL, ETag:"v1") → ❌ 412 拒绝
                                     → 弹窗提示"云端已被修改，请重新同步"
```

### 端到端加密

```
你的书签（XBEL XML）
    ↓ PBKDF2("你的加密密码", salt, 250000轮) → AES-256-GCM key
    ↓ AES-256-GCM.encrypt(明文, key, iv)
    ↓
加密后的二进制数据 — 上传到 WebDAV

解密时只有知道"加密密码"的设备才能解开，WebDAV 服务商无法读取。
```

- 加密密码 ≠ WebDAV 密码 — 即使 WebDAV 被攻破，数据仍安全
- 向后兼容 — 不设加密密码时明文传输，设了才加密
- 自动检测 — 下载时自动判断是加密还是明文数据

---

## 安装

1. 下载整个文件夹
2. Chrome 打开 `chrome://extensions/`，开启「开发者模式」
3. 「加载已解压的扩展程序」→ 选择本文件夹
4. Edge: `edge://extensions/` → 同样操作
5. Firefox: `about:debugging#/runtime/this-firefox` → 「临时载入附加组件」

---

## 使用（以 123 云盘为例）

1. 在 123 云盘 WebDAV 里新建文件 `bookmarks.xbel`（必须是文件，不能是目录）
2. 插件里填完整地址：
   ```
   https://webdav.123pan.cn/webdav/bookmarks.xbel
   ```
3. 输入账号密码
4. （可选）在「高级选项」中设置加密密码
5. 保存配置 → 测试连接
6. 点「同步到云端」

**重要**：URL 必须指向**具体文件**（.xbel），不能只到文件夹，否则会报 405。

### 多设备接入

```
设备 A（已有书签）：
  ① 安装扩展 → 填配置 → 点「同步到云端」
  ② （可选）点「导出配置」，保存 JSON 文件

设备 B（新设备）：
  ① 安装扩展
  ② 方式一：点「导入配置」选择 JSON → 补填密码
  ③ 方式二：手动填写相同配置
  ④ 点「从云端恢复」
```

之后日常使用，无论在哪个设备：
- 改完书签等 5 秒自动同步
- 或手动点「同步到云端」
- 其他设备下次打开浏览器会自动拉取

**不需要关掉浏览器自带的书签同步！** v0.5+ 使用增量 diff 操作，可与 Chrome/Edge/Firefox 自带同步共存。

---

## 为什么用 XBEL 而不是 HTML？

- XBEL 是标准书签交换格式（与 Floccus 兼容）
- 结构化更好，文件夹层次保留完整
- 跨浏览器导入导出更可靠

---

## 安全保障

| 机制 | 说明 |
|------|------|
| **AES-256-GCM 加密** | 可选，PBKDF2 25 万轮密钥派生，与 xBrowserSync 同级别 |
| **ETag 乐观锁** | PUT 携带 `If-Match`，并发修改返回 412 而非静默覆盖 |
| **版本化云端备份** | 每次同步前备份到 `.xbel-backups/`，保留最近 10 份 |
| **安全阈值** | 本地不足云端 10% 时拒绝推送（防误删清空） |
| **关闭保护** | 同步进行中关闭弹窗会弹出确认提示 |
| **增量操作** | 不与浏览器自带同步冲突 |

---

## 隐私

- 所有数据仅在你的浏览器和指定的 WebDAV 之间传输
- 无任何硬编码密码、Token 或个人信息
- 凭证保存在 `chrome.storage.local`
- 加密密码开启后，云端数据无法被任何第三方读取（包括 WebDAV 服务商）

---

## 文件结构

```
├── manifest.json           — Manifest V3 + Firefox 兼容 + i18n
├── background.js           — Service Worker：定时同步 + 变更监听 + badge
├── sync-engine.js          — 共享同步引擎（WebDAV / XBEL / 加密 / diff）
├── crypto.js               — AES-256-GCM 加密模块
├── popup.html              — 弹窗 UI（i18n 支持）
├── popup.js                — 弹窗 UI 逻辑
├── _locales/               — 国际化语言包
│   ├── zh_CN/messages.json
│   └── en/messages.json
├── icons/                  — 扩展图标
└── README.md
```

---

## 构建 / 发布

无需构建，直接作为解压扩展加载。如需打包 crx，使用 Chrome 的「打包扩展程序」。

---

## 致谢

- 参考 Floccus 的 XBEL + WebDAV 格式
- 加密方案参考 xBrowserSync 的 AES-256-GCM + PBKDF2 设计
- 123 云盘、坚果云 WebDAV 兼容测试

---

如有问题，欢迎提 Issue。
