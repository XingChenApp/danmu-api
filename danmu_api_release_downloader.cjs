#!/usr/bin/env node
/* =====================================================
 * danmu_api_release_downloader.cjs — danmu_api 单文件 Release 下载器（内嵌版）
 * -----------------------------------------------------
 * 功能：
 *   1. zip 模式（默认）：检测源码仓库（默认 huangxd-/danmu_api）最新 commit，
 *      下载源码压缩包并解压覆盖项目目录（= 手动下载压缩包更新的流程），
 *      默认跳过覆盖 package.json / package-lock.json，
 *      避免 PeekPro 因清单变化自动重装依赖（其安装器会装全 esbuild 全平台二进制导致 ~250MB 膨胀）；
 *      上游新增依赖导致缺包时设 AUTO_UPDATE_SKIP_MANIFEST=false；
 *      覆盖后自动重新注入 server.js 挂载钩子；需重启 PeekPro 弹幕服务生效
 *      触发方式：默认每次启动服务检查一次（有变化才动作）；
 *      AUTO_UPDATE_LOOP=true 可恢复按间隔定时循环
 *   2. release 模式：检测【我的仓库】最新 Release，下载 danmu_api.js 覆盖本地单文件
 *      （自动备份旧文件 .bak）
 *   3. QQ 推送通知（可选：配置留空 = 默认不推送）
 *
 * 运行环境：Android 手机 Node.js（纯内置模块，零外部依赖）
 * 代理：CONNECT 隧道（默认 mihomo 7890，可用环境变量覆盖）
 *
 * 两种用法：
 *   A. 独立运行（与原版相同）：
 *      node danmu_api_release_downloader.cjs          # 循环监控（默认间隔 3600s）
 *      node danmu_api_release_downloader.cjs --once   # 单次检测+下载
 *      node danmu_api_release_downloader.cjs --test   # 测试 QQ 推送
 *   B. 内嵌运行（推荐，PeekPro 等只能启动弹幕入口的环境）：
 *      由 danmu_api/server.js 启动后自动 require 本文件并调用
 *      startAutoUpdate()，随弹幕服务一起后台循环检测，无需单独启动。
 *
 * 可被 .env 覆盖的配置项（见 config/.env 注释）：
 *   AUTO_UPDATE_REPO / AUTO_UPDATE_GITHUB_TOKEN / AUTO_UPDATE_PROXY /
 *   AUTO_UPDATE_DOWNLOAD_DIR / AUTO_UPDATE_DOWNLOAD_FILE /
 *   AUTO_UPDATE_INTERVAL_SEC / AUTO_UPDATE_QQ_APP_ID /
 *   AUTO_UPDATE_QQ_CLIENT_SECRET / AUTO_UPDATE_QQ_USER_OPENID
 * ===================================================== */

'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ==================== 环境变量读取 ====================
function envStr(key, def) {
  const v = process.env[key];
  return v === undefined || v === null || v === '' ? def : String(v);
}
function envInt(key, def) {
  const n = parseInt(process.env[key] || '', 10);
  return isNaN(n) ? def : n;
}

// 解析 http(s)://host:port 形式的代理地址
function parseProxyUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return { host: u.hostname, port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)) };
  } catch (e) {
    return null;
  }
}

// 代理解析优先级：AUTO_UPDATE_PROXY > 项目 .env 的 PROXY_URL > 默认 127.0.0.1:7890
function resolveProxy() {
  const explicit = process.env.AUTO_UPDATE_PROXY;
  if (explicit !== undefined && explicit !== null && explicit.trim() !== '') {
    const v = explicit.trim();
    if (/^(none|false|off|direct)$/i.test(v)) return { host: '', port: 0 }; // 直连
    return parseProxyUrl(v) || { host: '127.0.0.1', port: 7890 };
  }
  // 回退到弹幕项目的 PROXY_URL（取第一个普通正向代理配置，忽略 @反代 规则）
  const proxyUrl = process.env.PROXY_URL || '';
  const items = proxyUrl.split(',').map(s => s.trim()).filter(s => s);
  for (const item of items) {
    if (/^@/.test(item) || /^[\w-]+@http/i.test(item)) continue;
    const parsed = parseProxyUrl(item);
    if (parsed) return parsed;
  }
  return { host: '127.0.0.1', port: 7890 };
}

// ==================== 配置区（环境变量可覆盖） ====================
function splitRepo(full, defOwner, defRepo) {
  const parts = String(full).split('/');
  return { owner: parts[0] || defOwner, repo: parts.slice(1).join('/') || defRepo };
}
const zipRepo = splitRepo(envStr('AUTO_UPDATE_REPO', 'huangxd-/danmu_api'), 'huangxd-', 'danmu_api');
const releaseRepo = splitRepo(envStr('AUTO_UPDATE_RELEASE_REPO', 'yydfys/danmu_api'), 'yydfys', 'danmu_api');
const proxy = resolveProxy();

