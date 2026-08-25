const fs = require('fs');
const Module = require('module');
const path = require('path');

const target = path.join(__dirname, 'server5.js');
let source = fs.readFileSync(target, 'utf8');

const marker = 'const loaded = new Module(target, module);';
const markerIndex = source.indexOf(marker);
if (markerIndex < 0) throw new Error('server5 wrapper compile marker not found');

const patchCode = `
source = source.replace(/const adminSessions = new Set\\(\\);/, 'const adminSessions = new Set();\\nconst APTX_DEFAULT_SIZE = 2.0;\\nconst APTX_SMALL_SIZE = 0.2;');
source = source.replace(/const WEAPONS = \\\\{/, "const WEAPONS = {\\n  aptx: { speed: 17, radius: 1.5, count: 1, spread: 0, aptx: true, emoji: '🧪' },");
source = source.replace(/weapon: p\\.weapon,\\n\\s*weaponCooldown:/, 'weapon: p.weapon,\\n    size: p.size ?? APTX_DEFAULT_SIZE,\\n    singleShot: !!p.singleShot,\\n    weaponDisabled: !!p.weaponDisabled,\\n    weaponCooldown:');
source = source.replace(/p\\.weapon = 'potato';\\n\\s*p\\.nextMysteryAt = 0;/, "p.weapon = 'potato';\\n    p.nextMysteryAt = 0;\\n    p.size = APTX_DEFAULT_SIZE;\\n    p.singleShot = false;\\n    p.weaponDisabled = false;\\n    p.fireReady = true;");
source = source.replace(/weapon: 'potato', nextMysteryAt: 0, lastTurnAt: 0/, "weapon: 'potato', nextMysteryAt: 0, lastTurnAt: 0, size: APTX_DEFAULT_SIZE, singleShot: false, weaponDisabled: false, fireReady: true");
source = source.replace(/weapon: WEAPON_KEYS\\[Math\\.floor\\(Math\\.random\\(\\) \\* \\(WEAPON_KEYS\\.length - 1\\)\\)\\], nextMysteryAt: 0, lastTurnAt: 0/, "weapon: WEAPON_KEYS[Math.floor(Math.random() * WEAPON_KEYS.length)], nextMysteryAt: 0, lastTurnAt: 0, size: APTX_DEFAULT_SIZE, singleShot: false, weaponDisabled: false, fireReady: true");
source = source.replace(/function fireWeapon\\(p\\) \\{\\n\\s*if \\(!p\\.alive \\|\\| !gameStarted\\) return;/, "function fireWeapon(p) {\\n  if (!p.alive || !gameStarted) return;\\n  if (!p.cpu && p.weaponDisabled) return;\\n  if (!p.cpu && p.singleShot && !p.fireReady) return;");
source = source.replace(/if \\(weapon\\.mystery\\) return mysteryWeapon\\(p\\);/, "if (weapon.mystery) return mysteryWeapon(p);\\n  if (!p.cpu && p.singleShot) p.fireReady = false;");
source = source.replace(/explode: !!weapon\\.explode,\\n\\s*exploded: false,/, "explode: !!weapon.explode,\\n      aptx: !!weapon.aptx,\\n      hitAPTX: new Set(),\\n      exploded: false,");
source = source.replace(/if \\(distanceWrapped\\(pr\\.x, pr\\.y, target\\.x, target\\.y\\) <= 1\\.4 \\+ pr\\.radius\\) \\{\\n\\s*applyWeaponArea\\(pr\\.owner, pr\\.x, pr\\.y, pr\\.radius\\);/, "if (distanceWrapped(pr.x, pr.y, target.x, target.y) <= 1.4 + pr.radius) {\\n      if (pr.aptx) {\\n        if (pr.hitAPTX.has(target.id)) continue;\\n        pr.hitAPTX.add(target.id);\\n        target.size = APTX_SMALL_SIZE;\\n        target.singleShot = true;\\n        target.fireReady = true;\\n        target.weaponDisabled = Math.random() < 0.25;\\n        broadcast({ type: 'apTX', playerId: target.id, size: target.size, singleShot: true, weaponDisabled: target.weaponDisabled });\\n        broadcastState();\\n        continue;\\n      }\\n      applyWeaponArea(pr.owner, pr.x, pr.y, pr.radius);");
source = source.replace(/if \\(pr\\.radius > 0\\) paintCircle\\(pr\\.x, pr\\.y, pr\\.radius, pr\\.owner\\);/, "if (pr.radius > 0 && !pr.aptx) paintCircle(pr.x, pr.y, pr.radius, pr.owner);");
source = source.replace(/else if \\(data\\.action === 'fire'\\) \\{\\n\\s*fireWeapon\\(p\\);\\n\\s*\\}/, "else if (data.action === 'fire') {\\n      fireWeapon(p);\\n    } else if (data.action === 'releaseFire') {\\n      p.fireReady = true;\\n    }");

const requiredChecks = [
  'APTX_DEFAULT_SIZE', 'aptx: true', 'p.singleShot && !p.fireReady',
  'target.weaponDisabled = Math.random() < 0.25', 'releaseFire'
];
for (const check of requiredChecks) {
  if (!source.includes(check)) throw new Error('APTX patch failed: ' + check);
}
`;

source = source.slice(0, markerIndex) + patchCode + '\n' + source.slice(markerIndex);

const loaded = new Module(target, module);
loaded.filename = target;
loaded.paths = Module._nodeModulePaths(path.dirname(target));
loaded._compile(source, target);
