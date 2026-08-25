const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const HOST = '0.0.0.0';
const PORT = Number(process.env.PORT || 8080);
const GRID_W = 120;
const GRID_H = 80;
const MAX_PLAYERS = 1000;
const TICK_RATE = 30;
const TURN_INTERVAL_MS = 10;
const TURN_ANGLE = 15;
const MOVE_SPEED = 7;
const MYSTERY_COOLDOWN_MS = 50_000;
const CPU_TURN_CHANCE_PER_TICK = 0.08;
const CPU_FIRE_CHANCE_PER_TICK = 0.035;

const COLORS = [
  '#ff4d4d', '#4d8dff', '#4dff88', '#ffd24d', '#b84dff',
  '#ff7ad9', '#4de3ff', '#ff914d', '#8dff4d', '#7777ff'
];

const WEAPONS = {
  potato: { speed: 18, radius: 1, count: 1, spread: 0 },
  chicken: { speed: 13, radius: 2, count: 1, spread: 0, homing: true },
  chair: { speed: 15, radius: 2, count: 1, spread: 0 },
  sock: { speed: 28, radius: 1, count: 1, spread: 0 },
  tinyBoom: { speed: 12, radius: 2, count: 1, spread: 0, explode: true },
  ducks: { speed: 16, radius: 1, count: 7, spread: 0.18 },
  mystery: { speed: 0, radius: 0, count: 1, spread: 0, mystery: true }
};
const WEAPON_KEYS = Object.keys(WEAPONS);

const players = new Map();
const projectiles = new Map();
const adminSessions = new Set();
const territory = new Int16Array(GRID_W * GRID_H);
territory.fill(-1);

let gameStarted = false;
let winner = null;
let gameResetTimer = null;

function idx(x, y) { return y * GRID_W + x; }
function clampInt(v, min, max) { return Math.max(min, Math.min(max, Math.floor(v))); }
function wrap(v, size) { return ((v % size) + size) % size; }
function colorFor(id) { return COLORS[id % COLORS.length]; }

function loadAdminPassword() {
  const file = path.join(__dirname, 'password.env');
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(/^\s*ADMIN_PASSWORD\s*=\s*(.*?)\s*$/m);
  if (!m || !m[1]) throw new Error('password.env に ADMIN_PASSWORD がありません');
  return m[1];
}
const ADMIN_PASSWORD = loadAdminPassword();

function parseCookies(req) {
  const result = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key) result[key] = decodeURIComponent(rest.join('='));
  }
  return result;
}
function isLoopback(req) {
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function isAdmin(req) {
  const sid = parseCookies(req).adminSession;
  return isLoopback(req) && sid && adminSessions.has(sid);
}
function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

const spawnPositions = [];
for (let i = 0; i < MAX_PLAYERS; i++) {
  const gx = (i * 17) % GRID_W;
  const gy = (Math.floor(i / 17) * 7) % GRID_H;
  spawnPositions.push([gx + 0.5, gy + 0.5]);
}

function nextPlayerId() {
  for (let id = 0; id < MAX_PLAYERS; id++) if (!players.has(id)) return id;
  return null;
}

function paintHome(player) {
  const r = 2;
  const cx = clampInt(player.homeX, 0, GRID_W - 1);
  const cy = clampInt(player.homeY, 0, GRID_H - 1);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) territory[idx(x, y)] = player.id;
    }
  }
}
function countTerritory(id) {
  let n = 0;
  for (const owner of territory) if (owner === id) n++;
  return n;
}
function alivePlayers() {
  return [...players.values()].filter(p => p.alive && countTerritory(p.id) > 0);
}

function summary() {
  const now = Date.now();
  return [...players.values()].sort((a, b) => a.id - b.id).map(p => ({
    id: p.id, color: p.color, x: p.x, y: p.y, angle: p.angle,
    alive: p.alive, cpu: p.cpu, territory: countTerritory(p.id), weapon: p.weapon,
    weaponCooldown: p.weapon === 'mystery' ? Math.max(0, p.nextMysteryAt - now) : 0
  }));
}
function projectileSummary() {
  return [...projectiles.values()].map(p => ({
    id: p.id, owner: p.owner, type: p.type, x: p.x, y: p.y, angle: p.angle,
    radius: p.radius, emoji: p.emoji
  }));
}
function stateMessage() {
  return JSON.stringify({
    type: 'state', grid: { w: GRID_W, h: GRID_H },
    territory: Array.from(territory), players: summary(), projectiles: projectileSummary(),
    started: gameStarted, winner, population: players.size, maxPlayers: MAX_PLAYERS
  });
}
function broadcast(payload) {
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  for (const p of players.values()) if (p.ws?.readyState === 1) p.ws.send(msg);
}
function broadcastState() { broadcast(stateMessage()); }

