const fs = require('fs');
const Module = require('module');
const path = require('path');

const target = path.join(__dirname, 'server-final.js');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(from, to) {
  if (!source.includes(from)) throw new Error(`server-final patch target not found: ${from.slice(0, 120)}`);
  source = source.replace(from, to);
}

replaceOnce(
  "const APTX_SIZE = 0.4;",
  "const APTX_SIZE = 0.4;\nconst APTX_DURATION_MS = 30_000;"
);

replaceOnce(
  "p.weaponDisabled=false;p.fireReady=true;paintHome(p);",
  "p.weaponDisabled=false;p.fireReady=true;p.aptxUntil=0;paintHome(p);"
);

replaceOnce(
  "function fire(p){if(!p.alive||!gameStarted)return;if(!p.cpu&&p.weaponDisabled)return;if(!p.cpu&&p.singleShot&&!p.fireReady)return;",
  "function fire(p){if(!p.alive||!gameStarted)return;const now=Date.now();if(p.aptxUntil&&p.aptxUntil<=now){p.aptxUntil=0;p.size=DEFAULT_SIZE;p.singleShot=false;p.fireReady=true;}if(!p.cpu&&p.weaponDisabled)return;if(!p.cpu&&p.singleShot&&!p.fireReady)return;"
);

replaceOnce(
  "if(pr.aptx){if(pr.hitAPTX.has(target.id))continue;pr.hitAPTX.add(target.id);target.size=APTX_SIZE;target.singleShot=true;target.fireReady=true;target.weaponDisabled=Math.random()<0.25;broadcast({type:'aptx',playerId:target.id,size:target.size,singleShot:true,weaponDisabled:target.weaponDisabled});broadcastState();continue;}",
  "if(pr.aptx){if(pr.hitAPTX.has(target.id))continue;pr.hitAPTX.add(target.id);if(Math.random()<0.64){target.size=APTX_SIZE;target.aptxUntil=Date.now()+APTX_DURATION_MS;target.singleShot=true;target.fireReady=true;target.weaponDisabled=false;broadcast({type:'aptx',playerId:target.id,outcome:'survive',size:target.size,duration:APTX_DURATION_MS});}else{for(let i=0;i<territory.length;i++)if(territory[i]===target.id)territory[i]=-1;target.alive=false;target.aptxUntil=0;target.singleShot=false;target.weaponDisabled=false;target.fireReady=true;broadcast({type:'aptx',playerId:target.id,outcome:'death'});eliminateIfEmpty();}broadcastState();continue;}"
);

replaceOnce(
  "let last=Date.now();setInterval(()=>{const now=Date.now(),dt=Math.min((now-last)/1000,0.1);last=now;updateCPU();",
  "let last=Date.now();setInterval(()=>{const now=Date.now(),dt=Math.min((now-last)/1000,0.1);last=now;for(const p of players.values()){if(p.aptxUntil&&p.aptxUntil<=now){p.aptxUntil=0;p.size=DEFAULT_SIZE;p.singleShot=false;p.fireReady=true;broadcast({type:'aptxExpired',playerId:p.id});}}updateCPU();"
);

const loaded = new Module(target, module);
loaded.filename = target;
loaded.paths = Module._nodeModulePaths(path.dirname(target));
loaded._compile(source, target);
