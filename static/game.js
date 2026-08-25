const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const statusEl = document.getElementById('status');
const infoEl = document.getElementById('info');
const rainButton = document.getElementById('rain');
const blackButton = document.getElementById('blackButton');
const fireButton = document.getElementById('fire');
const weaponInfo = document.getElementById('weaponInfo');
const weaponButtons = [...document.querySelectorAll('[data-weapon]')];

const WEAPONS = {
  potato: '🥔 じゃがいも投げ',
  chicken: '🐔 ニワトリ突撃',
  chair: '🪑 椅子投げ',
  sock: '🧦 靴下砲',
  tinyBoom: '🧨 ものすごく小さい爆発',
  ducks: '🦆 アヒル軍団',
  mystery: '☢️ 謎のボタン'
};
const WEAPON_ORDER = ['potato', 'chicken', 'chair', 'sock', 'tinyBoom', 'ducks', 'mystery'];
const WEAPON_EMOJI = {
  potato: '🥔',
  chicken: '🐔',
  chair: '🪑',
  sock: '🧦',
  tinyBoom: '🧨',
  ducks: '🦆'
};

let state = null;
let myToken = null;
let socket = null;
let selectedWeapon = 'potato';
const keys = new Set();
let rainFlash = 0;
let blackFlash = 0;
let explosionFlash = 0;
let eventText = '';
let eventTextTimer = 0;

function resize() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor((window.innerHeight - 132) * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight - 132}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener('open', () => {
    statusEl.textContent = '接続済み';
  });

  socket.addEventListener('close', () => {
    statusEl.textContent = '切断されました。再接続中...';
    setTimeout(connect, 1000);
  });

  socket.addEventListener('error', () => {
    statusEl.textContent = '接続エラー';
  });

  socket.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (data.type === 'welcome') {
      myToken = data.token;
      statusEl.textContent = `Player ${data.player.id + 1}`;
      selectedWeapon = data.player.weapon || 'potato';
      updateWeaponUI();
    } else if (data.type === 'state') {
      state = data;
      if (state.winner !== null) {
        statusEl.textContent = `Player ${state.winner + 1} WIN!`;
      }
    } else if (data.type === 'rain') {
      rainFlash = 1;
    } else if (data.type === 'blackButton') {
      blackFlash = 1;
    } else if (data.type === 'explosion') {
      explosionFlash = 1;
    } else if (data.type === 'weaponEvent') {
      eventText = data.text || '';
      eventTextTimer = 180;
    } else if (data.type === 'error') {
      statusEl.textContent = data.message;
    }
  });
}
connect();

function send(payload) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function chooseWeapon(weapon) {
  if (!WEAPONS[weapon]) return;
  selectedWeapon = weapon;
  send({ action: 'weapon', weapon });
  updateWeaponUI();
}

function fire() {
  send({ action: 'fire' });
}

function updateWeaponUI() {
  weaponButtons.forEach((button) => {
    button.classList.toggle('selected', button.dataset.weapon === selectedWeapon);
  });
  weaponInfo.textContent = `武器: ${WEAPONS[selectedWeapon]}　（1〜7で選択、Spaceで発射）`;
}

weaponButtons.forEach((button) => {
  button.addEventListener('click', () => chooseWeapon(button.dataset.weapon));
});
fireButton.addEventListener('click', fire);

window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  if (['arrowleft', 'arrowright', 'a', 'd'].includes(key)) {
    event.preventDefault();
    keys.add(key);
    return;
  }

  const number = Number(event.key);
  if (number >= 1 && number <= 7) {
    event.preventDefault();
    chooseWeapon(WEAPON_ORDER[number - 1]);
    return;
  }

  if (event.code === 'Space') {
    event.preventDefault();
    if (!event.repeat) fire();
  }
});
window.addEventListener('keyup', (event) => {
  keys.delete(event.key.toLowerCase());
});

// Rotation: 15° every 0.01s while held.
setInterval(() => {
  const left = keys.has('a') || keys.has('arrowleft');
  const right = keys.has('d') || keys.has('arrowright');
  if (left && !right) send({ action: 'turn', direction: -1 });
  if (right && !left) send({ action: 'turn', direction: 1 });
}, 10);

rainButton.addEventListener('click', () => send({ action: 'rain' }));
blackButton.addEventListener('click', () => send({ action: 'blackButton' }));

