const fs = require('fs');
const Module = require('module');
const path = require('path');

const target = path.join(__dirname, 'server5.js');
let source = fs.readFileSync(target, 'utf8');

const replacements = [
  [
    "const source = path.join(__dirname, 'server4.js');",
    "const source = path.join(__dirname, 'server4.js');"
  ],
  [
    'const adminSessions = new Set();',
    'const adminSessions = new Set();\nconst APTX_DEFAULT_SIZE = 2.0;\nconst APTX_SMALL_SIZE = 0.2;\n'
  ],
  [
    'const WEAPONS = {',
    "const WEAPONS = {\n  aptx: { speed: 17, radius: 1.5, count: 1, spread: 0, aptx: true, emoji: '🧪' },"
  ],
  [
    "weapon: p.weapon,\n    weaponCooldown:",
    "weapon: p.weapon,\n    size: p.size ?? APTX_DEFAULT_SIZE,\n    singleShot: !!p.singleShot,\n    weaponDisabled: !!p.weaponDisabled,\n    weaponCooldown:"
  ],
  [
    "p.weapon = 'potato';\n    p.nextMysteryAt = 0;",
    "p.weapon = 'potato';\n    p.nextMysteryAt = 0;\n    p.size = APTX_DEFAULT_SIZE;\n    p.singleShot = false;\n    p.weaponDisabled = false;\n    p.fireReady = true;"
  ],
  [
    "weapon: 'potato', nextMysteryAt: 0, lastTurnAt: 0",
    "weapon: 'potato', nextMysteryAt: 0, lastTurnAt: 0, size: APTX_DEFAULT_SIZE, singleShot: false, weaponDisabled: false, fireReady: true"
  ],
  [
    "weapon: WEAPON_KEYS[Math.floor(Math.random() * (WEAPON_KEYS.length - 1))], nextMysteryAt: 0, lastTurnAt: 0",
    "weapon: WEAPON_KEYS[Math.floor(Math.random() * WEAPON_KEYS.length)], nextMysteryAt: 0, lastTurnAt: 0, size: APTX_DEFAULT_SIZE, singleShot: false, weaponDisabled: false, fireReady: true"
  ],
  [
    "function fireWeapon(p) {\n  if (!p.alive || !gameStarted) return;",
    "function fireWeapon(p) {\n  if (!p.alive || !gameStarted) return;\n  if (!p.cpu && p.weaponDisabled) return;\n  if (!p.cpu && p.singleShot && !p.fireReady) return;"
  ],
  [
    "if (weapon.mystery) return mysteryWeapon(p);",
    "if (weapon.mystery) return mysteryWeapon(p);\n  if (!p.cpu && p.singleShot) p.fireReady = false;"
  ],
  [
    "explode: !!weapon.explode,\n      exploded: false,",
    "explode: !!weapon.explode,\n      aptx: !!weapon.aptx,\n      hitAPTX: new Set(),\n      exploded: false,"
  ],
  [
    "function projectileHitsPlayers(pr) {\n  for (const target of players.values()) {",
    "function projectileHitsPlayers(pr) {\n  for (const target of players.values()) {"
  ],
  [
    "if (distanceWrapped(pr.x, pr.y, target.x, target.y) <= 1.4 + pr.radius) {\n      applyWeaponArea(pr.owner, pr.x, pr.y, pr.radius);",
    "if (distanceWrapped(pr.x, pr.y, target.x, target.y) <= 1.4 + pr.radius) {\n      if (pr.aptx) {\n        if (pr.hitAPTX.has(target.id)) continue;\n        pr.hitAPTX.add(target.id);\n        target.size = APTX_SMALL_SIZE;\n        target.singleShot = true;\n        target.fireReady = true;\n        target.weaponDisabled = Math.random() < 0.25;\n        broadcast({ type: 'apTX', playerId: target.id, size: target.size, singleShot: true, weaponDisabled: target.weaponDisabled });\n        broadcastState();\n        continue;\n      }\n      applyWeaponArea(pr.owner, pr.x, pr.y, pr.radius);"
  ],
  [
    "if (pr.radius > 0) paintCircle(pr.x, pr.y, pr.radius, pr.owner);",
    "if (pr.radius > 0 && !pr.aptx) paintCircle(pr.x, pr.y, pr.radius, pr.owner);"
  ],
  [
    "} else if (data.action === 'fire') {\n      fireWeapon(p);\n    }",
    "} else if (data.action === 'fire') {\n      fireWeapon(p);\n    } else if (data.action === 'releaseFire') {\n      p.fireReady = true;\n    }"
  ]
];

for (const [from, to] of replacements) {
  if (!source.includes(from)) {
    throw new Error(`server patch point not found: ${from.slice(0, 100)}`);
  }
  source = source.replace(from, to);
}

const loaded = new Module(target, module);
loaded.filename = target;
loaded.paths = Module._nodeModulePaths(path.dirname(target));
loaded._compile(source, target);
