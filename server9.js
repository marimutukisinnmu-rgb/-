const fs = require('fs');
const Module = require('module');
const path = require('path');

const target = path.join(__dirname, 'server4.js');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(from, to) {
  if (!source.includes(from)) throw new Error(`patch target not found: ${from.slice(0, 100)}`);
  source = source.replace(from, to);
}

replaceOnce("const adminSessions = new Set();", "const adminSessions = new Set();\nconst APTX_DEFAULT_SIZE = 2.0;\nconst APTX_SMALL_SIZE = 0.2;\nconst APTX_DURATION_MS = 30_000;");
replaceOnce("const WEAPONS = {", "const WEAPONS = {\n  aptx: { speed: 17, radius: 1.5, count: 1, spread: 0, aptx: true },");
replaceOnce("weaponCooldown: p.weapon === 'mystery' ? Math.max(0, p.nextMysteryAt - now) : 0", "size: p.size ?? APTX_DEFAULT_SIZE,\n    aptxUntil: p.aptxUntil ?? 0,\n    singleShot: !!p.singleShot,\n    weaponCooldown: p.weapon === 'mystery' ? Math.max(0, p.nextMysteryAt - now) : 0");
replaceOnce("p.weapon = 'potato';\n    p.nextMysteryAt = 0;", "p.weapon = 'potato';\n    p.nextMysteryAt = 0;\n    p.size = APTX_DEFAULT_SIZE;\n    p.aptxUntil = 0;\n    p.singleShot = false;\n    p.fireReady = true;");
replaceOnce("weapon: 'potato',\n    nextMysteryAt: 0,\n    lastTurnAt: 0", "weapon: 'potato',\n    nextMysteryAt: 0,\n    lastTurnAt: 0,\n    size: APTX_DEFAULT_SIZE,\n    aptxUntil: 0,\n    singleShot: false,\n    fireReady: true");
replaceOnce("weapon: WEAPON_KEYS[Math.floor(Math.random() * (WEAPON_KEYS.length - 1))],\n    nextMysteryAt: 0,\n    lastTurnAt: 0", "weapon: WEAPON_KEYS[Math.floor(Math.random() * WEAPON_KEYS.length)],\n    nextMysteryAt: 0,\n    lastTurnAt: 0,\n    size: APTX_DEFAULT_SIZE,\n    aptxUntil: 0,\n    singleShot: false,\n    fireReady: true");
replaceOnce("function fireWeapon(p) {\n  if (!p.alive || !gameStarted) return;", "function fireWeapon(p) {\n  if (!p.alive || !gameStarted) return;\n  const now = Date.now();\n  if (!p.cpu && p.aptxUntil > now) {\n    if (p.singleShot && !p.fireReady) return;\n    p.fireReady = false;\n  }\n  if (!p.cpu && p.aptxUntil > 0 && p.aptxUntil <= now) {\n    p.size = APTX_DEFAULT_SIZE;\n    p.aptxUntil = 0;\n    p.singleShot = false;\n    p.fireReady = true;\n  }");
replaceOnce("exploded: false,\n      emoji:", "aptx: !!weapon.aptx,\n      hitAPTX: new Set(),\n      exploded: false,\n      emoji:");
replaceOnce("if (distanceWrapped(pr.x, pr.y, target.x, target.y) <= 1.4 + pr.radius) {\n      applyWeaponArea(pr.owner, pr.x, pr.y, pr.radius);", "if (distanceWrapped(pr.x, pr.y, target.x, target.y) <= 1.4 + pr.radius) {\n      if (pr.aptx) {\n        if (pr.hitAPTX.has(target.id)) continue;\n        pr.hitAPTX.add(target.id);\n        if (Math.random() < 0.64) {\n          target.size = APTX_SMALL_SIZE;\n          target.aptxUntil = Date.now() + APTX_DURATION_MS;\n          target.singleShot = true;\n          target.fireReady = true;\n          broadcast({ type: 'apTX', playerId: target.id, outcome: 'survive', size: target.size, duration: APTX_DURATION_MS });\n        } else {\n          for (let i = 0; i < territory.length; i++) {\n            if (territory[i] === target.id) territory[i] = -1;\n          }\n          target.alive = false;\n          broadcast({ type: 'apTX', playerId: target.id, outcome: 'death' });\n          eliminateIfEmpty();\n        }\n        broadcastState();\n        continue;\n      }\n      applyWeaponArea(pr.owner, pr.x, pr.y, pr.radius);");
replaceOnce("if (pr.radius > 0) paintCircle(pr.x, pr.y, pr.radius, pr.owner);", "if (pr.radius > 0 && !pr.aptx) paintCircle(pr.x, pr.y, pr.radius, pr.owner);");
replaceOnce("} else if (data.action === 'fire') {\n      fireWeapon(p);\n    }", "} else if (data.action === 'fire') {\n      fireWeapon(p);\n    } else if (data.action === 'releaseFire') {\n      p.fireReady = true;\n    }");

const observerSockets = new Set();
replaceOnce("function broadcast(payload) {\n  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);\n  for (const p of players.values()) if (p.ws?.readyState === 1) p.ws.send(msg);\n}", "function broadcast(payload) {\n  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);\n  for (const p of players.values()) if (p.ws?.readyState === 1) p.ws.send(msg);\n  for (const ws of observerSockets) if (ws.readyState === 1) ws.send(msg);\n}");
replaceOnce("wss.on('connection', ws => {\n  const p = createHuman(ws);", "wss.on('connection', (ws, req) => {\n  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);\n  if (requestUrl.searchParams.get('observer') === '1') {\n    if (!isAdmin(req)) { ws.close(); return; }\n    observerSockets.add(ws);\n    ws.send(stateMessage());\n    ws.on('close', () => observerSockets.delete(ws));\n    return;\n  }\n  const p = createHuman(ws);");

const loaded = new Module(target, module);
loaded.filename = target;
loaded.paths = Module._nodeModulePaths(path.dirname(target));
loaded._compile(source, target);
