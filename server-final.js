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
const DEFAULT_SIZE = 2;
const APTX_SIZE = 0.4;

const COLORS = ['#ff4d4d','#4d8dff','#4dff88','#ffd24d','#b84dff','#ff7ad9','#4de3ff','#ff914d','#8dff4d','#7777ff'];
const WEAPONS = {
  potato:{name:'🥔 じゃがいも投げ',speed:18,radius:1,count:1,spread:0},
  chicken:{name:'🐔 ニワトリ突撃',speed:13,radius:2,count:1,spread:0,homing:true},
  chair:{name:'🪑 椅子投げ',speed:15,radius:2,count:1,spread:0},
  sock:{name:'🧦 靴下砲',speed:28,radius:1,count:1,spread:0},
  tinyBoom:{name:'🧨 ものすごく小さい爆発',speed:12,radius:2,count:1,spread:0,explode:true},
  ducks:{name:'🦆 アヒル軍団',speed:16,radius:1,count:7,spread:0.18},
  mystery:{name:'☢️ 謎のボタン',speed:0,radius:0,count:1,spread:0,mystery:true},
  aptx:{name:'🧪 APTX4869',speed:17,radius:1.5,count:1,spread:0,aptx:true}
};
const WEAPON_KEYS = Object.keys(WEAPONS);
const COLOR_COUNT = COLORS.length;

const players = new Map();
const projectiles = new Map();
const adminSessions = new Set();
const observerSockets = new Set();
const territory = new Int16Array(GRID_W * GRID_H);
territory.fill(-1);
let gameStarted = false;
let winner = null;
let gameResetTimer = null;

