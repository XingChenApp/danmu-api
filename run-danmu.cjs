const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');

const __dirname_custom = '/storage/emulated/0/peekpro/danmu_api';
const logFilePath = path.join(__dirname_custom, 'danmu_api.log');

function writeLog(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try { fs.appendFileSync(logFilePath, line); } catch(e) {}
  console.log(msg);
}

try { fs.writeFileSync(logFilePath, ''); } catch(e) {}

writeLog('[danmu-start] 启动脚本开始');
writeLog('[danmu-start] Node.js: ' + process.version);
writeLog('[danmu-start] 平台: ' + process.platform + ' ' + process.arch);

// 设置环境变量
process.env.TOKEN = process.env.TOKEN || '87654321';
process.env.DANMU_API_PORT = process.env.DANMU_API_PORT || '9321';
process.env.NODE_ENV = 'production';

// Worker Threads 不支持 process.chdir()，通过环境变量传递工作目录
process.env.DANMU_API_WORK_DIR = __dirname_custom;

// ======== iOS fetch 兼容层 ========
// iOS Worker Threads 中 undici（内置 fetch）的底层 socket 操作受沙盒限制，
// 导致所有对外 HTTPS 请求超时。用 node:http / node:https 模块替代。
if (process.platform === 'darwin') {
  writeLog('[danmu-start] iOS 平台检测到，注入 fetch 兼容层');
  const _http = require('http');
  const _https = require('https');
  const { URL: _URL } = require('url');
  const { Readable } = require('stream');

  function _parseHeaders(raw) {
    const h = {};
    if (!raw) return h;
    if (typeof raw.forEach === 'function') { raw.forEach((v, k) => { h[k] = v; }); return h; }
    if (typeof raw === 'object') { Object.keys(raw).forEach(k => { h[k.toLowerCase()] = String(raw[k]); }); }
    return h;
  }

  globalThis.fetch = function iosFetch(input, init) {
    init = init || {};
    const urlStr = typeof input === 'string' ? input : (input && input.url ? input.url : String(input));
    const parsed = new _URL(urlStr);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? _https : _http;
    const method = (init.method || 'GET').toUpperCase();
    const headers = _parseHeaders(init.headers);
    if (!headers['user-agent']) headers['user-agent'] = 'Mozilla/5.0 (danmu-api-ios)';

    return new Promise((resolve, reject) => {
      let aborted = false;
      const opts = {
        method: method,
        headers: headers,
        rejectUnauthorized: false,
        timeout: 30000,
      };

      const req = mod.request(parsed, opts, (res) => {
        // 跟随重定向（最多 5 次）
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          const next = new _URL(res.headers.location, urlStr).href;
          res.resume();
          resolve(iosFetch(next, init));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (aborted) return;
          const buf = Buffer.concat(chunks);
          const resHeaders = {
            _raw: res.headers,
            get: (n) => { const v = res.headers[n.toLowerCase()]; return v == null ? null : String(v); },
            has: (n) => n.toLowerCase() in res.headers,
            forEach: (cb) => { for (const k in res.headers) cb(String(res.headers[k]), k); },
            entries: () => Object.entries(res.headers).map(([k, v]) => [k, String(v)])[Symbol.iterator](),
            keys: () => Object.keys(res.headers)[Symbol.iterator](),
            values: () => Object.values(res.headers).map(String)[Symbol.iterator](),
          };
          let textCalled = false;
          let cachedText = null;
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            statusText: res.statusMessage || '',
            headers: resHeaders,
            url: urlStr,
            redirected: false,
            text: async () => { if (!textCalled) { cachedText = buf.toString('utf-8'); textCalled = true; } return cachedText; },
            json: async () => { const t = buf.toString('utf-8'); return JSON.parse(t); },
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
            body: Readable.from(buf),
          });
        });
        res.on('error', (e) => { if (!aborted) reject(e); });
      });

      req.on('error', (e) => { if (!aborted) reject(e); });
      req.on('timeout', () => { aborted = true; req.destroy(); reject(new Error('iOS fetch timeout')); });

      if (init.signal) {
        if (init.signal.aborted) { aborted = true; req.destroy(); reject(new DOMException('The operation was aborted', 'AbortError')); return; }
        init.signal.addEventListener('abort', () => { aborted = true; req.destroy(); reject(new DOMException('The operation was aborted', 'AbortError')); });
      }

      if (init.body) req.write(typeof init.body === 'string' ? init.body : Buffer.from(init.body));
      req.end();
    });
  };
  writeLog('[danmu-start] iOS fetch 兼容层已注入');
}
// ======== iOS fetch 兼容层结束 ========

// 写入端口文件
let portWritten = false;
function writePortFile(port) {
  if (portWritten) return;
  try {
    fs.writeFileSync(path.join(__dirname_custom, 'server_port.txt'), port.toString());
    portWritten = true;
    writeLog('[danmu-start] 端口已写入: ' + port);
  } catch (e) {
    writeLog('[danmu-start] 写入端口失败: ' + e.message);
  }
}

// 拦截 http.Server.listen 以检测端口
const origListen = require('http').Server.prototype.listen;
require('http').Server.prototype.listen = function(...args) {
  const srv = origListen.apply(this, args);
  this.on('listening', () => {
    const addr = this.address();
    if (addr && addr.port) {
      writePortFile(addr.port);
      writeLog('[danmu-start] 服务器启动，端口: ' + addr.port);
    }
  });
  return srv;
};

process.on('uncaughtException', (e) => {
  writeLog('[ERROR] 未捕获异常: ' + e.message);
  writeLog('[ERROR] ' + e.stack);
});

process.on('unhandledRejection', (r) => {
  writeLog('[ERROR] Promise拒绝: ' + String(r));
});

// server.js 是 ES Module，必须用 import() 动态导入
const serverPath = path.join(__dirname_custom, 'danmu_api', 'server.js');
const serverUrl = pathToFileURL(serverPath).href;
writeLog('[danmu-start] 加载 (ESM): ' + serverUrl);

import(serverUrl)
  .then((m) => {
    writeLog('[danmu-start] ESM 加载成功: ' + Object.keys(m || {}).join(','));
  })
  .catch((e) => {
    writeLog('[danmu-start] 加载失败: ' + e.message);
    writeLog('[danmu-start] ' + e.stack);
  });