function resetRound() {
  territory.fill(-1);
  projectiles.clear();
  for (const p of players.values()) {
    const [x, y] = spawnPositions[p.id];
    p.alive = true;
    p.x = x; p.y = y; p.homeX = Math.floor(x); p.homeY = Math.floor(y);
    p.angle = 0; p.weapon = 'potato'; p.nextMysteryAt = 0;
    paintHome(p);
  }
}
function startNewRound() {
  clearTimeout(gameResetTimer);
  winner = null;
  gameStarted = players.size >= 2;
  resetRound();
  broadcastState();
}
function eliminateIfEmpty() {
  for (const p of players.values()) if (p.alive && countTerritory(p.id) === 0) p.alive = false;
  const alive = alivePlayers();
  if (gameStarted && alive.length === 1) {
    winner = alive[0].id;
    gameStarted = false;
    broadcastState();
    gameResetTimer = setTimeout(() => { if (players.size >= 2) startNewRound(); }, 4000);
  }
}
function paintCircle(cx, cy, radius, ownerId) {
  const centerX = Math.round(cx), centerY = Math.round(cy), r2 = radius * radius;
  for (let y = centerY - radius; y <= centerY + radius; y++) {
    for (let x = centerX - radius; x <= centerX + radius; x++) {
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) continue;
      const dx = x - centerX, dy = y - centerY;
      if (dx * dx + dy * dy <= r2) territory[idx(x, y)] = ownerId;
    }
  }
}

function rainfall() {
  for (const p of players.values()) {
    for (let i = 0; i < territory.length; i++) if (territory[i] === p.id) territory[i] = -1;
    territory[idx(p.homeX, p.homeY)] = p.id;
    p.x = p.homeX + 0.5; p.y = p.homeY + 0.5; p.angle = 0; p.alive = true;
  }
  broadcast({ type: 'rain' });
  broadcastState();
}
function blackButton(source) {
  const cx = source.x, cy = source.y;
  for (const p of players.values()) {
    if (!p.alive) continue;
    p.x = wrap(cx + Math.floor(Math.random() * 21) - 10, GRID_W);
    p.y = cy; p.angle = 0;
  }
  broadcast({ type: 'blackButton', x: cx, y: cy });
  broadcastState();
}
function mysteryWeapon(player) {
  const now = Date.now();
  if (now < player.nextMysteryAt) return;
  player.nextMysteryAt = now + MYSTERY_COOLDOWN_MS;
  if (Math.random() < 0.5) {
    rainfall();
    broadcast({ type: 'weaponEvent', kind: 'mystery', text: '☢️ 謎のボタン：🌧️ 雨！' });
  } else {
    blackButton(player);
    broadcast({ type: 'weaponEvent', kind: 'mystery', text: '☢️ 謎のボタン：⬛ 全員強制整列！' });
  }
}
function distanceWrapped(x1, y1, x2, y2) {
  let dx = Math.abs(x1 - x2), dy = Math.abs(y1 - y2);
  dx = Math.min(dx, GRID_W - dx); dy = Math.min(dy, GRID_H - dy);
  return Math.hypot(dx, dy);
}
function applyWeaponArea(ownerId, x, y, radius) { paintCircle(x, y, radius, ownerId); eliminateIfEmpty(); }