const CONFIG = {
  // 更新模式：zip=源码压缩包覆盖更新（默认）；release=单文件 Release 更新；both=两者都跑
  MODE: envStr('AUTO_UPDATE_MODE', 'zip'),

  // 定时循环开关：默认 false = 仅每次启动服务时检查一次更新（有变化才动作）
  // true = 额外按 CHECK_INTERVAL_SEC 间隔循环检测
  LOOP: envStr('AUTO_UPDATE_LOOP', 'false').trim().toLowerCase() === 'true',

  // 解压源码包时是否跳过覆盖依赖清单（package.json / package-lock.json）
  // 默认 true：只更新源码不碰清单，PeekPro 不会因清单变化自动重装全部依赖
  // （其安装器不过滤平台，会装全 esbuild 26 个平台二进制导致膨胀 ~250MB）
  // false：跟随上游清单（上游新增依赖导致缺包时，设 false 并重装一次依赖）
  SKIP_MANIFEST: envStr('AUTO_UPDATE_SKIP_MANIFEST', 'true').trim().toLowerCase() !== 'false',

  // 源码压缩包更新仓库（对应手动下载压缩包更新的仓库）
  ZIP_OWNER: zipRepo.owner,
  ZIP_REPO: zipRepo.repo,
  // 解压覆盖目录（默认 = 脚本所在目录，即项目根；手机上 /storage/emulated/0/peekpro/danmu_api）
  TARGET_DIR: envStr('AUTO_UPDATE_TARGET_DIR', __dirname),

  // GitHub 我的仓库（release 检测用）
  RELEASE_OWNER: releaseRepo.owner,
  RELEASE_REPO: releaseRepo.repo,
  GITHUB_TOKEN: envStr('AUTO_UPDATE_GITHUB_TOKEN', ''), // 令牌（可选；留空走匿名 API，限流 60 次/h）

  // 代理（CONNECT 隧道；host 留空 = 不走代理直连）
  PROXY_HOST: proxy.host,
  PROXY_PORT: proxy.port,

  // 下载目录（release 模式：danmu_api.js 覆盖到这里）
  // 默认不写死：跟随脚本所在位置，取项目根下的 danmu_api 目录
  // （手机上即 /storage/emulated/0/peekpro/danmu_api/danmu_api/）
  DOWNLOAD_DIR: envStr('AUTO_UPDATE_DOWNLOAD_DIR', path.join(__dirname, 'danmu_api')),
  DOWNLOAD_FILE: envStr('AUTO_UPDATE_DOWNLOAD_FILE', 'danmu_api.js'),

  // 检查间隔（秒，仅 AUTO_UPDATE_LOOP=true 时生效）
  CHECK_INTERVAL_SEC: envInt('AUTO_UPDATE_INTERVAL_SEC', 3600),

  // QQ 推送（推送助手 bot；三项全留空 = 不推送）
  QQ_APP_ID: envStr('AUTO_UPDATE_QQ_APP_ID', ''),
  QQ_CLIENT_SECRET: envStr('AUTO_UPDATE_QQ_CLIENT_SECRET', ''),
  QQ_USER_OPENID: envStr('AUTO_UPDATE_QQ_USER_OPENID', ''),

  // 状态文件（记录上次下载的 release tag；放脚本目录）
  STATE_FILE: path.join(__dirname, '.danmu_api_release_state.json'),
  LOG_FILE: path.join(__dirname, 'danmu_api_release_downloader.log'),
};

// ==================== 日志 ====================
// 强制北京时间 UTC+8，不依赖系统时区（手机 Ubuntu 可能是 UTC，getHours 会慢 8 小时）
function localTs() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}
function log(msg) {
  const ts = localTs();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(CONFIG.LOG_FILE, line + '\n'); } catch (e) {}
}

