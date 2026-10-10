#!/usr/bin/env node
/* =====================================================
 * danmu_api_release_downloader.js — danmu_api 单文件 Release 下载器（精简版）
 * -----------------------------------------------------
 * 功能：
 *   1. 持续检测【我的仓库】构建发布的最新 Release
 *   2. 有新的 release 包 → 下载 danmu_api.js 覆盖本地单文件
 *      （自动备份旧文件 .bak）
 *   3. QQ 推送通知（可选：配置留空 = 默认不推送）
 *
 * 运行环境：Android 手机 Node.js（纯内置模块，零外部依赖）
 * 代理：CONNECT 隧道（mihomo 7890）
 *
 * 用法：
 *   node danmu_api_release_downloader.js          # 循环监控（默认间隔 3600s）
 *   node danmu_api_release_downloader.js --once   # 单次检测+下载
 *   node danmu_api_release_downloader.js --test   # 测试 QQ 推送
 * ===================================================== */

'use strict';

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

// ==================== 配置区（全部可改） ====================
const CONFIG = {
  // GitHub 我的仓库（检测 release 用）
  REPO_OWNER: 'yydfys',
  REPO_REPO: 'danmu_api',
  GITHUB_TOKEN: '', // 令牌（可选；留空走匿名 API，限流 60 次/h）

  // 代理（CONNECT 隧道；留空 = 不走代理直连）
  PROXY_HOST: '127.0.0.1',
  PROXY_PORT: 7890,

  // 下载目录（danmu_api.js 覆盖到这里）
  DOWNLOAD_DIR: '/storage/emulated/0/VodPlus/danmu/danmu_api/',
  DOWNLOAD_FILE: 'danmu_api.js',

  // 检查间隔（秒）
  CHECK_INTERVAL_SEC: 3600,

  // QQ 推送（推送助手 bot；三项全留空 = 不推送）
  QQ_APP_ID: '',
  QQ_CLIENT_SECRET: '',
  QQ_USER_OPENID: '',

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
  return githubApi(`/repos/${CONFIG.REPO_OWNER}/${CONFIG.REPO_REPO}/releases?per_page=1`).then((list) => {
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
  return { last_tag: '', last_download: '', last_check: '' };
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
  const loop = (n) => {
    if (n > maxRetries) { log('QQ push all failed'); return Promise.resolve(false); }
    return attempt(n).then((ok) => {
      if (ok) return true;
      return new Promise((res) => setTimeout(res, 3000)).then(() => loop(n + 1));
    });
  };
  return loop(1);
}

// ==================== 核心逻辑 ====================
// 单次：检测 release → 有新包下载覆盖 → 推送
function runOnce() {
  const state = loadState();
  log(`开始检测 ${CONFIG.REPO_OWNER}/${CONFIG.REPO_REPO} 最新 Release ...`);
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

// ==================== 入口 ====================
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
