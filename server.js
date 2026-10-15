const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const MIME = {
  '.html':'text/html;charset=utf-8',
  '.png':'image/png',
  '.jpg':'image/jpeg',
  '.jpeg':'image/jpeg',
  '.gif':'image/gif',
  '.webp':'image/webp',
};

function readFile(name) {
  return fs.readFileSync(path.join(__dirname, name));
}

// ── WebSocket ──────────────────────────────────────────────────────────────────
function wsHandshake(req, socket) {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
}

function wsSend(socket, obj) {
  if (!socket || socket.destroyed) return;
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const len = buf.length;
  let h;
  if (len < 126) { h = Buffer.alloc(2); h[0] = 0x81; h[1] = len; }
  else { h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(len, 2); }
  try { socket.write(Buffer.concat([h, buf])); } catch (e) {}
}

function parseFrames(socket, cb) {
  let buf = Buffer.alloc(0);
  socket.on('data', chunk => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 2) {
      const masked = (buf[1] & 0x80) !== 0;
      let pLen = buf[1] & 0x7f, off = 2;
      if (pLen === 126) { if (buf.length < 4) return; pLen = buf.readUInt16BE(2); off = 4; }
      const mLen = masked ? 4 : 0;
      if (buf.length < off + mLen + pLen) return;
      const mask = masked ? buf.slice(off, off + 4) : null;
      off += mLen;
      const payload = Buffer.from(buf.slice(off, off + pLen));
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.slice(off + pLen);
      try { cb(JSON.parse(payload.toString('utf8'))); } catch (e) {}
    }
  });
}

// ── Game state ─────────────────────────────────────────────────────────────────
const game = {
  phase: 'lobby',   // lobby | playing
  groups: [],       // [{id, name, color, score}]
  question: null,   // {action, label} | null
  answered: [],     // group ids that already scored this round
};

const GROUP_NAMES  = ['', '紅隊', '藍隊', '綠隊', '橙隊', '紫隊', '青隊', '粉隊'];
const GROUP_COLORS = ['', '#E53935', '#1E88E5', '#43A047', '#FB8C00', '#8E24AA', '#00ACC1', '#F06292'];

let mainSocket  = null;
let adminSocket = null;
const remotes   = new Map(); // socket -> groupId

function sendTo(socket, obj) { wsSend(socket, obj); }

function broadcastScores() {
  const payload = { type: 'scores', groups: game.groups };
  if (mainSocket)  wsSend(mainSocket,  payload);
  if (adminSocket) wsSend(adminSocket, payload);
  remotes.forEach((_, s) => wsSend(s, payload));
}

// ── HTTP ───────────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const map = {
    '/': 'index.html', '/index.html': 'index.html',
    '/admin': 'admin.html', '/admin.html': 'admin.html',
    '/remote': 'remote.html', '/remote.html': 'remote.html',
  };
  const file = map[urlPath];
  if (!file) {
    // Try serving static image files
    const ext = path.extname(urlPath).toLowerCase();
    const mime = MIME[ext];
    if (mime) {
      const filePath = path.join(__dirname, urlPath.slice(1));
      if (fs.existsSync(filePath)) {
        res.writeHead(200, { 'Content-Type': mime });
        res.end(fs.readFileSync(filePath));
        return;
      }
    }
    res.writeHead(404); res.end(); return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html;charset=utf-8' });
  res.end(readFile(file));
});