// ==================== CONNECT 隧道代理 HTTP 客户端 ====================
function connectViaProxy(host, port) {
  if (!CONFIG.PROXY_HOST) {
    // 无代理：直接 TLS 连接
    return new Promise((resolve, reject) => {
      const tlsConn = tls.connect({ host: host, port: port, servername: host }, () => resolve(tlsConn));
      tlsConn.on('error', reject);
    });
  }
  return new Promise((resolve, reject) => {
    const proxyConn = net.connect(CONFIG.PROXY_PORT, CONFIG.PROXY_HOST, () => {
      proxyConn.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let buf = Buffer.alloc(0);
    let settled = false;
    proxyConn.on('data', (d) => {
      if (settled) return;
      buf = Buffer.concat([buf, d]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const head = buf.slice(0, idx).toString();
      const statusLine = head.split('\r\n')[0];
      if (!/ 200 /.test(statusLine)) {
        settled = true;
        reject(new Error('CONNECT failed: ' + statusLine));
        proxyConn.destroy();
        return;
      }
      settled = true;
      const tlsConn = tls.connect({ socket: proxyConn, servername: host }, () => resolve(tlsConn));
      tlsConn.on('error', reject);
    });
    proxyConn.on('error', (e) => { if (!settled) reject(e); });
    proxyConn.on('close', () => { if (!settled) reject(new Error('proxy connection closed before CONNECT response')); });
  });
}

// 通用 HTTPS 请求（经代理），返回 {status, headers, body(Buffer)}
function httpsRequest(host, pathname, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    connectViaProxy(host, 443).then((tlsConn) => {
      const method = opts.method || 'GET';
      const headers = Object.assign({}, opts.headers || {});
      headers['Host'] = host;
      if (!headers['User-Agent']) headers['User-Agent'] = 'danmu-api-release-downloader/1.0';
      if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
      if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);

      tlsConn.write(`${method} ${pathname} HTTP/1.1\r\n` +
        Object.keys(headers).map((k) => `${k}: ${headers[k]}`).join('\r\n') +
        '\r\n\r\n' + (opts.body || ''));

      let respBuf = Buffer.alloc(0);
      let parsed = false;
      let finished = false;
      const finish = (result) => {
        if (finished) return;
        finished = true;
        resolve(result);
        try { tlsConn.destroy(); } catch (e) {}
      };
      const onData = (d) => {
        respBuf = Buffer.concat([respBuf, d]);
        if (parsed) return;
        const hIdx = respBuf.indexOf('\r\n\r\n');
        if (hIdx === -1) return;
        parsed = true;
        const headStr = respBuf.slice(0, hIdx).toString();
        const lines = headStr.split('\r\n');
        const status = parseInt(lines[0].split(' ')[1], 10);
        const headers = {};
        for (let i = 1; i < lines.length; i++) {
          const ci = lines[i].indexOf(':');
          if (ci > 0) headers[lines[i].slice(0, ci).trim().toLowerCase()] = lines[i].slice(ci + 1).trim();
        }
        const bodyStart = hIdx + 4;
        const isChunked = (headers['transfer-encoding'] || '').toLowerCase() === 'chunked';
        if (isChunked) {
          const tryFinishChunked = () => {
            const s = respBuf.slice(bodyStart).toString('latin1');
            const endIdx = s.indexOf('0\r\n\r\n');
            if (endIdx === -1) return false;
            const chunks = [];
            let pos = 0;
            while (pos < s.length) {
              const nl = s.indexOf('\r\n', pos);
              if (nl === -1) break;
              const sizeStr = s.slice(pos, nl).split(';')[0].trim();
              const size = parseInt(sizeStr, 16);
              if (isNaN(size) || size === 0) break;
              chunks.push(Buffer.from(s.slice(nl + 2, nl + 2 + size), 'latin1'));
              pos = nl + 2 + size + 2;
            }
            finish({ status, headers, body: Buffer.concat(chunks) });
            return true;
          };
          if (!tryFinishChunked()) tlsConn.on('data', () => { tryFinishChunked(); });
        } else {
          const cl = parseInt(headers['content-length'] || '0', 10);
          if (cl === 0) { finish({ status, headers, body: Buffer.alloc(0) }); return; }
          if (respBuf.length >= bodyStart + cl) {
            finish({ status, headers, body: respBuf.slice(bodyStart, bodyStart + cl) });
            return;
          }
          tlsConn.on('data', () => {
            if (respBuf.length >= bodyStart + cl) {
              finish({ status, headers, body: respBuf.slice(bodyStart, bodyStart + cl) });
            }
          });
        }
      };
      tlsConn.on('data', onData);
      tlsConn.on('error', reject);
      tlsConn.on('close', () => { if (!parsed && !finished) reject(new Error('connection closed before response')); });
    }).catch(reject);
  });
}

// ==================== GitHub API ====================
function githubApi(pathname, opts) {
  opts = opts || {};
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (CONFIG.GITHUB_TOKEN) headers['Authorization'] = 'token ' + CONFIG.GITHUB_TOKEN;
  if (opts.headers) Object.assign(headers, opts.headers);
  return httpsRequest('api.github.com', pathname, {
    method: opts.method || 'GET',
    headers: headers,
    body: opts.body,
  }).then((r) => {
    if (r.status >= 400) {
      let msg = 'GitHub API ' + r.status;
      try {
        const j = JSON.parse(r.body.toString());
        if (j.message) msg += ': ' + j.message;
      } catch (e) {}
      throw new Error(msg);
    }
    if (r.status === 204 || r.body.length === 0) return null;
    return JSON.parse(r.body.toString());
  });
}