function fireWeapon(p) {
  if (!p.alive || !gameStarted) return;
  const weapon = WEAPONS[p.weapon];
  if (!weapon) return;
  if (weapon.mystery) return mysteryWeapon(p);
  for (let i = 0; i < weapon.count; i++) {
    const spread = weapon.count > 1 ? (i - (weapon.count - 1) / 2) * weapon.spread : 0;
    const angle = p.angle * Math.PI / 180 + spread;
    const id = crypto.randomBytes(8).toString('hex');
    projectiles.set(id, {
      id, owner: p.id, type: p.weapon, x: p.x, y: p.y, angle,
      speed: weapon.speed, radius: weapon.radius, homing: !!weapon.homing,
      explode: !!weapon.explode, exploded: false,
      emoji: p.weapon === 'potato' ? '🥔' : p.weapon === 'chicken' ? '🐔' :
        p.weapon === 'chair' ? '🪑' : p.weapon === 'sock' ? '🧦' :
        p.weapon === 'tinyBoom' ? '🧨' : '🦆'
    });
  }
}
function seekHomingTarget(pr) {
  let best = null, bestDistance = Infinity;
  for (const p of players.values()) {
    if (!p.alive || p.id === pr.owner) continue;
    const d = distanceWrapped(pr.x, pr.y, p.x, p.y);
    if (d < bestDistance) { bestDistance = d; best = p; }
  }
  if (!best || bestDistance > 15) return;
  const target = Math.atan2(best.y - pr.y, best.x - pr.x);
  const diff = Math.atan2(Math.sin(target - pr.angle), Math.cos(target - pr.angle));
  pr.angle += Math.sign(diff) * Math.min(Math.abs(diff), 0.05);
}
function projectileHitsPlayers(pr) {
  for (const target of players.values()) {
    if (!target.alive || target.id === pr.owner) continue;
    if (distanceWrapped(pr.x, pr.y, target.x, target.y) <= 1.4 + pr.radius) {
      applyWeaponArea(pr.owner, pr.x, pr.y, pr.radius);
      if (pr.explode && !pr.exploded) {
        pr.exploded = true;
        applyWeaponArea(pr.owner, pr.x, pr.y, 3);
        broadcast({ type: 'explosion', x: pr.x, y: pr.y });
      }
    }
  }
}
function updateProjectiles(dt) {
  for (const [id, pr] of projectiles) {
    if (pr.homing) seekHomingTarget(pr);
    pr.x += Math.cos(pr.angle) * pr.speed * dt;
    pr.y += Math.sin(pr.angle) * pr.speed * dt;
    if (pr.radius > 0) paintCircle(pr.x, pr.y, pr.radius, pr.owner);
    projectileHitsPlayers(pr);
    if (pr.x <= 0 || pr.x >= GRID_W - 1 || pr.y <= 0 || pr.y >= GRID_H - 1) projectiles.delete(id);
  }
}

function createHuman(ws) {
  if (players.size >= MAX_PLAYERS) return null;
  const id = nextPlayerId();
  if (id === null) return null;
  const [x, y] = spawnPositions[id];
  const token = crypto.randomBytes(16).toString('hex');
  const p = {
    id, token, cpu: false, ws, color: colorFor(id), x, y, homeX: Math.floor(x), homeY: Math.floor(y),
    angle: 0, alive: true, weapon: 'potato', nextMysteryAt: 0, lastTurnAt: 0
  };
  players.set(id, p); paintHome(p);
  if (players.size >= 2) gameStarted = true;
  ws.send(JSON.stringify({ type: 'welcome', token, player: { id: p.id, color: p.color, x: p.x, y: p.y, angle: p.angle, weapon: p.weapon, cpu: false } }));
  broadcastState();
  return p;
}
function createCPU() {
  if (players.size >= MAX_PLAYERS) return null;
  const id = nextPlayerId();
  if (id === null) return null;
  const [x, y] = spawnPositions[id];
  const p = {
    id, token: `cpu-${crypto.randomBytes(10).toString('hex')}`, cpu: true, ws: null,
    color: colorFor(id), x, y, homeX: Math.floor(x), homeY: Math.floor(y),
    angle: Math.floor(Math.random() * 24) * 15, alive: true,
    weapon: WEAPON_KEYS[Math.floor(Math.random() * (WEAPON_KEYS.length - 1))], nextMysteryAt: 0, lastTurnAt: 0
  };
  players.set(id, p); paintHome(p);
  if (players.size >= 2) gameStarted = true;
  return p;
}
function removeCPUs() {
  for (const [id, p] of players) if (p.cpu) players.delete(id);
  broadcastState();
}

