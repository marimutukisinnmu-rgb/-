const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const GRID_W = 120;
const GRID_H = 80;
const MAX_PLAYERS = 10;
const TICK_RATE = 60;
const TURN_INTERVAL_MS = 10;
const TURN_ANGLE = 15;
const MOVE_SPEED = 7;

const COLORS = [
  '#ff4d4d', '#4d8dff', '#4dff88', '#ffd24d', '#b84dff',
  '#ff7ad9', '#4de3ff', '#ff914d', '#8dff4d', '#7777ff'
];

const players = new Map();
const territory = new Int16Array(GRID_W * GRID_H);
territory.fill(-1);

let gameStarted = false;
let winner = null;
let gameResetTimer = null;

function idx(x, y) {
  return y * GRID_W + x;
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.floor(value)));
}

const spawnPositions = [
  [5, 5], [GRID_W - 6, GRID_H - 6],
  [GRID_W - 6, 5], [5, GRID_H - 6],
  [GRID_W / 2, 5], [GRID_W / 2, GRID_H - 6],
  [5, GRID_H / 2], [GRID_W - 6, GRID_H / 2],
  [GRID_W / 3, GRID_H / 3], [GRID_W * 2 / 3, GRID_H * 2 / 3]
];

function usedIds() {
  return new Set([...players.values()].map((p) => p.id));
}

function assignPlayerId() {
  const used = usedIds();
  for (let id = 0; id < MAX_PLAYERS; id++) {
    if (!used.has(id)) return id;
  }
  return null;
}

function paintHome(player) {
  const radius = 3;
  const cx = clampInt(player.homeX, 0, GRID_W - 1);
  const cy = clampInt(player.homeY, 0, GRID_H - 1);
  for (let oy = -radius; oy <= radius; oy++) {
    for (let ox = -radius; ox <= radius; ox++) {
      const x = cx + ox;
      const y = cy + oy;
      if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) {
        territory[idx(x, y)] = player.id;
      }
    }
  }
}

function countTerritory(id) {
  let count = 0;
  for (const owner of territory) {
    if (owner === id) count++;
  }
  return count;
}

function alivePlayers() {
  return [...players.values()].filter((p) => p.alive && countTerritory(p.id) > 0);
}

function summary() {
  return [...players.values()]
    .sort((a, b) => a.id - b.id)
    .map((p) => ({
      id: p.id,
      color: p.color,
      x: p.x,
      y: p.y,
      angle: p.angle,
      alive: p.alive,
      territory: countTerritory(p.id)
    }));
}

function stateMessage() {
  return JSON.stringify({
    type: 'state',
    grid: { w: GRID_W, h: GRID_H },
    territory: Array.from(territory),
    players: summary(),
    started: gameStarted,
    winner
  });
}

function broadcast(payload) {
  const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const player of players.values()) {
    if (player.ws.readyState === 1) player.ws.send(message);
  }
}

function broadcastState() {
  broadcast(stateMessage());
}

function resetTerritory() {
  territory.fill(-1);
  for (const player of players.values()) {
    player.alive = true;
    const [x, y] = spawnPositions[player.id];
    player.x = x + 0.5;
    player.y = y + 0.5;
    player.homeX = Math.floor(x);
    player.homeY = Math.floor(y);
    player.angle = 0;
    paintHome(player);
  }
}

function startNewRound() {
  clearTimeout(gameResetTimer);
  winner = null;
  gameStarted = players.size >= 2;
  resetTerritory();
  broadcastState();
}

function eliminateIfEmpty() {
  for (const player of players.values()) {
    if (player.alive && countTerritory(player.id) === 0) {
      player.alive = false;
    }
  }

  const alive = alivePlayers();
  if (gameStarted && alive.length === 1) {
    winner = alive[0].id;
    gameStarted = false;
    broadcastState();
    gameResetTimer = setTimeout(() => {
      if (players.size >= 2) startNewRound();
    }, 4000);
  }
}