// 获取最新 Release（含 danmu_api.js 资产）
function getLatestRelease() {
  return githubApi(`/repos/${CONFIG.RELEASE_OWNER}/${CONFIG.RELEASE_REPO}/releases?per_page=1`).then((list) => {
    if (!list || list.length === 0) return null;
    const r = list[0];
    const asset = (r.assets || []).find((a) => a.name === 'danmu_api.js');
    if (!asset) return null;
    return {
      tag: r.tag_name,
      url: asset.browser_download_url,
      name: asset.name,
      size: asset.size,
      html_url: r.html_url,
      date: r.published_at,
    };
  });
}

// 下载文件（经代理，跟随重定向）
function downloadFile(url, destPath, redirects) {
  redirects = redirects || 0;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    httpsRequest(u.hostname, u.pathname + u.search, {
      headers: { 'User-Agent': 'danmu-api-release-downloader/1.0' },
    }).then((r) => {
      if (r.status >= 300 && r.status < 400 && r.headers['location']) {
        if (redirects >= 5) { reject(new Error('download too many redirects')); return; }
        const loc = r.headers['location'];
        const nextUrl = loc.startsWith('http') ? loc : (u.protocol + '//' + u.hostname + loc);
        log(`下载重定向 (${r.status}) -> ${nextUrl}`);
        resolve(downloadFile(nextUrl, destPath, redirects + 1));
        return;
      }
      if (r.status >= 400) { reject(new Error('download HTTP ' + r.status)); return; }
      fs.writeFileSync(destPath, r.body);
      resolve(r.body.length);
    }).catch(reject);
  });
}

// ==================== 状态持久化 ====================
function loadState() {
  try {
    if (fs.existsSync(CONFIG.STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG.STATE_FILE, 'utf8'));
    }
  } catch (e) {
    log('读取状态文件失败: ' + e.message);
  }
  return { last_tag: '', last_download: '', last_check: '', last_commit: '' };
}

function saveState(state) {
  state.last_check = localTs();
  try { fs.writeFileSync(CONFIG.STATE_FILE, JSON.stringify(state, null, 2)); } catch (e) {}
}

// ==================== QQ 推送（可选） ====================
function qqPushEnabled() {
  return !!(CONFIG.QQ_APP_ID && CONFIG.QQ_CLIENT_SECRET && CONFIG.QQ_USER_OPENID);
}

function getQqToken() {
  return httpsRequest('bots.qq.com', '/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'danmu-api-release-downloader/1.0' },
    body: JSON.stringify({ appId: CONFIG.QQ_APP_ID, clientSecret: CONFIG.QQ_CLIENT_SECRET }),
  }).then((r) => {
    if (r.status !== 200) throw new Error('QQ token HTTP ' + r.status);
    const j = JSON.parse(r.body.toString());
    if (!j.access_token) throw new Error('QQ token 响应无 access_token');
    return j.access_token;
  });
}

