import { Peer } from 'peerjs';
import { state, peers, peerId, peerName, peerColor, persist, removeEl } from './state.js';
import { uid, toast, deepCopy } from './utils.js';
import { requestRender, clearImageCache } from './renderer.js';

let peer = null;
let myId = null;
const conns = {};
const seen = new Set();
const tombstones = new Set();
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
  setupConn(c, true);
}

export function initNetwork() {
  try {
    let storedId;
    try { storedId = localStorage.getItem('wb-peer-id') || undefined; } catch(e) { storedId = undefined; }
    peer = new Peer(storedId);
  } catch (e) {
    toast('无法创建网络连接');
    return;
  }
  
  peer.on('open', id => {
    myId = id;
    try { localStorage.setItem('wb-peer-id', id); } catch(e) {}
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

  window.addEventListener('hashchange', () => {
    const hash = window.location.hash.replace(/^#/, '');
    const match = hash.match(/(?:room=)?([a-zA-Z0-9_-]+)/);
    if (match && match[1] && match[1] !== myId && !conns[match[1]]) {
      const targetRoomId = match[1];
      const remoteInput = document.getElementById('remote-id');
      if (remoteInput) remoteInput.value = targetRoomId;
      toast('正在加入房间: ' + targetRoomId);
      connectToPeer(targetRoomId);
    }
  });
  
  peer.on('connection', conn => setupConn(conn, false));
  peer.on('error', err => {
    if (err.type === 'peer-unavailable') {
      toast('目标用户未在线或房间号不存在');
    } else if (err.type === 'unavailable-id') {
      // 已存房间ID被另一标签页占用 → 退回随机ID，不覆写本地存储（保留主标签页房间号）
      toast('原房间ID被占用，已使用新ID');
      try { if (peer && !peer.destroyed) peer.destroy(); } catch(e) {}
      try {
        peer = new Peer();
        peer.on('open', id => {
          myId = id;
          const el = document.getElementById('my-id');
          if (el) el.textContent = '房间: ' + id;
          updateNetUI();
          broadcast({ t: 'presence', name: peerName, color: peerColor });
          const hash = window.location.hash.replace(/^#/, '');
          const m = hash.match(/(?:room=)?([a-zA-Z0-9_-]+)/);
          if (m && m[1] && m[1] !== id) connectToPeer(m[1]);
        });
        peer.on('connection', conn => setupConn(conn, false));
        peer.on('error', e2 => { if (e2.type !== 'peer-unavailable') toast('网络提示: ' + e2.type); });
        peer.on('disconnected', () => { if (peer && !peer.destroyed) { try { peer.reconnect(); } catch (e) {} } });
      } catch(e2) { toast('网络重连失败'); }
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

function setupConn(conn, isInitiator = false) {
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

    if (isInitiator) {
      try {
        conn.send({ t: 'request' });
      } catch (e) {}
    }
    broadcast({ t: 'presence', name: peerName, color: peerColor });
  });
  conn.on('data', m => {
    if (!m) return;
    if (m.mid) {
      if (seen.has(m.mid)) return;
      seen.add(m.mid);
      if (seen.size > 3000) seen.clear();
    }
    handleMsg(m, conn);
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

function handleMsg(m, conn) {
  if (m.t === 'upsert') {
    const el = m.el;
    if (!el || !el.id) return;
    // Reject upsert for tombstoned (deleted) elements
    if (tombstones.has(el.id)) return;
    // Block ALL remote updates to locally-dragged elements
    if (state.drag && state.drag.id === el.id) return;
    const cur = state.elements[el.id];
    // Preserve heavy image dataUrl if stripped during live drag
    if (cur && cur.type === 'image' && cur.dataUrl && !el.dataUrl) {
      el.dataUrl = cur.dataUrl;
    }
    if (!cur || el._isLiveMove || (el.rev || 0) > (cur.rev || 0)) {
      if (el._isLiveMove && cur) {
        // Only update geometry during live moves; preserve non-geometry (text, color, dataUrl)
        if ((cur.rev || 0) > (el.rev || 0)) el.rev = cur.rev;
        Object.assign(cur, { x: el.x, y: el.y, w: el.w, h: el.h, points: el.points });
      } else {
        state.elements[el.id] = el;
      }
      if (!el._isLiveMove) persist();
      requestRender();
    }
  } else if (m.t === 'delete') {
    if (state.elements[m.id]) {
      tombstones.add(m.id);
      clearThrottled(m.id);
      removeEl(m.id, false);
    }
  } else if (m.t === 'state') {
    if (m.fullSync) {
      // Preserve local drag position during fullSync to avoid position jumps
      const dragId = state.drag && state.drag.id;
      const dragPos = dragId && state.elements[dragId]
        ? { x: state.elements[dragId].x, y: state.elements[dragId].y } : null;
      // Merge per-element with rev comparison; preserve newer local data
      const incoming = m.elements || {};
      // Clear caches for images being replaced
      for (const id in state.elements) {
        const cur = state.elements[id];
        const inc = incoming[id];
        if (cur.type === 'image' && (!inc || (inc.rev || 0) >= (cur.rev || 0))) {
          clearImageCache(id);
        }
      }
      // Apply incoming elements only if they have higher rev (or don't exist locally)
      for (const id in incoming) {
        const el = incoming[id];
        const cur = state.elements[id];
        tombstones.delete(id); // Element exists in sync — clear tombstone
        if (!cur || (el.rev || 0) > (cur.rev || 0)) {
          state.elements[id] = el;
        }
      }
      // Remove elements that exist locally but not in sync AND are not locally newer
      // (don't delete — a stale sync might just be missing them)
      // Restore drag position if it was displaced by fullSync
      if (dragId && dragPos && state.elements[dragId]) {
        state.elements[dragId].x = dragPos.x;
        state.elements[dragId].y = dragPos.y;
      }
    } else {
      for (const id in m.elements) {
        const el = m.elements[id];
        const cur = state.elements[id];
        if (!cur || (el.rev || 0) >= (cur.rev || 0)) state.elements[id] = el;
      }
    }
    persist();
    requestRender();
  } else if (m.t === 'request') {
    if (conn && conn.open) {
      try {
        conn.send({ t: 'state', elements: state.elements, fullSync: true });
      } catch (e) {}
    } else {
      broadcast({ t: 'state', elements: state.elements, fullSync: true });
    }
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

/**
 * Clear pending throttled timer for an element (e.g. on pointerup)
 * @param {string} id
 */
export function clearThrottled(id) {
  const c = _bcache[id];
  if (c) {
    if (c.timer) clearTimeout(c.timer);
    delete _bcache[id];
  }
}

/**
 * Throttled broadcast for real-time live drag / draw updates
 * @param {Object} el
 */
export function broadcastThrottled(el) {
  if (!el || !el.id) return;
  const now = performance.now();
  let c = _bcache[el.id];
  if (!c) {
    _bcache[el.id] = c = { lastTime: 0, timer: null, payload: null };
  }

  // Strip heavy image base64 dataUrl during real-time movement frames
  let payload;
  if (el.type === 'image' && el.dataUrl) {
    payload = { ...el };
    delete payload.dataUrl;
    payload._isLiveMove = true;
  } else {
    payload = deepCopy(el);
    payload._isLiveMove = true;
  }
  c.payload = payload;

  const interval = 25; // ~40 fps ultra-responsive
  const elapsed = now - c.lastTime;

  if (elapsed >= interval) {
    c.lastTime = now;
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
    broadcast({ t: 'upsert', el: c.payload });
    c.payload = null;
  } else if (!c.timer) {
    c.timer = setTimeout(() => {
      c.timer = null;
      c.lastTime = performance.now();
      if (c.payload && state.elements[c.payload.id]) {
        broadcast({ t: 'upsert', el: c.payload });
        c.payload = null;
      }
    }, interval - elapsed);
  }
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
