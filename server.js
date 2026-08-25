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

const WEAPONS = {
  potato: { name: '🥔 じゃがいも投げ', cooldown: 350, speed: 18, radius: 1, count: 1, spread: 0 },
  chicken: { name: '🐔 ニワトリ突撃', cooldown: 650, speed: 13, radius: 2, count: 1, spread: 0, homing: true },
  chair: { name: '🪑 椅子投げ', cooldown: 900, speed: 15, radius: 2, count: 1, spread: 0 },
  sock: { name: '🧦 靴下砲', cooldown: 180, speed: 28, radius: 1, count: 1, spread: 0 },
  tinyBoom: { name: '🧨 ものすごく小さい爆発', cooldown: 1100, speed: 12, radius: 2, count: 1, spread: 0, explode: true },
  ducks: { name: '🦆 アヒル軍団', cooldown: 1600, speed: 16, radius: 1, count: 7, spread: 0.18 },
  mystery: { name: '☢️ 謎のボタン', cooldown: 2400, speed: 0, radius: 0, count: 1, spread: 0, mystery: true }
};

const players = new Map();
const projectiles = new Map();
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

function wrap(value, size) {
  return ((value % size) + size) % size;
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
      territory: countTerritory(p.id),
      weapon: p.weapon,
      weaponCooldown: Math.max(0, p.nextWeaponAt - Date.now())
    }));
}

function projectileSummary() {
  return [...projectiles.values()].map((p) => ({
    id: p.id,
    owner: p.owner,
    type: p.type,
    x: p.x,
    y: p.y,
    angle: p.angle,
    radius: p.radius,
    emoji: p.emoji
  }));
}