function pushQq(message, maxRetries) {
  maxRetries = maxRetries || 3;
  const attempt = (n) => {
    return getQqToken().then((token) => {
      return httpsRequest('api.sgroup.qq.com', `/v2/users/${CONFIG.QQ_USER_OPENID}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': 'QQBot ' + token,
          'Content-Type': 'application/json',
          'User-Agent': 'danmu-api-release-downloader/1.0',
        },
        body: JSON.stringify({ content: message, msg_type: 0, msg_seq: n }),
      }).then((r) => {
        if (r.status === 200) { log('QQ push success'); return true; }
        log('QQ push failed (attempt ' + n + '): HTTP ' + r.status);
        return false;
      });
    }).catch((e) => {
      log('QQ push error (attempt ' + n + '): ' + e.message);
      return false;
    });
  };
  const loopPush = (n) => {
    if (n > maxRetries) { log('QQ push all failed'); return Promise.resolve(false); }
    return attempt(n).then((ok) => {
      if (ok) return true;
      return new Promise((res) => setTimeout(res, 3000)).then(() => loopPush(n + 1));
    });
  };
  return loopPush(1);
}

// ==================== 核心逻辑 ====================
// release 模式：检测 release → 有新包下载覆盖 → 推送
function runOnceRelease() {
  const state = loadState();
  log(`开始检测 ${CONFIG.RELEASE_OWNER}/${CONFIG.RELEASE_REPO} 最新 Release ...`);
  return getLatestRelease().then((release) => {
    if (!release) {
      log('未找到 Release 或资产，跳过');
      saveState(state);
      return { skipped: true, reason: 'no_release' };
    }
    log(`最新 Release: ${release.tag} (${release.size} bytes)`);

    if (state.last_tag === release.tag) {
      log(`版本无变化 (${release.tag})，跳过`);
      saveState(state);
      return { skipped: true, reason: 'no_new_release', tag: release.tag };
    }

    // 有新 release → 下载
    const dir = CONFIG.DOWNLOAD_DIR;
    const filePath = path.join(dir, CONFIG.DOWNLOAD_FILE);
    const bakPath = filePath + '.bak';
    const newPath = filePath + '.new';

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // 备份旧文件
    if (fs.existsSync(filePath)) {
      try {
        fs.copyFileSync(filePath, bakPath);
        log('已备份旧文件: ' + bakPath);
      } catch (e) {
        log('备份失败（继续）: ' + e.message);
      }
    }

    log('下载 ' + release.url + ' → ' + newPath);
    return downloadFile(release.url, newPath).then((size) => {
      log('下载完成: ' + size + ' bytes');
      // 覆盖
      fs.renameSync(newPath, filePath);
      log('已更新 ' + filePath);

      // 更新状态
      state.last_tag = release.tag;
      state.last_download = localTs();
      saveState(state);

      const result = { downloaded: true, tag: release.tag, size: size, url: release.html_url };

      // 推送通知（配置留空则跳过）
      if (!qqPushEnabled()) {
        log('QQ 推送未配置，跳过');
        return result;
      }
      const msg = '📺 danmu_api 新版已下载\n━━━━━━━━━━━━━━━━━\n' +
        '版本: ' + release.tag + '\n' +
        '大小: ' + (size / 1048576).toFixed(2) + ' MB\n' +
        'Release: ' + release.html_url + '\n' +
        '已更新: ' + filePath;
      return pushQq(msg).then(() => result);
    });
  });
}

// ==================== 最小 ZIP 解析（纯内置模块，零依赖） ====================
// 解析中央目录，返回条目列表
function parseZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('zip 包无效: 未找到 EOCD');
  const entryCount = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip 包无效: 中央目录错误');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// 解压覆盖到 destDir，自动剥离 zip 顶层目录，返回写入文件数
// skipNames：需跳过的相对路径清单（精确匹配，如依赖清单文件）
function extractZip(buf, entries, destDir, skipNames) {
  const skips = new Set(skipNames || []);
  // 探测统一的顶层目录（如 danmu_api-main/）并剥离
  let strip = 0;
  if (entries.length > 0 && entries[0].name.includes('/')) {
    const first = entries[0].name.split('/')[0];
    if (entries.every((e) => e.name.split('/')[0] === first)) strip = 1;
  }
  const root = path.resolve(destDir);
  let written = 0;
  for (const e of entries) {
    let parts = e.name.split('/');
    if (strip) parts = parts.slice(1);
    const rel = parts.join('/');
    if (!rel || rel.includes('..')) continue;
    if (skips.has(rel)) continue; // 跳过依赖清单等指定文件
    const dest = path.resolve(destDir, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) continue; // 防路径穿越
    if (e.name.endsWith('/')) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    const lp = e.localOffset;
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error('zip 包无效: 本地头错误 ' + e.name);
    const nameLen = buf.readUInt16LE(lp + 26);
    const extraLen = buf.readUInt16LE(lp + 28);
    const dataStart = lp + 30 + nameLen + extraLen;
    const raw = buf.slice(dataStart, dataStart + e.compressedSize);
    let data;
    if (e.method === 8) data = zlib.inflateRawSync(raw);
    else if (e.method === 0) data = raw;
    else throw new Error('不支持的 zip 压缩方式 ' + e.method + ': ' + e.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
    written++;
  }
  return written;
}

// ==================== server.js 钩子重注入 ====================
// 上游源码的 server.js 不含「随服务启动更新器」的改动，
// 每次源码覆盖后需重新注入钩子，否则重启后更新器不再启动
const HOOK_FN = `/**
 * 启动自动更新下载器（后台循环检测 GitHub Release 并下载更新）
 * 说明：PeekPro 等环境只能启动 server.js 入口，无法单独拉起更新脚本，
 *       因此在这里以内嵌模块方式随服务启动；任何异常都不影响主服务。
 * 可通过 AUTO_UPDATE_ENABLED=false 关闭。
 */
function startAutoUpdater() {
  if (String(process.env.AUTO_UPDATE_ENABLED || 'true').trim().toLowerCase() === 'false') {
    console.log('[server] Auto updater disabled (AUTO_UPDATE_ENABLED=false)');
    return;
  }
  // 延迟 3 秒启动，避免拖慢主服务启动
  setTimeout(() => {
    try {
      const downloader = require('../danmu_api_release_downloader.cjs');
      downloader.startAutoUpdate({ delaySec: 0 });
    } catch (e) {
      console.log('[server] Auto updater start failed:', e.message);
    }
  }, 3000);
}`;

function patchServerJs() {
  const serverPath = path.join(CONFIG.TARGET_DIR, 'danmu_api', 'server.js');
  try {
    const src = fs.readFileSync(serverPath, 'utf8');
    if (src.includes('startAutoUpdater')) return; // 已含钩子，无需注入
    let out = src;
    const anchorCall = "setTimeout(() => initBangumiData('node', true).catch(console.error), 1000);\n}";
    const callSnippet = "setTimeout(() => initBangumiData('node', true).catch(console.error), 1000);\n\n  // 挂载自动更新下载器：PeekPro 等平台只能启动本入口，更新器随服务一起后台运行\n  startAutoUpdater();\n}";
    if (out.includes(anchorCall)) {
      out = out.replace(anchorCall, callSnippet);
    } else {
      log('[auto-update] 警告: 未找到 startServer 结尾锚点，钩子调用未注入');
    }
    const anchorFn = 'async function initializeFavoriteScheduler(mainPort) {';
    if (out.includes(anchorFn)) {
      out = out.replace(anchorFn, HOOK_FN + '\n\n' + anchorFn);
    } else {
      log('[auto-update] 警告: 未找到 initializeFavoriteScheduler 锚点，钩子函数未注入');
    }
    if (out !== src) {
      fs.writeFileSync(serverPath, out);
      log('[auto-update] 已为 server.js 重新注入自动更新钩子');
    }
  } catch (e) {
    log('[auto-update] server.js 钩子注入失败（不影响本次更新）: ' + e.message);
  }
}

// ==================== zip 模式：源码压缩包覆盖更新 ====================
function runOnceZip() {
  const state = loadState();
  log(`开始检测 ${CONFIG.ZIP_OWNER}/${CONFIG.ZIP_REPO} 最新 commit ...`);
  return githubApi(`/repos/${CONFIG.ZIP_OWNER}/${CONFIG.ZIP_REPO}/commits?per_page=1`).then((list) => {
    if (!list || list.length === 0) {
      log('未找到 commit，跳过');
      saveState(state);
      return { skipped: true, reason: 'no_commit' };
    }
    const sha = list[0].sha;
    const date = (list[0].commit && list[0].commit.committer && list[0].commit.committer.date) || '';
    log(`最新 commit: ${sha.slice(0, 7)} (${date})`);

    if (state.last_commit === sha) {
      log(`源码无变化 (${sha.slice(0, 7)})，跳过`);
      saveState(state);
      return { skipped: true, reason: 'no_new_commit', commit: sha };
    }

    const zipUrl = `https://codeload.github.com/${CONFIG.ZIP_OWNER}/${CONFIG.ZIP_REPO}/zip/${sha}`;
    const tmpPath = path.join(__dirname, '.danmu_update_tmp.zip');
    log('下载源码包 ' + zipUrl);
    return downloadFile(zipUrl, tmpPath).then((size) => {
      log('下载完成: ' + size + ' bytes，开始解压覆盖 ' + CONFIG.TARGET_DIR);
      const buf = fs.readFileSync(tmpPath);
      const entries = parseZipEntries(buf);
      const skipNames = CONFIG.SKIP_MANIFEST ? ['package.json', 'package-lock.json'] : [];
      const count = extractZip(buf, entries, CONFIG.TARGET_DIR, skipNames);
      if (skipNames.length > 0) {
        log('[auto-update] 已跳过依赖清单覆盖: ' + skipNames.join(', ') + '（避免触发 PeekPro 重装依赖）');
      }
      try { fs.unlinkSync(tmpPath); } catch (e) {}
      // 上游 server.js 不含钩子，覆盖后重新注入，保证更新能力自我延续
      patchServerJs();

      state.last_commit = sha;
      state.last_zip_update = localTs();
      saveState(state);
      log('[auto-update] 源码更新完成（' + count + ' 个文件，commit ' + sha.slice(0, 7) + '），请在 PeekPro 重启弹幕服务加载新版本！');

      const result = { updated: true, commit: sha, files: count };
      if (!qqPushEnabled()) return result;
      const msg = '📺 danmu_api 源码已更新\n━━━━━━━━━━━━━━━━━\n' +
        'commit: ' + sha.slice(0, 7) + '\n' +
        '时间: ' + date + '\n' +
        '文件数: ' + count + '\n' +
        '请在 PeekPro 重启弹幕服务生效';
      return pushQq(msg).then(() => result);
    });
  });
}

// 单次运行分发：按 MODE 执行 zip / release
function runOnce() {
  const mode = String(CONFIG.MODE || 'zip').toLowerCase();
  const tasks = [];
  if (mode === 'zip' || mode === 'both') tasks.push(['zip', runOnceZip]);
  if (mode === 'release' || mode === 'both') tasks.push(['release', runOnceRelease]);
  if (tasks.length === 0) {
    log('未知 AUTO_UPDATE_MODE: ' + CONFIG.MODE + '，跳过');
    return Promise.resolve({ skipped: true, reason: 'bad_mode' });
  }
  let chain = Promise.resolve({});
  for (const [name, fn] of tasks) {
    chain = chain.then((acc) => fn().then((r) => { acc[name] = r; return acc; })
      .catch((e) => { log(name + ' 更新出错（跳过本轮）: ' + e.message); acc[name] = { error: e.message }; return acc; }));
  }
  return chain;
}

// 测试 QQ 推送
function testPush() {
  if (!qqPushEnabled()) {
    log('QQ 推送未配置（QQ_APP_ID/CLIENT_SECRET/OPENID 留空），跳过测试');
    return Promise.resolve(false);
  }
  return pushQq('✅ danmu_api_release_downloader 测试推送成功\n监控脚本运行正常');
}

// 循环模式
function loop() {
  runOnce().catch((e) => {
    log('检测出错（跳过，下轮重试）: ' + e.message);
  }).then(() => {
    log('等待 ' + (CONFIG.CHECK_INTERVAL_SEC / 60) + ' 分钟后下一轮 ...');
    setTimeout(loop, CONFIG.CHECK_INTERVAL_SEC * 1000);
  });
}

// ==================== node_modules 瘦身 ====================
// PeekPro 的依赖安装会把 package-lock 里列出的 esbuild 全平台二进制（26 个平台约 260MB）
// 全部装进 node_modules（npm 只装当前平台一个）。每次启动时删除非当前平台目录，
// 避免更新触发依赖重装后项目体积膨胀。
function dirSizeSync(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      let st;
      try { st = fs.lstatSync(p); } catch (e) { continue; }
      if (st.isDirectory()) stack.push(p);
      else total += st.size;
    }
  }
  return total;
}