function idx(x,y){return y*GRID_W+x;}
function clampInt(v,min,max){return Math.max(min,Math.min(max,Math.floor(v)));}
function wrap(v,size){return ((v%size)+size)%size;}
function colorFor(id){return COLORS[id%COLOR_COUNT];}
function countTerritory(id){let n=0;for(const o of territory)if(o===id)n++;return n;}
function alivePlayers(){return [...players.values()].filter(p=>p.alive&&countTerritory(p.id)>0);}
function distanceWrapped(x1,y1,x2,y2){let dx=Math.abs(x1-x2),dy=Math.abs(y1-y2);dx=Math.min(dx,GRID_W-dx);dy=Math.min(dy,GRID_H-dy);return Math.hypot(dx,dy);}
function loadPassword(){const text=fs.readFileSync(path.join(__dirname,'password.env'),'utf8');const m=text.match(/^\s*ADMIN_PASSWORD\s*=\s*(.*?)\s*$/m);if(!m||!m[1])throw new Error('password.env に ADMIN_PASSWORD がありません');return m[1];}
const ADMIN_PASSWORD=loadPassword();
function cookies(req){const out={};for(const part of (req.headers.cookie||'').split(';')){const [k,...r]=part.trim().split('=');if(k)out[k]=decodeURIComponent(r.join('='));}return out;}
function loopback(req){const ip=req.socket.remoteAddress||'';return ip==='127.0.0.1'||ip==='::1'||ip==='::ffff:127.0.0.1';}
function isAdmin(req){const sid=cookies(req).adminSession;return loopback(req)&&sid&&adminSessions.has(sid);}
function json(res,status,body,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8',...headers});res.end(JSON.stringify(body));}
async function body(req){const chunks=[];for await(const c of req)chunks.push(c);return Buffer.concat(chunks).toString('utf8');}

const spawnPositions=[];for(let i=0;i<MAX_PLAYERS;i++){const gx=(i*17)%GRID_W;const gy=(Math.floor(i/17)*7)%GRID_H;spawnPositions.push([gx+0.5,gy+0.5]);}
function nextId(){for(let i=0;i<MAX_PLAYERS;i++)if(!players.has(i))return i;return null;}
function paintHome(p){const r=2,cx=clampInt(p.homeX,0,GRID_W-1),cy=clampInt(p.homeY,0,GRID_H-1);for(let y=cy-r;y<=cy+r;y++)for(let x=cx-r;x<=cx+r;x++)if(x>=0&&x<GRID_W&&y>=0&&y<GRID_H)territory[idx(x,y)]=p.id;}
function paintCircle(cx,cy,radius,owner){const x0=Math.round(cx),y0=Math.round(cy),r2=radius*radius;for(let y=y0-radius;y<=y0+radius;y++)for(let x=x0-radius;x<=x0+radius;x++){if(x<0||x>=GRID_W||y<0||y>=GRID_H)continue;const dx=x-x0,dy=y-y0;if(dx*dx+dy*dy<=r2)territory[idx(x,y)]=owner;}}
function summary(){const now=Date.now();return [...players.values()].sort((a,b)=>a.id-b.id).map(p=>({id:p.id,color:p.color,x:p.x,y:p.y,angle:p.angle,alive:p.alive,cpu:p.cpu,size:p.size,small:p.size<DEFAULT_SIZE,singleShot:p.singleShot,weaponDisabled:p.weaponDisabled,territory:countTerritory(p.id),weapon:p.weapon,weaponCooldown:p.weapon==='mystery'?Math.max(0,p.nextMysteryAt-now):0}));}
function projectileSummary(){return [...projectiles.values()].map(p=>({id:p.id,owner:p.owner,type:p.type,x:p.x,y:p.y,angle:p.angle,radius:p.radius,emoji:p.emoji}));}
function statePayload(){return {type:'state',grid:{w:GRID_W,h:GRID_H},territory:Array.from(territory),players:summary(),projectiles:projectileSummary(),started:gameStarted,winner,population:players.size,maxPlayers:MAX_PLAYERS};}
function broadcast(payload){const msg=typeof payload==='string'?payload:JSON.stringify(payload);for(const p of players.values())if(p.ws?.readyState===1)p.ws.send(msg);for(const ws of observerSockets)if(ws.readyState===1)ws.send(msg);}
function broadcastState(){broadcast(statePayload());}
function resetRound(){territory.fill(-1);projectiles.clear();for(const p of players.values()){const [x,y]=spawnPositions[p.id];p.alive=true;p.x=x;p.y=y;p.homeX=Math.floor(x);p.homeY=Math.floor(y);p.angle=0;p.weapon='potato';p.nextMysteryAt=0;p.size=DEFAULT_SIZE;p.singleShot=false;p.weaponDisabled=false;p.fireReady=true;paintHome(p);}}
function startRound(){clearTimeout(gameResetTimer);winner=null;gameStarted=players.size>=2;resetRound();broadcastState();}
function eliminateIfEmpty(){for(const p of players.values())if(p.alive&&countTerritory(p.id)===0)p.alive=false;const alive=alivePlayers();if(gameStarted&&alive.length===1){winner=alive[0].id;gameStarted=false;broadcastState();gameResetTimer=setTimeout(()=>{if(players.size>=2)startRound();},4000);}}
function rainfall(){for(const p of players.values()){for(let i=0;i<territory.length;i++)if(territory[i]===p.id)territory[i]=-1;territory[idx(p.homeX,p.homeY)]=p.id;p.x=p.homeX+0.5;p.y=p.homeY+0.5;p.angle=0;p.alive=true;}broadcast({type:'rain'});broadcastState();}
function blackButton(source){const cx=source.x,cy=source.y;for(const p of players.values()){if(!p.alive)continue;p.x=wrap(cx+Math.floor(Math.random()*21)-10,GRID_W);p.y=cy;p.angle=0;}broadcast({type:'blackButton',x:cx,y:cy});broadcastState();}
function adminRandom(){if(Math.random()<0.5){rainfall();broadcast({type:'adminEvent',action:'rain'});return'rain';}const s=alivePlayers()[0];if(s)blackButton(s);else{for(const p of players.values())p.angle=0;broadcast({type:'blackButton'});broadcastState();}broadcast({type:'adminEvent',action:'blackButton'});return'blackButton';}
function mystery(p){const now=Date.now();if(now<p.nextMysteryAt)return;p.nextMysteryAt=now+MYSTERY_COOLDOWN_MS;if(Math.random()<0.5){rainfall();broadcast({type:'weaponEvent',text:'☢️ 謎のボタン：🌧️ 雨！'});}else{blackButton(p);broadcast({type:'weaponEvent',text:'☢️ 謎のボタン：⬛ 全員強制整列！'});} }
function fire(p){if(!p.alive||!gameStarted)return;if(!p.cpu&&p.weaponDisabled)return;if(!p.cpu&&p.singleShot&&!p.fireReady)return;const w=WEAPONS[p.weapon];if(!w)return;if(w.mystery){mystery(p);return;}if(!p.cpu&&p.singleShot)p.fireReady=false;for(let i=0;i<w.count;i++){const spread=w.count>1?(i-(w.count-1)/2)*w.spread:0;const angle=p.angle*Math.PI/180+spread;const id=crypto.randomBytes(8).toString('hex');projectiles.set(id,{id,owner:p.id,type:p.weapon,x:p.x,y:p.y,angle,speed:w.speed,radius:w.radius,homing:!!w.homing,explode:!!w.explode,aptx:!!w.aptx,exploded:false,hitAPTX:new Set(),emoji:p.weapon==='potato'?'🥔':p.weapon==='chicken'?'🐔':p.weapon==='chair'?'🪑':p.weapon==='sock'?'🧦':p.weapon==='tinyBoom'?'🧨':p.weapon==='ducks'?'🦆':'🧪'});}}
function seek(pr){let best=null,bd=Infinity;for(const p of players.values()){if(!p.alive||p.id===pr.owner)continue;const d=distanceWrapped(pr.x,pr.y,p.x,p.y);if(d<bd){bd=d;best=p;}}if(!best||bd>15)return;const ta=Math.atan2(best.y-pr.y,best.x-pr.x);const diff=Math.atan2(Math.sin(ta-pr.angle),Math.cos(ta-pr.angle));pr.angle+=Math.sign(diff)*Math.min(Math.abs(diff),0.05);}
function hitPlayers(pr){for(const target of players.values()){if(!target.alive||target.id===pr.owner)continue;if(distanceWrapped(pr.x,pr.y,target.x,target.y)>1.4+pr.radius)continue;if(pr.aptx){if(pr.hitAPTX.has(target.id))continue;pr.hitAPTX.add(target.id);target.size=APTX_SIZE;target.singleShot=true;target.fireReady=true;target.weaponDisabled=Math.random()<0.25;broadcast({type:'aptx',playerId:target.id,size:target.size,singleShot:true,weaponDisabled:target.weaponDisabled});broadcastState();continue;}paintCircle(pr.x,pr.y,pr.radius,pr.owner);if(pr.explode&&!pr.exploded){pr.exploded=true;paintCircle(pr.x,pr.y,3,pr.owner);broadcast({type:'explosion',x:pr.x,y:pr.y});}eliminateIfEmpty();}}
function updateProjectiles(dt){for(const [id,pr] of projectiles){if(pr.homing)seek(pr);pr.x+=Math.cos(pr.angle)*pr.speed*dt;pr.y+=Math.sin(pr.angle)*pr.speed*dt;if(!pr.aptx&&pr.radius>0)paintCircle(pr.x,pr.y,pr.radius,pr.owner);hitPlayers(pr);if(pr.x<=0||pr.x>=GRID_W-1||pr.y<=0||pr.y>=GRID_H-1)projectiles.delete(id);}}
function createHuman(ws){if(players.size>=MAX_PLAYERS)return null;const id=nextId();if(id===null)return null;const [x,y]=spawnPositions[id];const p={id,token:crypto.randomBytes(16).toString('hex'),cpu:false,ws,color:colorFor(id),x,y,homeX:Math.floor(x),homeY:Math.floor(y),angle:0,alive:true,weapon:'potato',nextMysteryAt:0,lastTurnAt:0,size:DEFAULT_SIZE,singleShot:false,weaponDisabled:false,fireReady:true};players.set(id,p);paintHome(p);if(players.size>=2)gameStarted=true;ws.send(JSON.stringify({type:'welcome',token:p.token,player:{id:p.id,color:p.color,x:p.x,y:p.y,angle:p.angle,weapon:p.weapon,cpu:false,size:p.size}}));broadcastState();return p;}
function createCPU(){if(players.size>=MAX_PLAYERS)return null;const id=nextId();if(id===null)return null;const [x,y]=spawnPositions[id];const p={id,token:`cpu-${crypto.randomBytes(10).toString('hex')}`,cpu:true,ws:null,color:colorFor(id),x,y,homeX:Math.floor(x),homeY:Math.floor(y),angle:Math.floor(Math.random()*24)*15,alive:true,weapon:WEAPON_KEYS[Math.floor(Math.random()*WEAPON_KEYS.length)],nextMysteryAt:0,lastTurnAt:0,size:DEFAULT_SIZE,singleShot:false,weaponDisabled:false,fireReady:true};players.set(id,p);paintHome(p);if(players.size>=2)gameStarted=true;return p;}
function removeCPUs(){for(const [id,p] of players)if(p.cpu)players.delete(id);broadcastState();}
function updateCPU(){for(const p of players.values()){if(!p.cpu||!p.alive||!gameStarted)continue;if(Math.random()<0.08)p.angle=(p.angle+(Math.random()<0.5?-TURN_ANGLE:TURN_ANGLE)+360)%360;if(Math.random()<0.035)fire(p);}}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
const root=__dirname;
const server=http.createServer(async(req,res)=>{const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);
  if(url.pathname==='/admin'&&req.method==='GET'){if(!loopback(req))return json(res,403,{ok:false,message:'admin is localhost only'});fs.readFile(path.join(root,'static','admin.html'),(e,d)=>{if(e){res.writeHead(500);return res.end('Admin page unavailable');}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(d);});return;}
  if(url.pathname==='/admin/login'&&req.method==='POST'){if(!loopback(req))return json(res,403,{ok:false});let b={};try{b=JSON.parse(await body(req)||'{}');}catch{}if(b.password!==ADMIN_PASSWORD)return json(res,401,{ok:false});const sid=crypto.randomBytes(24).toString('hex');adminSessions.add(sid);return json(res,200,{ok:true},{'Set-Cookie':`adminSession=${encodeURIComponent(sid)}; HttpOnly; SameSite=Strict; Path=/`});}
  if(url.pathname==='/admin/action'&&req.method==='POST'){if(!isAdmin(req))return json(res,403,{ok:false,message:'admin required'});let b={};try{b=JSON.parse(await body(req)||'{}');}catch{}const a=String(b.action||'');if(a==='rain'){rainfall();return json(res,200,{ok:true,action:a});}if(a==='blackButton'){const s=alivePlayers()[0];if(s)blackButton(s);else{for(const p of players.values())p.angle=0;broadcastState();}return json(res,200,{ok:true,action:a});}if(a==='random')return json(res,200,{ok:true,action:adminRandom()});return json(res,400,{ok:false,message:'unknown action'});}
  if(url.pathname==='/api/cpu'&&(req.method==='POST'||req.method==='DELETE')){if(!isAdmin(req))return json(res,403,{ok:false,message:'admin required'});if(req.method==='DELETE'){removeCPUs();return json(res,200,{ok:true,players:players.size});}let b={};try{b=JSON.parse(await body(req)||'{}');}catch{}const count=Math.max(0,Math.min(MAX_PLAYERS-players.size,Math.floor(Number(b.count||0))));let added=0;for(let i=0;i<count;i++)if(createCPU())added++;broadcastState();return json(res,200,{ok:true,added,players:players.size,cpus:[...players.values()].filter(p=>p.cpu).length,maxPlayers:MAX_PLAYERS});}
  if(url.pathname==='/api/status'&&req.method==='GET'){if(!isAdmin(req))return json(res,403,{ok:false});return json(res,200,{ok:true,players:players.size,humans:[...players.values()].filter(p=>!p.cpu).length,cpus:[...players.values()].filter(p=>p.cpu).length,maxPlayers:MAX_PLAYERS});}
  const requestPath=decodeURIComponent(url.pathname).split('?')[0];const rel=requestPath==='/'?'static/index.html':requestPath.replace(/^\/+/, '');const full=path.resolve(root,rel);if(!full.startsWith(root+path.sep))return res.writeHead(403).end('Forbidden');fs.readFile(full,(e,d)=>{if(e){res.writeHead(404);return res.end('Not Found');}res.writeHead(200,{'Content-Type':mime[path.extname(full)]||'application/octet-stream'});res.end(d);});
});
const wss=new WebSocketServer({server,path:'/ws'});
wss.on('connection',(ws,req)=>{const q=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`);if(q.searchParams.get('observer')==='1'){if(!isAdmin(req)){ws.close();return;}observerSockets.add(ws);ws.send(JSON.stringify(statePayload()));ws.on('close',()=>observerSockets.delete(ws));return;}const p=createHuman(ws);if(!p){ws.send(JSON.stringify({type:'error',message:`満員です（最大${MAX_PLAYERS}人）`}));ws.close();return;}ws.on('message',raw=>{let d;try{d=JSON.parse(raw.toString());}catch{return;}if(!p.alive)return;if(d.action==='turn'){const now=Date.now();if(now-p.lastTurnAt<TURN_INTERVAL_MS)return;const dir=Number(d.direction);if(dir!==-1&&dir!==1)return;p.angle=(p.angle+TURN_ANGLE*dir+360)%360;p.lastTurnAt=now;}else if(d.action==='weapon'&&WEAPONS[d.weapon])p.weapon=d.weapon;else if(d.action==='fire')fire(p);else if(d.action==='releaseFire')p.fireReady=true;});ws.on('close',()=>{players.delete(p.id);if(players.size<2)gameStarted=false;broadcastState();});});
let last=Date.now();setInterval(()=>{const now=Date.now(),dt=Math.min((now-last)/1000,0.1);last=now;updateCPU();if(gameStarted&&winner===null){for(const p of players.values()){if(!p.alive)continue;const rad=p.angle*Math.PI/180;p.x=wrap(p.x+Math.cos(rad)*MOVE_SPEED*dt,GRID_W);p.y=wrap(p.y+Math.sin(rad)*MOVE_SPEED*dt,GRID_H);territory[idx(clampInt(p.x,0,GRID_W-1),clampInt(p.y,0,GRID_H-1))]=p.id;}updateProjectiles(dt);eliminateIfEmpty();}if(gameStarted)broadcastState();},1000/TICK_RATE);
server.listen(PORT,HOST,()=>console.log(`Territory Battle listening on http://${HOST}:${PORT}`));
