// Medtronic 5392 Simulator — cross-device relay
// A dumb, secure WebSocket relay. Clients join a "room" by session code;
// any state message is forwarded to the other members of that room.
// No data is stored; nothing but device settings + simulated physiology passes through.
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
const rooms = new Map(); // code -> Set<ws>

function room(code){ if(!rooms.has(code)) rooms.set(code, new Set()); return rooms.get(code); }
function announcePeers(code){
  const r = rooms.get(code); if(!r) return;
  const msg = JSON.stringify({ type:'peers', n:r.size });
  for(const c of r) if(c.readyState === 1) { try{ c.send(msg); }catch(e){} }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf.toString()); } catch (e) { return; }
    if (m.type === 'join') {
      ws.code = String(m.code || '').slice(0, 32);
      if (!ws.code) return;
      room(ws.code).add(ws);
      announcePeers(ws.code);
      return;
    }
    if (m.type === 'ping') { try { ws.send(JSON.stringify({ type:'pong' })); } catch(e){} return; }
    if (m.type === 'state' && ws.code) {
      const r = rooms.get(ws.code); if (!r) return;
      const out = buf.toString();
      for (const c of r) if (c !== ws && c.readyState === 1) { try{ c.send(out); }catch(e){} }
    }
  });
  ws.on('close', () => {
    if (ws.code && rooms.has(ws.code)) {
      const r = rooms.get(ws.code); r.delete(ws);
      if (r.size === 0) rooms.delete(ws.code); else announcePeers(ws.code);
    }
  });
});

// drop dead connections (proxies/idle) every 30s
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch(e){}
  }
}, 30000);

console.log('5392 relay listening on port', PORT);