function stateMessage() {
  return JSON.stringify({
    type: 'state',
    grid: { w: GRID_W, h: GRID_H },
    territory: Array.from(territory),
    players: summary(),
    projectiles: projectileSummary(),
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
  projectiles.clear();
  for (const player of players.values()) {
    player.alive = true;
    const [x, y] = spawnPositions[player.id];
    player.x = x + 0.5;
    player.y = y + 0.5;
    player.homeX = Math.floor(x);
    player.homeY = Math.floor(y);
    player.angle = 0;
    player.weapon = 'potato';
    player.nextWeaponAt = 0;
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

function paintCircle(cx, cy, radius, ownerId) {
  const centerX = Math.round(cx);
  const centerY = Math.round(cy);
  const r2 = radius * radius;
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
      const dx = x - centerX;
      const dy = y - centerY;
      if (dx * dx + dy * dy > r2) continue;
      territory[idx(x, y)] = ownerId;
    }
  }
}

function movePlayers(dt) {
  if (!gameStarted || winner !== null) return;

  for (const player of players.values()) {
    if (!player.alive) continue;
    const radians = player.angle * Math.PI / 180;
    player.x = wrap(player.x + Math.cos(radians) * MOVE_SPEED * dt, GRID_W);
    player.y = wrap(player.y + Math.sin(radians) * MOVE_SPEED * dt, GRID_H);

    const cellX = clampInt(player.x, 0, GRID_W - 1);
    const cellY = clampInt(player.y, 0, GRID_H - 1);
    territory[idx(cellX, cellY)] = player.id;
  }
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
    if (!player.alive) player.alive = true;
  }
  eliminateIfEmpty();
  broadcast({ type: 'rain' });
  broadcastState();
}

function blackButton(sourcePlayer) {
  const centerX = sourcePlayer.x;
  const centerY = sourcePlayer.y;

  for (const player of players.values()) {
    if (!player.alive) continue;
    const offsetX = Math.floor(Math.random() * 21) - 10;
    player.x = wrap(centerX + offsetX, GRID_W);
    player.y = centerY;
    player.angle = 0;
  }

  broadcast({ type: 'blackButton', x: centerX, y: centerY });
  broadcastState();
}

function cellDistanceWrapped(x1, y1, x2, y2) {
  let dx = Math.abs(x1 - x2);
  let dy = Math.abs(y1 - y2);
  dx = Math.min(dx, GRID_W - dx);
  dy = Math.min(dy, GRID_H - dy);
  return Math.hypot(dx, dy);
}

function applyWeaponArea(ownerId, x, y, radius) {
  paintCircle(x, y, radius, ownerId);
  eliminateIfEmpty();
}

function mysteryWeapon(source) {
  const roll = Math.floor(Math.random() * 4);
  if (roll === 0) {
    for (const player of players.values()) {
      if (!player.alive || player.id === source.id) continue;
      applyWeaponArea(source.id, player.x, player.y, 6);
    }
    broadcast({ type: 'weaponEvent', kind: 'mystery', text: '☢️ 謎のボタン：敵の周囲を一気に塗った！' });
  } else if (roll === 1) {
    rainfall();
    broadcast({ type: 'weaponEvent', kind: 'mystery', text: '☢️ 謎のボタン：なぜか雨が降った！' });
  } else if (roll === 2) {
    blackButton(source);
    broadcast({ type: 'weaponEvent', kind: 'mystery', text: '☢️ 謎のボタン：全員整列！' });
  } else {
    for (const player of players.values()) {
      player.angle = 0;
    }
    broadcast({ type: 'weaponEvent', kind: 'mystery', text: '☢️ 謎のボタン：全員右向き！' });
    broadcastState();
  }
}

function fireWeapon(player) {
  if (!player.alive || !gameStarted) return;
  const now = Date.now();
  const weapon = WEAPONS[player.weapon];
  if (!weapon || now < player.nextWeaponAt) return;
  player.nextWeaponAt = now + weapon.cooldown;

  if (weapon.mystery) {
    mysteryWeapon(player);
    return;
  }

  for (let i = 0; i < weapon.count; i++) {
    const spread = weapon.count > 1 ? (i - (weapon.count - 1) / 2) * weapon.spread : 0;
    const angle = player.angle * Math.PI / 180 + spread;
    const id = crypto.randomBytes(8).toString('hex');
    projectiles.set(id, {
      id,
      owner: player.id,
      type: player.weapon,
      x: player.x,
      y: player.y,
      angle,
      speed: weapon.speed,
      radius: weapon.radius,
      homing: !!weapon.homing,
      explode: !!weapon.explode,
      emoji: player.weapon === 'potato' ? '🥔' :
        player.weapon === 'chicken' ? '🐔' :
        player.weapon === 'chair' ? '🪑' :
        player.weapon === 'sock' ? '🧦' :
        player.weapon === 'tinyBoom' ? '🧨' : '🦆'
    });
  }
  broadcastState();
}

function seekHomingTarget(projectile) {
  let best = null;
  let bestDistance = Infinity;
  for (const player of players.values()) {
    if (!player.alive || player.id === projectile.owner) continue;
    const d = cellDistanceWrapped(projectile.x, projectile.y, player.x, player.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = player;
    }
  }
  if (!best || bestDistance > 15) return;
  const targetAngle = Math.atan2(best.y - projectile.y, best.x - projectile.x);
  const diff = Math.atan2(Math.sin(targetAngle - projectile.angle), Math.cos(targetAngle - projectile.angle));
  projectile.angle += Math.sign(diff) * Math.min(Math.abs(diff), 0.05);
}

function projectileHitsPlayer(projectile) {
  for (const target of players.values()) {
    if (!target.alive || target.id === projectile.owner) continue;
    if (cellDistanceWrapped(projectile.x, projectile.y, target.x, target.y) <= 1.4 + projectile.radius) {
      applyWeaponArea(projectile.owner, projectile.x, projectile.y, projectile.radius);
      if (projectile.explode) {
        applyWeaponArea(projectile.owner, projectile.x, projectile.y, 3);
        broadcast({ type: 'explosion', x: projectile.x, y: projectile.y });
      }
      return true;
    }
  }
  return false;
}

function projectileReachedScreenEdge(projectile, previousX, previousY) {
  // Unlike players, projectiles do NOT wrap around. They remain alive until
  // their path actually reaches a screen edge, then disappear.
  return projectile.x <= 0 || projectile.x >= GRID_W - 1 || projectile.y <= 0 || projectile.y >= GRID_H - 1;
}

function updateProjectiles(dt) {
  for (const [id, projectile] of projectiles) {
    if (projectile.homing) seekHomingTarget(projectile);

    const previousX = projectile.x;
    const previousY = projectile.y;
    projectile.x += Math.cos(projectile.angle) * projectile.speed * dt;
    projectile.y += Math.sin(projectile.angle) * projectile.speed * dt;

    // Paint continuously while flying, but never remove the projectile for a hit.
    if (projectile.radius > 0) {
      paintCircle(projectile.x, projectile.y, projectile.radius, projectile.owner);
    }

    projectileHitsPlayer(projectile);

    if (projectileReachedScreenEdge(projectile, previousX, previousY)) {
      projectiles.delete(id);
    }
  }
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
    weapon: 'potato',
    nextWeaponAt: 0,
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
      angle: player.angle,
      weapon: player.weapon
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
    } else if (data.action === 'weapon') {
      const weapon = String(data.weapon);
      if (WEAPONS[weapon]) player.weapon = weapon;
      broadcastState();
    } else if (data.action === 'fire') {
      fireWeapon(player);
    }
  });

  ws.on('close', () => {
    players.delete(player.token);
    for (const [id, projectile] of projectiles) {
      if (projectile.owner === player.id) projectiles.delete(id);
    }
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
  updateProjectiles(dt);
  eliminateIfEmpty();
  if (gameStarted) broadcastState();
}, 1000 / TICK_RATE);

server.listen(PORT, HOST, () => {
  console.log(`Territory Battle server listening on http://${HOST}:${PORT}`);
  console.log(`LAN URL: http://<server-ip>:${PORT}/`);
});
