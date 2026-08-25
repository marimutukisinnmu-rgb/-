const fs = require('fs');
const Module = require('module');
const path = require('path');

const target = path.join(__dirname, 'server4.js');
let source = fs.readFileSync(target, 'utf8');

source = source.replace(
  'const adminSessions = new Set();',
  'const adminSessions = new Set();\nconst observerSockets = new Set();'
);

source = source.replace(
  "for (const p of players.values()) if (p.ws?.readyState === 1) p.ws.send(msg);",
  "for (const p of players.values()) if (p.ws?.readyState === 1) p.ws.send(msg);\n  for (const observer of observerSockets) if (observer.readyState === 1) observer.send(msg);"
);

source = source.replace(
  "wss.on('connection', ws => {\n  const p = createHuman(ws);",
  "wss.on('connection', (ws, req) => {\n  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);\n  if (requestUrl.searchParams.get('observer') === '1') {\n    if (!isAdmin(req)) {\n      ws.close();\n      return;\n    }\n    observerSockets.add(ws);\n    ws.send(stateMessage());\n    ws.on('close', () => observerSockets.delete(ws));\n    return;\n  }\n\n  const p = createHuman(ws);"
);

if (!source.includes('observerSockets.add(ws)')) {
  throw new Error('server4.js patch points not found');
}

const loaded = new Module(target, module);
loaded.filename = target;
loaded.paths = Module._nodeModulePaths(path.dirname(target));
loaded._compile(source, target);
