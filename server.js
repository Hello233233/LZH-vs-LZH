'use strict';
/* ============================================================
   王建文大战王精文 · 局域网联机服务器
   - 零依赖：只用 Node 内置模块（http / crypto / os / fs）
   - 静态托管本目录的游戏文件
   - 手写 WebSocket（握手 + 帧解析），用于房间与消息中继
   用法： node server.js   （或双击「启动联机.bat」）
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const NO_OPEN = !!process.env.NO_OPEN;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/* ---------------- HTTP 静态服务 ---------------- */
const server = http.createServer((req, res) => {
  let urlPath = '/';
  try { urlPath = decodeURIComponent((req.url || '/').split('?')[0]); } catch (e) { urlPath = '/'; }
  if (urlPath === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 not found'); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

/* ---------------- WebSocket 基础 ---------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const clients = new Set();
const rooms = new Map(); // code -> { code, host, guest, created }

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length]);
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([header, payload]);
}

class Peer {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.alive = true;
    this.room = null;
    this.role = null; // 'host' | 'guest'
    clients.add(this);
    socket.on('data', (chunk) => this.onData(chunk));
    socket.on('close', () => this.destroy());
    socket.on('error', () => this.destroy());
  }
  send(obj) {
    if (!this.alive) return;
    try { this.socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) { this.destroy(); }
  }
  onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2); off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2)); off = 10;
        if (len > 1 << 20) { this.destroy(); return; }
      }
      let mask = null;
      if (masked) {
        if (this.buf.length < off + 4) return;
        mask = this.buf.subarray(off, off + 4); off += 4;
      }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);

      if (opcode === 0x8) { this.destroy(); return; }
      if (opcode === 0x9) {
        try { this.socket.write(Buffer.from([0x8a, payload.length])); } catch (e) {}
        continue;
      }
      if (opcode !== 0x1) continue;

      let data = payload;
      if (mask) {
        data = Buffer.allocUnsafe(len);
        for (let i = 0; i < len; i++) data[i] = payload[i] ^ mask[i & 3];
      }
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (e) { continue; }
      this.handle(msg);
    }
  }
  handle(msg) {
    if (!msg || typeof msg.p !== 'string') return;
    const peer = this.peer();
    switch (msg.p) {
      case 'ping': this.send({ p: 'pong', t: msg.t }); return;
      case 'create': {
        if (this.room) return;
        const code = makeCode();
        const room = { code, host: this, guest: null, created: Date.now() };
        rooms.set(code, room);
        this.room = room; this.role = 'host';
        this.send({ p: 'room', code, role: 'host' });
        log('房间 ' + code + ' 已创建，等待对手…');
        return;
      }
      case 'join': {
        if (this.room) return;
        const code = String(msg.code || '').trim();
        const room = rooms.get(code);
        if (!room) { this.send({ p: 'err', msg: '房间不存在' }); return; }
        if (room.guest) { this.send({ p: 'err', msg: '房间已满' }); return; }
        room.guest = this;
        this.room = room; this.role = 'guest';
        this.send({ p: 'room', code, role: 'guest' });
        room.host.send({ p: 'peer', on: true });
        this.send({ p: 'peer', on: true });
        log('房间 ' + code + ' 对手已加入');
        return;
      }
      case 'leave': this.leaveRoom(); return;
      default: break;
    }
    if (peer) peer.send(msg);
  }
  peer() {
    if (!this.room) return null;
    return this.role === 'host' ? this.room.guest : this.room.host;
  }
  leaveRoom() {
    const room = this.room;
    const peer = this.peer();
    if (peer) peer.send({ p: 'peer', on: false });
    if (room) {
      if (room.host === this) {
        if (room.guest) { room.guest.room = null; room.guest.role = null; }
        rooms.delete(room.code);
        log('房间 ' + room.code + ' 已关闭');
      } else if (room.guest === this) {
        room.guest = null;
        log('房间 ' + room.code + ' 对手离开');
      }
    }
    this.room = null; this.role = null;
  }
  destroy() {
    if (!this.alive) return;
    this.alive = false;
    clients.delete(this);
    this.leaveRoom();
    try { this.socket.destroy(); } catch (e) {}
  }
}

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    socket.destroy();
    return;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  new Peer(socket);
});

let seq = 0;
function makeCode() {
  for (let i = 0; i < 200; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000));
    if (!rooms.has(c)) return c;
  }
  return String(1000 + (++seq % 9000));
}

/* ---------------- 日志 ---------------- */
const ts = () => new Date().toTimeString().slice(0, 8);
function log(msg) { console.log('  [' + ts() + '] ' + msg); }

/* ---------------- 启动 ---------------- */
function lanAddresses() {
  const out = [];
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ name, address: info.address });
    }
  }
  out.sort((a, b) => {
    const rank = (x) => (x.address.startsWith('26.') ? 0 : x.address.startsWith('192.168.') ? 1 : x.address.startsWith('10.') ? 2 : 3);
    return rank(a) - rank(b);
  });
  return out;
}

function startServer(port, triesLeft) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && triesLeft > 0) {
      console.log('  [!] 端口 ' + port + ' 已被占用，尝试 ' + (port + 1) + ' …');
      startServer(port + 1, triesLeft - 1);
      return;
    }
    console.log('');
    console.log('  启动失败：' + err.message);
    console.log('  端口被占用时可以先关掉占用程序，或设置环境变量 PORT 换一个端口。');
    process.exit(1);
  });

  server.listen(port, '0.0.0.0', () => {
    if (port !== PORT) console.log('  [!] 实际使用端口：' + port);
    const list = lanAddresses();
    const line = '='.repeat(58);
    console.log('');
    console.log(line);
    console.log('   王建文 大战 王精文 · 联机服务器已启动');
    console.log(line);
    console.log('');
    console.log('   本机打开：   http://localhost:' + port);
    if (list.length) {
      console.log('   局域网/Radmin 地址（把下面任意一条发给对手）：');
      for (const it of list) {
        const tag = it.address.startsWith('26.') ? '  <- Radmin VPN' : '';
        console.log('       http://' + it.address + ':' + port + tag);
      }
    } else {
      console.log('   未检测到局域网网卡，请确认 Radmin VPN 已连接。');
    }
    console.log('');
    console.log('   两边都用浏览器打开同一个地址，进游戏后点「联机对战」：');
    console.log('   一方「创建房间」拿到 4 位房间号，另一方输入房间号「加入」。');
    console.log('');
    console.log('   若 Windows 弹出防火墙提示，请选择「允许访问」。');
    console.log('   关闭本窗口即结束联机服务。');
    console.log('');
    console.log(line);
    console.log('');

    if (!NO_OPEN) {
      setTimeout(() => {
        exec('start "" "http://localhost:' + port + '"', () => {});
      }, 600);
    }
  });
}

startServer(PORT, 3);

process.on('SIGINT', () => { console.log('\n  服务已停止。'); process.exit(0); });
