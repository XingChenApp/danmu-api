const fs = require('fs');
const path = require('path');
const net = require('net');
const portsPath = path.join(__dirname, 'server_ports.json');
const ports = new Set();
try { fs.unlinkSync(portsPath); } catch (_) {}
function record(port) {
  if (!Number.isInteger(port) || port <= 0) return;
  ports.add(port);
  try {
    fs.writeFileSync(
      portsPath,
      JSON.stringify({ ports: Array.from(ports).sort((a, b) => a - b) }),
      'utf8',
    );
  } catch (_) {}
}
const originalListen = net.Server.prototype.listen;
net.Server.prototype.listen = function patchedListen(...args) {
  const result = originalListen.apply(this, args);
  this.once('listening', () => {
    const address = this.address();
    if (address && typeof address.port === 'number') record(address.port);
  });
  return result;
};