// ── WebSocket upgrade ──────────────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  if (head && head.length) socket.unshift(head);
  wsHandshake(req, socket);
  const urlPath = req.url.split('?')[0];

  // ── Main display ──
  if (urlPath === '/ws-main') {
    mainSocket = socket;
    console.log('Main display connected');
    socket.on('close', () => { mainSocket = null; });
    socket.on('error', () => { mainSocket = null; });
    // Send current state on connect
    wsSend(socket, { type: 'init', game: publicGame() });
    parseFrames(socket, () => {});
  }

  // ── Admin ──
  else if (urlPath === '/ws-admin') {
    adminSocket = socket;
    console.log('Admin connected');
    socket.on('close', () => { adminSocket = null; });
    socket.on('error', () => { adminSocket = null; });
    wsSend(socket, { type: 'init', game: publicGame() });
    parseFrames(socket, msg => handleAdmin(msg));
  }

  // ── Remote ──
  else if (urlPath === '/ws-remote') {
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const groupId = parseInt(params.get('group')) || 1;
    remotes.set(socket, groupId);
    console.log(`Remote group=${groupId} connected (total ${remotes.size})`);

    socket.on('close', () => {
      remotes.delete(socket);
      if (adminSocket) wsSend(adminSocket, { type: 'remote_count', count: remotes.size });
    });
    socket.on('error', () => remotes.delete(socket));

    // Tell this remote its group and current question state
    wsSend(socket, { type: 'init', game: publicGame(), groupId });
    if (adminSocket) wsSend(adminSocket, { type: 'remote_count', count: remotes.size });

    parseFrames(socket, msg => handleRemote(msg, socket, groupId));
  }
});

function publicGame() {
  return {
    phase: game.phase,
    groups: game.groups,
    question: game.question,
    answered: game.answered,
  };
}

// ── Admin message handler ──────────────────────────────────────────────────────
function handleAdmin(msg) {
  if (msg.type === 'start_game') {
    const count = Math.max(2, Math.min(7, parseInt(msg.groupCount) || 4));
    game.groups = Array.from({ length: count }, (_, i) => ({
      id: i + 1, name: GROUP_NAMES[i + 1], color: GROUP_COLORS[i + 1], score: 0,
    }));
    game.phase    = 'playing';
    game.question = null;
    game.answered = [];
    console.log(`Game started with ${count} groups`);
    broadcast({ type: 'game_started', groups: game.groups });
  }

  if (msg.type === 'set_question') {
    game.question = { action: msg.action, label: msg.label };
    game.answered = [];
    console.log(`Question set: ${msg.action}`);
    // Tell everyone about the new question
    broadcast({ type: 'question', action: msg.action, label: msg.label });
  }

  if (msg.type === 'end_question') {
    game.question = null;
    game.answered = [];
    broadcast({ type: 'question_end' });
  }

  if (msg.type === 'reset_game') {
    game.phase    = 'lobby';
    game.groups   = [];
    game.question = null;
    game.answered = [];
    broadcast({ type: 'game_reset' });
  }

  if (msg.type === 'adjust_score') {
    const g = game.groups.find(g => g.id === msg.groupId);
    if (g) {
      g.score = Math.max(0, g.score + msg.delta);
      broadcastScores();
    }
  }
}

// ── Remote message handler ─────────────────────────────────────────────────────
function handleRemote(msg, socket, groupId) {
  if (msg.type !== 'answer') return;
  if (!game.question) return;
  if (msg.action !== game.question.action) return;       // wrong action
  if (game.answered.includes(groupId)) return;           // already scored

  game.answered.push(groupId);
  const rank = game.answered.length;   // 1 = fastest
  const pts  = rank === 1 ? 2 : 1;    // fastest +2, others +1

  const group = game.groups.find(g => g.id === groupId);
  if (group) group.score += pts;

  console.log(`Group ${groupId} correct! rank=${rank} +${pts}pts`);

  // Tell main display to animate + show flash
  if (mainSocket) wsSend(mainSocket, {
    type: 'correct',
    action: game.question.action,
    groupId, groupName: group?.name, groupColor: group?.color,
    rank, pts,
  });

  // Tell the answering device
  wsSend(socket, { type: 'correct_ack', rank, pts });

  // Update scores on all screens
  broadcastScores();
}

function broadcast(obj) {
  if (mainSocket)  wsSend(mainSocket,  obj);
  if (adminSocket) wsSend(adminSocket, obj);
  remotes.forEach((_, s) => wsSend(s, obj));
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
