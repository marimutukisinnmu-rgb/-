from __future__ import annotations

import asyncio
import json
import math
import secrets
from pathlib import Path

from aiohttp import web, WSMsgType

HOST = "0.0.0.0"
PORT = 8080
GRID_W = 120
GRID_H = 80
MAX_PLAYERS = 10
TICK_RATE = 60
TURN_INTERVAL = 0.01
TURN_ANGLE = 15
MOVE_SPEED = 7.0
SPAWN_BORDER = 3

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"

players: dict[str, dict] = {}
sockets: dict[str, web.WebSocketResponse] = {}
territory: list[int] = [-1] * (GRID_W * GRID_H)
lock = asyncio.Lock()
game_started = False
winner: int | None = None

COLORS = [
    "#ff4d4d", "#4d8dff", "#4dff88", "#ffd24d", "#b84dff",
    "#ff7ad9", "#4de3ff", "#ff914d", "#8dff4d", "#7777ff",
]


def idx(x: int, y: int) -> int:
    return y * GRID_W + x


def clamp_int(value: float, low: int, high: int) -> int:
    return max(low, min(high, int(value)))


def reset_game() -> None:
    global territory, winner, game_started
    territory = [-1] * (GRID_W * GRID_H)
    winner = None
    game_started = False
    players.clear()
    sockets.clear()