function directionArrow(angle) {
  const normalized = ((angle % 360) + 360) % 360;
  const index = Math.round(normalized / 45) % 8;
  return ['→', '↘', '↓', '↙', '←', '↖', '↑', '↗'][index];
}

function playerColor(id) {
  const p = state?.players?.find(x => x.id === id);
  return p?.color || '#777';
}

function drawPlayerDirection(p, px, py, scale) {
  const rad = p.angle * Math.PI / 180;
  const length = Math.max(12, scale * 1.8);
  const endX = px + Math.cos(rad) * length;
  const endY = py + Math.sin(rad) * length;

  ctx.save();
  ctx.strokeStyle = 'white';
  ctx.lineWidth = Math.max(2, scale * 0.12);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(endX, endY);
  ctx.stroke();

  ctx.fillStyle = 'white';
  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(endX - Math.cos(rad - 0.55) * scale * 0.65, endY - Math.sin(rad - 0.55) * scale * 0.65);
  ctx.lineTo(endX - Math.cos(rad + 0.55) * scale * 0.65, endY - Math.sin(rad + 0.55) * scale * 0.65);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawProjectile(projectile, ox, oy, scale) {
  const px = ox + projectile.x * scale;
  const py = oy + projectile.y * scale;
  const size = Math.max(12, scale * 0.8);
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(projectile.angle || 0);
  ctx.font = `${size}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(projectile.emoji || '•', 0, 0);
  ctx.restore();
}

function draw() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#11151c';
  ctx.fillRect(0, 0, w, h);

  if (!state) {
    ctx.fillStyle = 'white';
    ctx.font = '24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('サーバーに接続しています...', w / 2, h / 2);
    requestAnimationFrame(draw);
    return;
  }

  const gw = state.grid.w;
  const gh = state.grid.h;
  const scale = Math.min(w / gw, h / gh);
  const ox = (w - gw * scale) / 2;
  const oy = (h - gh * scale) / 2;

  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      const owner = state.territory[y * gw + x];
      if (owner >= 0) {
        ctx.fillStyle = playerColor(owner);
        ctx.fillRect(ox + x * scale, oy + y * scale, scale + 0.5, scale + 0.5);
      }
    }
  }

  for (const projectile of state.projectiles || []) {
    drawProjectile(projectile, ox, oy, scale);
  }

  for (const p of state.players) {
    if (!p.alive) continue;
    const px = ox + p.x * scale;
    const py = oy + p.y * scale;

    drawPlayerDirection(p, px, py, scale);

    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(p.angle * Math.PI / 180);
    ctx.fillStyle = playerColor(p.id);
    ctx.beginPath();
    ctx.moveTo(scale * 0.8, 0);
    ctx.lineTo(-scale * 0.55, -scale * 0.45);
    ctx.lineTo(-scale * 0.55, scale * 0.45);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  const alive = state.players.filter(p => p.alive);
  infoEl.textContent = alive
    .map(p => {
      const cooldown = p.weaponCooldown > 0 ? ` ⏳${Math.ceil(p.weaponCooldown / 100) / 10}s` : ' READY';
      return `P${p.id + 1} ${directionArrow(p.angle)} ${Math.round(p.angle)}°: ${p.territory}${cooldown}`;
    })
    .join('   ');

  if (state.winner !== null) {
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 46px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`PLAYER ${state.winner + 1} WIN!`, w / 2, h / 2);
  }

  if (rainFlash > 0) {
    ctx.fillStyle = `rgba(110,200,255,${0.25 * rainFlash})`;
    ctx.fillRect(0, 0, w, h);
    rainFlash = Math.max(0, rainFlash - 0.025);
  }

  if (blackFlash > 0) {
    ctx.fillStyle = `rgba(0,0,0,${0.45 * blackFlash})`;
    ctx.fillRect(0, 0, w, h);
    blackFlash = Math.max(0, blackFlash - 0.035);
  }

  if (explosionFlash > 0) {
    ctx.fillStyle = `rgba(255,220,120,${0.25 * explosionFlash})`;
    ctx.fillRect(0, 0, w, h);
    explosionFlash = Math.max(0, explosionFlash - 0.08);
  }

  if (eventTextTimer > 0) {
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(w / 2 - 260, 20, 520, 54);
    ctx.fillStyle = 'white';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(eventText, w / 2, 53);
    eventTextTimer--;
  }

  requestAnimationFrame(draw);
}

updateWeaponUI();
draw();
