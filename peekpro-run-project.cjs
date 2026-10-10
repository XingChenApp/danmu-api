const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const projectRoot = '/storage/emulated/0/Download/弹幕/1.20.9版（自动更新版）danmu_api/danmu_api';
const entryPath = '/storage/emulated/0/Download/弹幕/1.20.9版（自动更新版）danmu_api/danmu_api/danmu_api/server.js';
const logPath = path.join(projectRoot, 'peekpro_node_project.log');
function log(message) {
  const line = '[' + new Date().toISOString() + '] ' + message;
  try { fs.appendFileSync(logPath, line + '\n', 'utf8'); } catch (_) {}
  originalConsoleLog(line);
}
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
function formatLogArgs(args) {
  return args.map((value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch (_) { return String(value); }
  }).join(' ');
}
function appendProjectLog(level, args) {
  const line = '[' + new Date().toISOString() + '] [' + level + '] ' + formatLogArgs(args);
  try { fs.appendFileSync(logPath, line + '\n', 'utf8'); } catch (_) {}
}
console.log = (...args) => {
  appendProjectLog('LOG', args);
  originalConsoleLog(...args);
};
console.error = (...args) => {
  appendProjectLog('ERROR', args);
  originalConsoleError(...args);
};
process.on('uncaughtException', (error) => {
  appendProjectLog('UNCAUGHT', [error]);
});
process.on('unhandledRejection', (reason) => {
  appendProjectLog('REJECTION', [reason]);
});
try { process.chdir(projectRoot); } catch (_) {}
log('Starting: ' + entryPath);
import(pathToFileURL(entryPath).href)
  .then(() => log('Entry module loaded'))
  .catch((error) => {
    log('Startup failed: ' + (error && error.stack ? error.stack : error));
    throw error;
  });