def spawn_position(slot: int) -> tuple[float, float]:
    positions = [
        (5, 5), (GRID_W - 6, GRID_H - 6),
        (GRID_W - 6, 5), (5, GRID_H - 6),
        (GRID_W // 2, 5), (GRID_W // 2, GRID_H - 6),
        (5, GRID_H // 2), (GRID_W - 6, GRID_H // 2),
        (GRID_W // 3, GRID_H // 3), (GRID_W * 2 // 3, GRID_H * 2 // 3),
    ]
    return positions[slot]


def paint_home(player_id: int, x: float, y: float) -> None:
    cx = clamp_int(x, 0, GRID_W - 1)
    cy = clamp_int(y, 0, GRID_H - 1)
    for oy in range(-SPAWN_BORDER, SPAWN_BORDER + 1):
        for ox in range(-SPAWN_BORDER, SPAWN_BORDER + 1):
            tx, ty = cx + ox, cy + oy
            if 0 <= tx < GRID_W and 0 <= ty < GRID_H:
                territory[idx(tx, ty)] = player_id


def count_territory(player_id: int) -> int:
    return territory.count(player_id)


def alive_players() -> list[int]:
    ids = []
    for p in players.values():
        if p["alive"] and count_territory(p["id"]) > 0:
            ids.append(p["id"])
    return ids


def player_summary() -> list[dict]:
    result = []
    for p in sorted(players.values(), key=lambda x: x["id"]):
        result.append({
            "id": p["id"],
            "color": p["color"],
            "x": p["x"],
            "y": p["y"],
            "angle": p["angle"],
            "alive": p["alive"],
            "territory": count_territory(p["id"]),
        })
    return result


def snapshot() -> dict:
    return {
        "type": "state",
        "grid": {"w": GRID_W, "h": GRID_H},
        "territory": territory,
        "players": player_summary(),
        "started": game_started,
        "winner": winner,
    }


async def broadcast(payload: dict) -> None:
    message = json.dumps(payload, separators=(",", ":"))
    dead = []
    for pid, ws in list(sockets.items()):
        if ws.closed:
            dead.append(pid)
            continue
        try:
            await ws.send_str(message)
        except Exception:
            dead.append(pid)
    for pid in dead:
        sockets.pop(pid, None)


def assign_player_id() -> int | None:
    used = {p["id"] for p in players.values()}
    for pid in range(MAX_PLAYERS):
        if pid not in used:
            return pid
    return None


def paint_at_player(p: dict) -> None:
    x = clamp_int(p["x"], 0, GRID_W - 1)
    y = clamp_int(p["y"], 0, GRID_H - 1)
    territory[idx(x, y)] = p["id"]


def check_elimination() -> None:
    global winner
    alive = []
    for p in players.values():
        if not p["alive"]:
            continue
        amount = count_territory(p["id"])
        if amount <= 0:
            p["alive"] = False
        else:
            alive.append(p["id"])

    if game_started and len(alive) == 1:
        winner = alive[0]


def rainfall() -> None:
    # Keep each player's home cell, representing the final remaining ink.
    for p in players.values():
        pid = p["id"]
        home_x = p["home_x"]
        home_y = p["home_y"]
        for i, owner in enumerate(territory):
            if owner == pid:
                territory[i] = -1
        territory[idx(home_x, home_y)] = pid
        p["x"] = home_x + 0.5
        p["y"] = home_y + 0.5


async def game_loop() -> None:
    global game_started
    frame_dt = 1.0 / TICK_RATE
    accum = 0.0
    last = asyncio.get_running_loop().time()
    while True:
        now = asyncio.get_running_loop().time()
        dt = min(0.1, now - last)
        last = now
        if game_started and winner is None:
            accum += dt
            while accum >= frame_dt:
                accum -= frame_dt
                async with lock:
                    for p in players.values():
                        if not p["alive"]:
                            continue
                        rad = math.radians(p["angle"])
                        p["x"] += math.cos(rad) * MOVE_SPEED * frame_dt
                        p["y"] += math.sin(rad) * MOVE_SPEED * frame_dt

                        p["x"] %= GRID_W
                        p["y"] %= GRID_H
                        paint_at_player(p)
                    check_elimination()
            await broadcast(snapshot())
        await asyncio.sleep(0.01)


async def index(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(STATIC / "index.html")


async def static_file(request: web.Request) -> web.StreamResponse:
    name = request.match_info["name"]
    target = (STATIC / name).resolve()
    if STATIC.resolve() not in target.parents:
        raise web.HTTPForbidden()
    if not target.is_file():
        raise web.HTTPNotFound()
    return web.FileResponse(target)


async def websocket_handler(request: web.Request) -> web.WebSocketResponse:
    global game_started
    ws = web.WebSocketResponse(heartbeat=20)
    await ws.prepare(request)

    async with lock:
        if len(players) >= MAX_PLAYERS:
            await ws.send_json({"type": "error", "message": "満員です（最大10人）"})
            await ws.close()
            return ws

        pid = assign_player_id()
        assert pid is not None
        x, y = spawn_position(pid)
        players[secrets.token_hex(8)] = {}
        token = next(k for k, v in players.items() if v == {})
        players[token] = {
            "id": pid,
            "color": COLORS[pid],
            "x": x + 0.5,
            "y": y + 0.5,
            "angle": 0.0,
            "left": False,
            "right": False,
            "alive": True,
            "home_x": int(x),
            "home_y": int(y),
        }
        del players[next(k for k, v in list(players.items()) if k != token and v == {})]
        sockets[token] = ws
        paint_home(pid, x, y)
        if len(players) >= 2:
            game_started = True
        await ws.send_json({"type": "welcome", "token": token, "player": player_summary()[-1]})
        await broadcast(snapshot())

    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    data = json.loads(msg.data)
                except json.JSONDecodeError:
                    continue

                async with lock:
                    if token not in players:
                        continue
                    p = players[token]
                    action = data.get("action")
                    if action == "turn":
                        direction = int(data.get("direction", 0))
                        p["angle"] = (p["angle"] + TURN_ANGLE * direction) % 360
                    elif action == "rain":
                        rainfall()
                        await broadcast({"type": "rain"})
                    elif action == "restart":
                        reset_game()
                        await broadcast(snapshot())
            elif msg.type == WSMsgType.ERROR:
                break
    finally:
        async with lock:
            players.pop(token, None)
            sockets.pop(token, None)
            if len(players) < 2:
                game_started = False
            await broadcast(snapshot())

    return ws


async def on_startup(app: web.Application) -> None:
    app["loop_task"] = asyncio.create_task(game_loop())


async def on_cleanup(app: web.Application) -> None:
    app["loop_task"].cancel()
    try:
        await app["loop_task"]
    except asyncio.CancelledError:
        pass


app = web.Application()
app.router.add_get("/", index)
app.router.add_get("/ws", websocket_handler)
app.router.add_get("/static/{name:.*}", static_file)
app.on_startup.append(on_startup)
app.on_cleanup.append(on_cleanup)

if __name__ == "__main__":
    web.run_app(app, host=HOST, port=PORT)