function updateCPUs() {
  for (const p of players.values()) {
    if (!p.cpu || !p.alive || !gameStarted) continue;
    if (Math.random() < CPU_TURN_CHANCE_PER_TICK) {
      p.angle = (p.angle + (Math.random() < 0.5 ? -TURN_ANGLE : TURN_ANGLE) + 360) % 360;
    }
    if (Math.random() < CPU_FIRE_CHANCE_PER_TICK) fireWeapon(p);
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' };
const root = __dirname;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/admin/login' && req.method === 'POST') {
    if (!isLoopback(req)) return sendJson(res, 403, { ok: false });
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
    if (body.password !== ADMIN_PASSWORD) return sendJson(res, 401, { ok: false });
    const sid = crypto.randomBytes(24).toString('hex');
    adminSessions.add(sid);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': `adminSession=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/` });
  }

  if (url.pathname === '/api/cpu' && (req.method === 'POST' || req.method === 'DELETE')) {
    if (!isAdmin(req)) return sendJson(res, 403, { ok: false, message: 'admin required' });
    if (req.method === 'DELETE') {
      removeCPUs();
      return sendJson(res, 200, { ok: true, cpu: 0, players: players.size });
    }
    let body = {};
    try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
    const count = Math.max(0, Math.min(MAX_PLAYERS - players.size, Math.floor(Number(body.count || 0))));
    let added = 0;
    for (let i = 0; i < count; i++) if (createCPU()) added++;
    if (added) broadcastState();
    return sendJson(res, 200, { ok: true, added, players: players.size, cpus: [...players.values()].filter(p => p.cpu).length, maxPlayers: MAX_PLAYERS });
  }

  if (url.pathname.startsWith('/api/') && req.method === 'GET') {
    if (!isAdmin(req)) return sendJson(res, 403, { ok: false });
    if (url.pathname === '/api/status') {
      return sendJson(res, 200, { ok: true, players: players.size, humans: [...players.values()].filter(p => !p.cpu).length, cpus: [...players.values()].filter(p => p.cpu).length, maxPlayers: MAX_PLAYERS });
    }
  }

  const requestPath = decodeURIComponent(url.pathname).split('?')[0];
  const relative = requestPath === '/' ? 'static/index.html' : requestPath.replace(/^\/+/, '');
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) return res.writeHead(403).end('Forbidden');
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', ws => {
  const p = createHuman(ws);
  if (!p) { ws.send(JSON.stringify({ type: 'error', message: `満員です（最大${MAX_PLAYERS}人）` })); ws.close(); return; }

  ws.on('message', raw => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch { return; }
    if (!p.alive) return;
    if (data.action === 'turn') {
      const now = Date.now();
      if (now - p.lastTurnAt < TURN_INTERVAL_MS) return;
      const dir = Number(data.direction);
      if (dir !== -1 && dir !== 1) return;
      p.angle = (p.angle + TURN_ANGLE * dir + 360) % 360;
      p.lastTurnAt = now;
    } else if (data.action === 'weapon' && WEAPONS[data.weapon]) {
      p.weapon = data.weapon;
    } else if (data.action === 'fire') {
      fireWeapon(p);
    }
  });

  ws.on('close', () => {
    players.delete(p.id);
    if (players.size < 2) gameStarted = false;
    broadcastState();
  });
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;

  updateCPUs();
  if (gameStarted && winner === null) {
    for (const p of players.values()) {
      if (!p.alive) continue;
      const rad = p.angle * Math.PI / 180;
      p.x = wrap(p.x + Math.cos(rad) * MOVE_SPEED * dt, GRID_W);
      p.y = wrap(p.y + Math.sin(rad) * MOVE_SPEED * dt, GRID_H);
      territory[idx(clampInt(p.x, 0, GRID_W - 1), clampInt(p.y, 0, GRID_H - 1))] = p.id;
    }
    updateProjectiles(dt);
    eliminateIfEmpty();
  }
  if (gameStarted) broadcastState();
}, 1000 / TICK_RATE);

server.listen(PORT, HOST, () => {
  console.log(`Territory Battle listening on http://${HOST}:${PORT}`);
  console.log(`Max players (humans + CPU): ${MAX_PLAYERS}`);
});