function movePlayers(dt) {
  if (!gameStarted || winner !== null) return;

  for (const player of players.values()) {
    if (!player.alive) continue;
    const radians = player.angle * Math.PI / 180;
    player.x += Math.cos(radians) * MOVE_SPEED * dt;
    player.y += Math.sin(radians) * MOVE_SPEED * dt;

    player.x = (player.x + GRID_W) % GRID_W;
    player.y = (player.y + GRID_H) % GRID_H;

    const cellX = clampInt(player.x, 0, GRID_W - 1);
    const cellY = clampInt(player.y, 0, GRID_H - 1);
    territory[idx(cellX, cellY)] = player.id;
  }

  eliminateIfEmpty();
}

function rainfall() {
  for (const player of players.values()) {
    for (let i = 0; i < territory.length; i++) {
      if (territory[i] === player.id) territory[i] = -1;
    }
    territory[idx(player.homeX, player.homeY)] = player.id;
    player.x = player.homeX + 0.5;
    player.y = player.homeY + 0.5;
    player.angle = 0;
    if (player.alive) player.alive = true;
  }
  eliminateIfEmpty();
  broadcast({ type: 'rain' });
  broadcastState();
}

// 真っ黒なボタン：発動者を中心に、全員を同じYへ集める。
// Xは発動者の位置を中心として -10 ～ +10 のランダムな範囲に配置し、
// 全員の方向を0°（右向き）にする。
function blackButton(sourcePlayer) {
  const centerX = sourcePlayer.x;
  const centerY = sourcePlayer.y;

  for (const player of players.values()) {
    if (!player.alive) continue;
    const offsetX = Math.floor(Math.random() * 21) - 10;
    player.x = (centerX + offsetX + GRID_W) % GRID_W;
    player.y = centerY;
    player.angle = 0;
  }

  broadcast({
    type: 'blackButton',
    x: centerX,
    y: centerY
  });
  broadcastState();
}

function createPlayer(ws) {
  if (players.size >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ type: 'error', message: '満員です（最大10人）' }));
    ws.close();
    return null;
  }

  const id = assignPlayerId();
  if (id === null) return null;

  const [x, y] = spawnPositions[id];
  const token = crypto.randomBytes(16).toString('hex');
  const player = {
    token,
    id,
    color: COLORS[id],
    ws,
    x: x + 0.5,
    y: y + 0.5,
    angle: 0,
    alive: true,
    homeX: Math.floor(x),
    homeY: Math.floor(y),
    lastTurnAt: 0
  };

  players.set(token, player);
  paintHome(player);
  if (players.size >= 2) gameStarted = true;

  ws.send(JSON.stringify({
    type: 'welcome',
    token,
    player: {
      id: player.id,
      color: player.color,
      x: player.x,
      y: player.y,
      angle: player.angle
    }
  }));
  broadcastState();
  return player;
}

const root = __dirname;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

const server = http.createServer((req, res) => {
  const requestPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const relativePath = requestPath === '/' ? 'static/index.html' : requestPath.replace(/^\/+/, '');
  const fullPath = path.resolve(root, relativePath);

  if (!fullPath.startsWith(root + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(fullPath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': mime[path.extname(fullPath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const player = createPlayer(ws);
  if (!player) return;

  ws.on('message', (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!player.alive) return;

    if (data.action === 'turn') {
      const now = Date.now();
      if (now - player.lastTurnAt < TURN_INTERVAL_MS) return;
      const direction = Number(data.direction);
      if (direction !== -1 && direction !== 1) return;
      player.angle = (player.angle + TURN_ANGLE * direction + 360) % 360;
      player.lastTurnAt = now;
    } else if (data.action === 'rain') {
      rainfall();
    } else if (data.action === 'blackButton') {
      blackButton(player);
    }
  });

  ws.on('close', () => {
    players.delete(player.token);
    if (players.size < 2) gameStarted = false;
    broadcastState();
  });
});

let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - lastTick) / 1000, 0.1);
  lastTick = now;
  movePlayers(dt);
  if (gameStarted) broadcastState();
}, 1000 / TICK_RATE);

server.listen(PORT, HOST, () => {
  console.log(`Territory Battle server listening on http://${HOST}:${PORT}`);
  console.log(`LAN URL: http://<server-ip>:${PORT}/`);
});
