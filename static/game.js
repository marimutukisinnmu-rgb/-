const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const statusEl = document.getElementById("status");
const infoEl = document.getElementById("info");
const rainButton = document.getElementById("rain");

let state = null;
let me = null;
let socket = null;
const keys = new Set();
let rainFlash = 0;

function resize() {
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  canvas.width = Math.floor(window.innerWidth * dpr);
  canvas.height = Math.floor((window.innerHeight - 86) * dpr);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight - 86}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

function connect() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${protocol}://${location.host}/ws`);

  socket.addEventListener("open", () => {
    statusEl.textContent = "接続済み";
  });

  socket.addEventListener("close", () => {
    statusEl.textContent = "切断されました。再接続中...";
    setTimeout(connect, 1000);
  });

  socket.addEventListener("error", () => {
    statusEl.textContent = "接続エラー";
  });

  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "welcome") {
      me = data.token;
      statusEl.textContent = `Player ${data.player.id + 1}`;
    } else if (data.type === "state") {
      state = data;
      if (state.winner !== null) {
        statusEl.textContent = `Player ${state.winner + 1} WIN!`;
      }
    } else if (data.type === "rain") {
      rainFlash = 1;
    } else if (data.type === "error") {
      statusEl.textContent = data.message;
    }
  });
}
connect();

function sendTurn(direction) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ action: "turn", direction }));
}

window.addEventListener("keydown", (event) => {
  if (["ArrowLeft", "ArrowRight", "a", "d", "A", "D"].includes(event.key)) {
    event.preventDefault();
    keys.add(event.key.toLowerCase());
  }
});
window.addEventListener("keyup", (event) => {
  keys.delete(event.key.toLowerCase());
});

// Rotation is intentionally much faster than rendering: 15° every 0.01s while held.
setInterval(() => {
  const left = keys.has("a") || keys.has("arrowleft");
  const right = keys.has("d") || keys.has("arrowright");
  if (left && !right) sendTurn(-1);
  if (right && !left) sendTurn(1);
}, 10);

rainButton.addEventListener("click", () => {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ action: "rain" }));
  }
});

function draw() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "#11151c";
  ctx.fillRect(0, 0, w, h);

  if (!state) {
    ctx.fillStyle = "white";
    ctx.font = "24px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("サーバーに接続しています...", w / 2, h / 2);
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

  for (const p of state.players) {
    if (!p.alive) continue;
    const px = ox + p.x * scale;
    const py = oy + p.y * scale;
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
    .map(p => `P${p.id + 1}: ${p.territory}`)
    .join("   ");

  if (state.winner !== null) {
    ctx.fillStyle = "rgba(0,0,0,0.65)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "white";
    ctx.font = "bold 46px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`PLAYER ${state.winner + 1} WIN!`, w / 2, h / 2);
  }

  if (rainFlash > 0) {
    ctx.fillStyle = `rgba(110,200,255,${0.25 * rainFlash})`;
    ctx.fillRect(0, 0, w, h);
    rainFlash = Math.max(0, rainFlash - 0.025);
  }

  requestAnimationFrame(draw);
}

function playerColor(id) {
  const p = state?.players?.find(x => x.id === id);
  return p?.color || "#777";
}

draw();
