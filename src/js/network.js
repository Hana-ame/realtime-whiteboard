/**
 * Networking and presence
 * @module network
 */
import { state, peers, peerId, peerName, peerColor, persist } from './state.js';
import { uid, toast } from './utils.js';
import { requestRender } from './renderer.js';

let peer = null;
let myId = null;
const conns = {};
const seen = new Set();
let lastCursor = 0;
const _bcache = {};

export function initNetwork() {
  if (typeof Peer === 'undefined') {
    toast('PeerJS 未加载：需联网加载 CDN');
    return;
  }
  try { peer = new Peer(); } catch (e) { toast('无法创建 Peer'); return; }
  
  peer.on('open', id => {
    myId = id;
    document.getElementById('my-id').textContent = id;
    updateNetUI();
    broadcast({ t: 'presence', name: peerName, color: peerColor });
    toast('已上线，复制ID发给对方即可互联');
  });
  
  peer.on('connection', conn => setupConn(conn));
  peer.on('error', err => toast('Peer 错误: ' + err.type));
  peer.on('disconnected', () => { if (peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} } });
  
  setInterval(() => {
    if (peer && peer.open) broadcast({ t: 'presence', name: peerName, color: peerColor });
  }, 4000);
  
  window.addEventListener('beforeunload', () => {
    broadcast({ t: 'leave' });
    if (peer) try { peer.destroy(); } catch (e) {}
  });

  setInterval(() => {
    const now = performance.now();
    let changed = false;
    for (const id in peers) {
      if (now - peers[id].last > 12000) {
        delete peers[id];
        changed = true;
      }
    }
    if (changed) {
      updatePresence();
      requestRender();
    }
  }, 5000);

  document.getElementById('copy-id').addEventListener('click', () => {
    if (myId && navigator.clipboard) {
      navigator.clipboard.writeText(myId).then(() => toast('已复制我的ID')).catch(() => toast(myId));
    } else toast(myId || '');
  });
  document.getElementById('connect-btn').addEventListener('click', () => {
    const v = document.getElementById('remote-id').value.trim();
    if (!v) return;
    if (v === myId) { toast('不能连接自己'); return; }
    if (!peer || !myId) { toast('Peer 未就绪'); return; }
    if (conns[v]) { toast('已连接'); return; }
    const c = peer.connect(v, { reliable: true });
    setupConn(c);
    toast('正在连接…');
  });
  document.getElementById('remote-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('connect-btn').click();
  });
}

function setupConn(conn) {
  conns[conn.peer] = conn;
  conn.on('open', () => {
    updateNetUI();
    broadcast({ t: 'request' });
    broadcast({ t: 'presence', name: peerName, color: peerColor });
  });
  conn.on('data', m => {
    if (!m) return;
    if (m.mid) {
      if (seen.has(m.mid)) return;
      seen.add(m.mid);
      if (seen.size > 3000) seen.clear();
    }
    handleMsg(m);
    relay(m, conn.peer);
  });
  conn.on('close', () => {
    delete conns[conn.peer];
    delete peers[conn.peer];
    updateNetUI();
    updatePresence();
    requestRender();
  });
  conn.on('error', () => {});
}

export function broadcast(msg) {
  msg.from = peerId;
  sendLocal(msg);
}

function sendLocal(msg) {
  if (!msg.mid) msg.mid = uid();
  seen.add(msg.mid);
  if (seen.size > 3000) seen.clear();
  for (const id in conns) {
    if (conns[id].open) {
      try { conns[id].send(msg); } catch (e) {}
    }
  }
}

function relay(msg, exceptId) {
  for (const id in conns) {
    if (id !== exceptId && conns[id].open) {
      try { conns[id].send(msg); } catch (e) {}
    }
  }
}

function handleMsg(m) {
  if (m.t === 'upsert') {
    const el = m.el;
    const cur = state.elements[el.id];
    if (!cur || (el.rev || 0) >= (cur.rev || 0)) {
      state.elements[el.id] = el;
      requestRender();
    }
  } else if (m.t === 'delete') {
    if (state.elements[m.id]) {
      delete state.elements[m.id];
      if (state.selectedId === m.id) state.selectedId = null;
      requestRender();
    }
  } else if (m.t === 'state') {
    for (const id in m.elements) {
      const el = m.elements[id];
      const cur = state.elements[id];
      if (!cur || (el.rev || 0) >= (cur.rev || 0)) state.elements[id] = el;
    }
    persist();
    requestRender();
  } else if (m.t === 'request') {
    broadcast({ t: 'state', elements: state.elements });
  } else if (m.t === 'cursor') {
    peers[m.from] = { name: m.name, color: m.color, cursor: { x: m.x, y: m.y }, last: performance.now() };
    updatePresence();
    requestRender();
  } else if (m.t === 'presence') {
    if (!peers[m.from]) peers[m.from] = { name: m.name, color: m.color, last: performance.now() };
    else { peers[m.from].name = m.name; peers[m.from].color = m.color; peers[m.from].last = performance.now(); }
    updatePresence();
  } else if (m.t === 'leave') {
    delete peers[m.from];
    updatePresence();
    requestRender();
  }
}

export function broadcastCursor(wp) {
  const now = performance.now();
  if (now - lastCursor < 45) return;
  lastCursor = now;
  broadcast({ t: 'cursor', name: peerName, color: peerColor, x: wp.x, y: wp.y });
}

export function broadcastThrottled(el) {
  const now = performance.now();
  const c = _bcache[el.id];
  if (c && now - c.t < 60) {
    c.el = el;
    clearTimeout(c.to);
    c.to = setTimeout(() => { broadcast({ t: 'upsert', el: c.el }); }, 60);
    return;
  }
  _bcache[el.id] = { t: now, el: el, to: null };
  broadcast({ t: 'upsert', el: el });
}

function updateNetUI() {
  const n = Object.keys(conns).length;
  const el = document.getElementById('net-count');
  if (el) el.textContent = n ? ('已连接 ' + n) : '未连接';
}

export function updatePresence() {
  const box = document.getElementById('avatars');
  const ids = Object.keys(peers).filter(id => id !== peerId);
  const all = [{ id: peerId, name: peerName, color: peerColor, self: true }, ...ids.map(id => ({ id, ...peers[id] }))];
  box.innerHTML = '';
  all.slice(0, 6).forEach(p => {
    const d = document.createElement('div');
    d.className = 'av';
    d.style.background = p.color;
    d.title = p.name + (p.self ? '（你）' : '');
    d.textContent = p.name.slice(-2);
    box.appendChild(d);
  });
  document.getElementById('online-count').textContent = all.length + ' 人在线';
}