function pruneEsbuildPlatforms() {
  try {
    const dir = path.join(__dirname, 'node_modules', '@esbuild');
    if (!fs.existsSync(dir)) return;
    // esbuild 按 process.platform-process.arch 解析二进制，保留当前平台一个即可
    const keep = new Set([process.platform + '-' + process.arch]);
    let freed = 0;
    let removed = 0;
    for (const name of fs.readdirSync(dir)) {
      if (keep.has(name)) continue;
      const p = path.join(dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      freed += dirSizeSync(p);
      fs.rmSync(p, { recursive: true, force: true });
      removed++;
    }
    if (removed > 0) {
      log('[auto-update] esbuild 瘦身: 删除 ' + removed + ' 个非当前平台二进制，释放 ' +
        (freed / 1048576).toFixed(1) + ' MB（保留 ' + Array.from(keep).join(', ') + '）');
    }
  } catch (e) {
    log('[auto-update] esbuild 瘦身失败（不影响服务）: ' + e.message);
  }
}

// 清理 release 模式遗留的单文件产物（zip 模式下无用，白占 ~12MB）
// 仅当 MODE=zip 时清理；release/both 模式保留
function cleanReleaseLeftovers() {
  try {
    if (CONFIG.MODE !== 'zip') return;
    let freed = 0;
    for (const f of [CONFIG.DOWNLOAD_FILE, CONFIG.DOWNLOAD_FILE + '.bak']) {
      const p = path.join(CONFIG.DOWNLOAD_DIR, f);
      let st;
      try { st = fs.statSync(p); } catch (e) { continue; }
      freed += st.size;
      fs.rmSync(p, { force: true });
      log('[auto-update] 清理 release 模式遗留文件: ' + p);
    }
    if (freed > 0) log('[auto-update] 遗留清理共释放 ' + (freed / 1048576).toFixed(1) + ' MB');
  } catch (e) {
    log('[auto-update] 遗留清理失败（不影响服务）: ' + e.message);
  }
}

// PeekPro 依赖安装器装的是包的完整源码（含 TS 源码目录、根目录 bundle、lib/ 等
// 构建中间物），而 npm 只装 package.json 声明的 files 白名单内容。
// 启动时按白名单剪裁各包顶层多余文件，使安装内容与 npm 一致。
function prunePackagesToFilesWhitelist() {
  const ALWAYS_KEEP = new Set(['package.json', 'README.md', 'LICENSE', 'LICENSE.md', 'CHANGELOG.md', 'NOTICE', 'NOTICE.md', 'AUTHORS', 'HISTORY.md']);
  const nm = path.join(__dirname, 'node_modules');
  if (!fs.existsSync(nm)) return;
  const pkgDirs = [];
  for (const name of fs.readdirSync(nm)) {
    if (name.startsWith('.')) continue;
    const p = path.join(nm, name);
    let st;
    try { st = fs.lstatSync(p); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    if (name.startsWith('@')) {
      for (const sub of fs.readdirSync(p)) pkgDirs.push(path.join(p, sub));
    } else {
      pkgDirs.push(p);
    }
  }
  let freed = 0;
  let touched = 0;
  for (const dir of pkgDirs) {
    try {
      const pjPath = path.join(dir, 'package.json');
      if (!fs.existsSync(pjPath)) continue;
      const pj = JSON.parse(fs.readFileSync(pjPath, 'utf8'));
      const files = pj.files;
      if (!Array.isArray(files) || files.length === 0) continue; // 无白名单则无法判断，跳过
      const roots = new Set();
      for (const f of files) {
        if (typeof f !== 'string' || f.startsWith('!')) continue;
        roots.add(f.split('/')[0].split('*')[0]); // 'dist/**' -> 'dist'；'*.js' -> ''(全保留)
      }
      // 安全检查：入口（main/module/bin/exports）必须在白名单内，否则跳过该包
      const entryRels = [];
      for (const k of ['main', 'module']) if (pj[k]) entryRels.push(String(pj[k]));
      if (pj.bin) {
        if (typeof pj.bin === 'string') entryRels.push(pj.bin);
        else Object.values(pj.bin).forEach(v => entryRels.push(String(v)));
      }
      const collectExports = (v) => {
        if (typeof v === 'string') entryRels.push(v);
        else if (v && typeof v === 'object') Object.values(v).forEach(collectExports);
      };
      collectExports(pj.exports);
      let safe = true;
      for (const e of entryRels) {
        const root = e.replace(/^\.\//, '').split('/')[0];
        if (!roots.has(root) && !roots.has('')) { safe = false; break; }
      }
      if (!safe) continue;
      for (const name of fs.readdirSync(dir)) {
        if (ALWAYS_KEEP.has(name) || name.startsWith('.')) continue;
        if (roots.has(name) || roots.has('')) continue;
        const p = path.join(dir, name);
        let st2;
        try { st2 = fs.lstatSync(p); } catch (e) { continue; }
        freed += st2.isDirectory() ? dirSizeSync(p) : st2.size;
        fs.rmSync(p, { recursive: true, force: true });
        touched++;
      }
    } catch (e) { /* 单包失败忽略 */ }
  }
  if (touched > 0) {
    log('[auto-update] 包白名单剪裁: 删除 ' + touched + ' 个白名单外冗余文件/目录，释放 ' + (freed / 1048576).toFixed(1) + ' MB');
  }
}

// ==================== 内嵌启动入口 ====================
// 供 danmu_api/server.js require 后调用：每次启动服务检查一次更新（有变化才动作）
// 如需恢复定时循环，设置 AUTO_UPDATE_LOOP=true
function startAutoUpdate(opts) {
  opts = opts || {};
  const delaySec = typeof opts.delaySec === 'number' ? opts.delaySec : 0;
  log('[auto-update] 已随弹幕服务挂载，' + delaySec + ' 秒后检查更新（每次启动检查一次' +
    (CONFIG.LOOP ? '，并每 ' + (CONFIG.CHECK_INTERVAL_SEC / 60) + ' 分钟循环' : '') +
    '；模式 ' + CONFIG.MODE +
    '；源码 ' + CONFIG.ZIP_OWNER + '/' + CONFIG.ZIP_REPO + ' → ' + CONFIG.TARGET_DIR +
    '；Release ' + CONFIG.RELEASE_OWNER + '/' + CONFIG.RELEASE_REPO + ' → ' + CONFIG.DOWNLOAD_DIR + '）');
  setTimeout(() => {
    pruneEsbuildPlatforms();
    cleanReleaseLeftovers();
    prunePackagesToFilesWhitelist();
    if (CONFIG.LOOP) { loop(); return; }
    runOnce().then((r) => {
      log('[auto-update] 启动检查完成: ' + JSON.stringify(r));
    }).catch((e) => {
      log('[auto-update] 启动检查出错（忽略）: ' + e.message);
    });
  }, delaySec * 1000);
  return true;
}

// ==================== 入口（仅独立运行时执行） ====================
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--test')) {
    testPush().then((ok) => {
      log('测试推送: ' + (ok ? '成功' : '跳过/失败'));
      process.exit(ok ? 0 : 1);
    }).catch((e) => {
      log('测试推送异常: ' + e.message);
      process.exit(1);
    });
  } else if (args.includes('--once')) {
    runOnce().then((r) => {
      log('单次执行完成: ' + JSON.stringify(r));
      process.exit(0);
    }).catch((e) => {
      log('单次执行失败: ' + e.message);
      process.exit(1);
    });
  } else {
    log('启动循环监控，间隔 ' + (CONFIG.CHECK_INTERVAL_SEC / 60) + ' 分钟');
    loop();
  }
}

module.exports = { CONFIG, runOnce, runOnceZip, runOnceRelease, loop, testPush, startAutoUpdate, pushQq, parseZipEntries, extractZip, patchServerJs, pruneEsbuildPlatforms, cleanReleaseLeftovers, prunePackagesToFilesWhitelist };
