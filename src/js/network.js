import { Peer } from 'peerjs';
import { state, peers, peerId, peerName, peerColor, persist } from './state.js';
import { uid, toast } from './utils.js';
import { requestRender } from './renderer.js';

let peer = null;
let myId = null;
const conns = {};
const seen = new Set();
let lastCursor = 0;
const _bcache = {};

/**
 * Connect to a remote peer ID
 * @param {string} remoteId
 */
export function connectToPeer(remoteId) {
  if (!remoteId || remoteId === myId) return;
  if (!peer || !myId) {
    toast('网络服务尚未就绪');
    return;
  }
  if (conns[remoteId]) return;
  const c = peer.connect(remoteId, { reliable: true });
  setupConn(c);
}

export function initNetwork() {
  try {
    peer = new Peer();
  } catch (e) {
    toast('无法创建网络连接');
    return;
  }
  
  peer.on('open', id => {
    myId = id;
    const myIdEl = document.getElementById('my-id');
    if (myIdEl) myIdEl.textContent = '房间: ' + id;
    updateNetUI();
    broadcast({ t: 'presence', name: peerName, color: peerColor });
    toast('已上线，可邀请好友同屏协作');

    // 检查 URL 中是否有加入房间的 hash（例如 #room=xxx 或 #xxx）
    const hash = window.location.hash.replace(/^#/, '');
    const match = hash.match(/(?:room=)?([a-zA-Z0-9_-]+)/);
    if (match && match[1] && match[1] !== id) {
      const targetRoomId = match[1];
      const remoteInput = document.getElementById('remote-id');
      if (remoteInput) remoteInput.value = targetRoomId;
      toast('正在加入房间: ' + targetRoomId);
      connectToPeer(targetRoomId);
    }
  });
  
  peer.on('connection', conn => setupConn(conn));
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      toast('目标用户未在线或房间号不存在');
    } else {
      toast('网络提示: ' + err.type);
    }
  });
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

  const copyBtn = document.getElementById('copy-id');
  if (copyBtn) {
    copyBtn.addEventListener('click', () => {
      if (myId && navigator.clipboard) {
        navigator.clipboard.writeText(myId).then(() => toast('已复制我的ID: ' + myId)).catch(() => toast(myId));
      } else toast(myId || '');
    });
  }

  // 复制多人同屏房间链接
  const shareBtn = document.getElementById('share-link-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      if (!myId) { toast('请等待连接建立'); return; }
      const url = new URL(window.location.href);
      url.hash = `room=${myId}`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url.toString()).then(() => {
          toast('已复制同屏房间链接，发给好友直接加入！');
        }).catch(() => {
          toast(url.toString());
        });
      } else {
        toast(url.toString());
      }
    });
  }

  document.getElementById('connect-btn').addEventListener('click', () => {
    const v = document.getElementById('remote-id').value.trim();
    if (!v) return;
    if (v === myId) { toast('不能连接自己'); return; }
    if (conns[v]) { toast('已连接'); return; }
    connectToPeer(v);
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
    // 告知新连接节点当前已知的其他节点列表，完成多人群组网状互联 (Full Mesh)
    const existingPeers = Object.keys(conns).filter(p => p !== conn.peer);
    if (existingPeers.length > 0) {
      try {
        conn.send({ t: 'peer_list', list: existingPeers });
      } catch (e) {}
    }

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
  } else if (m.t === 'peer_list' && Array.isArray(m.list)) {
    // 自动连接房间内其它在线同屏成员，实现全网状拓扑
    m.list.forEach(otherPeerId => {
      if (otherPeerId && otherPeerId !== myId && !conns[otherPeerId]) {
        connectToPeer(otherPeerId);
      }
    });
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
  if (el) el.textContent = n ? (`同屏中: ${n + 1}人`) : '单人模式';
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
