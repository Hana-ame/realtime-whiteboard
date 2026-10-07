import { Peer } from 'peerjs';
import { state, peers, peerId, peerName, peerColor, persist, removeEl, setPersistKey, getRoomKey, setSelfPeerId } from './state.js';
import { uid, toast, deepCopy } from './utils.js';
import { requestRender, clearImageCache } from './renderer.js';

let peer = null;
let myId = null;
const conns = {};
const seen = new Set();
const tombstones = new Set();
let lastCursor = 0;
const _bcache = {};
// 用户手动输入或链接进入的目标：只有这些目标失败才提示，网状互联的误报不打扰
const manualTargets = new Set();
// 未真正建立的连接超过这个时长就强制丢弃，兜底清理 peerjs 漏掉的残留条目
const STALE_CONN_MS = 20000;

function roomFromHash() {
  const hash = window.location.hash.replace(/^#/, '');
  const m = hash.match(/(?:room=)?([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * 摘掉一条连接并清掉所有关联状态。必须手写，原因是 peerjs 1.5.5 的两个坑叠加：
 *  1) 服务器判定目标不存在时发 EXPIRE，客户端只 `emitError('peer-unavailable')`，
 *     既不 `_connections.delete(peerId)` 也不 close 连接（对比 Leave 分支两件事都做）；
 *  2) `DataConnection.close()` 里有 `if (!this.open) return;`——没 open 过的连接
 *     调 close() 连 'close' 事件都不会触发。
 * 结果：连不上的目标会永久留在 conns 里，之后每次点「加入房间」都被
 * `if (conns[remoteId]) return` 静默拦下。这正是"输入房间号没反应/无法互联"的根因。
 */
function dropConn(id) {
  const c = conns[id];
  if (c) {
    try { c.close(); } catch (e) {}
    delete conns[id];
  }
  if (peers[id]) delete peers[id];
  manualTargets.delete(id);
  updateNetUI();
  updatePresence();
  requestRender();
}

function pruneStaleConns() {
  const now = Date.now();
  for (const id in conns) {
    if (!conns[id]._opened && now - (conns[id]._ts || now) > STALE_CONN_MS) dropConn(id);
  }
}

/**
 * Connect to a remote peer ID
 * @param {string} remoteId
 * @param {boolean} manual 是否用户主动发起（决定失败时是否提示）
 */
export function connectToPeer(remoteId, manual = false) {
  if (!remoteId || remoteId === myId) return;
  if (!peer || !myId || !peer.open) {
    toast('网络服务尚未就绪');
    return;
  }
  // 残留的未建立连接要允许重连，否则一次失败就永久锁死这个房间号
  if (conns[remoteId] && !conns[remoteId]._opened) dropConn(remoteId);
  if (conns[remoteId]) return;
  let c = null;
  try { c = peer.connect(remoteId, { reliable: true }); } catch (e) { return; }
  if (!c) return;   // peerjs 在 disconnected 状态下 connect() 返回 undefined
  if (manual) manualTargets.add(remoteId);
  setupConn(c, true);
}

/**
 * 用给定 id 建一个 Peer 并挂好全部事件。id 为空则用随机号。
 * retries>0 时，房间号被占用会退避重试——立刻换随机号会让房间号凭空变掉，
 * 别人按旧链接进来就找不到，比等几秒糟糕得多。
 */
function bootPeer(id, retries) {
  let p;
  try { p = new Peer(id); } catch (e) { toast('无法创建网络连接'); return; }
  peer = p;

  p.on('open', id2 => onPeerOpen(id2, !!id));

  p.on('connection', conn => setupConn(conn, false));

  p.on('error', err => {
    if (err.type === 'peer-unavailable') {
      // "Could not connect to peer <id>" 里带着目标 id，据此精确清理
      const m = String(err.message || '').match(/peer ([\w.-]+)/);
      const target = m ? m[1] : null;
      const isManual = target ? manualTargets.has(target) : manualTargets.size > 0;
      if (target) dropConn(target); else pruneStaleConns();
      if (isManual) toast('目标用户未在线或房间号不存在');
      return;
    }
    if (err.type === 'unavailable-id') {
      // 已存房间号被占用：可能是本浏览器另一个标签页在用，也可能是上次没正常
      // 退出留下的残留注册。先重试，等残留过期；都失败才退回随机号，并且顺手
      // 尝试加入原房间——占着它的如果是本浏览器另一个标签页，照样能进那个房间。
      try { p.destroy(); } catch (e) {}
      if (retries > 0) {
        toast('房间号被占用，正在重试…');
        setTimeout(() => bootPeer(id, retries - 1), 1200);
      } else {
        toast('原房间号被占用，已换新号上线');
        bootPeer(undefined, 0);
        if (id) setTimeout(() => connectToPeer(id), 800);
      }
      return;
    }
    toast('网络提示: ' + err.type);
  });

  p.on('disconnected', () => { if (peer === p && !p.destroyed) { try { p.reconnect(); } catch (e) {} } });
  return p;
}

/** peer 上线后的统一收尾：登记 id、写本地缓存、按 URL 自动进房间 */
function onPeerOpen(id, fromStorage) {
  myId = id;
  setSelfPeerId(id);
  // 只有正式房间号才写 localStorage；兜底随机号不能覆盖它
  if (fromStorage) {
    try { localStorage.setItem('wb-peer-id', id); } catch (e) {}
  }
  // 没有显式房间时用自己的 id 作为缓存房间，让本地内容归到自己的房间名下
  if (!roomFromHash()) setPersistKey('wb-elements-v2:' + id);
  const el = document.getElementById('my-id');
  if (el) el.textContent = '房间: ' + id;
  updateNetUI();
  broadcast({ t: 'presence', name: peerName, color: peerColor });
  toast('已上线，可邀请好友同屏协作');

  const target = roomFromHash();
  if (target && target !== id) joinRoomFromUrl(target);
}

function joinRoomFromUrl(targetRoomId) {
  const remoteInput = document.getElementById('remote-id');
  if (remoteInput) remoteInput.value = targetRoomId;
  toast('正在加入房间: ' + targetRoomId);
  connectToPeer(targetRoomId, true);
}

export function initNetwork() {
  let storedId;
  try { storedId = localStorage.getItem('wb-peer-id') || undefined; } catch(e) { storedId = undefined; }
  bootPeer(storedId, 3);

  window.addEventListener('hashchange', () => {
    const newRoom = roomFromHash();
    // 切到另一个房间：当前房间的内容存回它自己的缓存，再清空画布载入新房间的缓存。
    // 刻意不广播 delete——那些元素不属于"我"，广播出去会让上一个房间的人跟着丢内容。
    // 自己的房间号不触发（点"分享链接"复制的是我自己的 id，不算换房间）。
    if (newRoom && newRoom !== myId && newRoom !== getRoomKey()) {
      persist();
      state.elements = {};
      state.selectedId = null;
      const newKey = 'wb-elements-v2:' + newRoom;
      setPersistKey(newKey);
      try {
        const raw = localStorage.getItem(newKey);
        if (raw) state.elements = JSON.parse(raw) || {};
      } catch (e) {}
      requestRender();
    }
    if (newRoom && newRoom !== myId && !conns[newRoom]) joinRoomFromUrl(newRoom);
  });
  
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
    // 兜底清理 peerjs 漏掉的残留连接（见 dropConn 注释）
    pruneStaleConns();
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
    if (conns[v] && conns[v]._opened) { toast('已连接'); return; }
    connectToPeer(v, true);
    toast('正在连接…');
  });
  document.getElementById('remote-id').addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('connect-btn').click();
  });
}

function setupConn(conn, isInitiator = false) {
  conns[conn.peer] = conn;
  conn._opened = false;
  conn._ts = Date.now();
  conn.on('open', () => {
    conn._opened = true;
    manualTargets.delete(conn.peer);
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
    manualTargets.delete(conn.peer);
    updateNetUI();
    updatePresence();
    requestRender();
  });
  conn.on('error', () => {
    // 没建成就丢弃，别留成残留条目锁死这个房间号
    if (!conn._opened) dropConn(conn.peer);
  });
}

export function broadcast(msg) {
  msg.from = peerId;
  // 附带 PeerJS id：peers 表按 conn.peer 对齐，下线时才能精确清掉对应头像
  msg.pid = myId;
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
    // 用 pid（PeerJS id）做键，与 conn.peer 对齐，掉线时 dropConn 才能精确清掉
    const who = m.pid || m.from;
    peers[who] = { name: m.name, color: m.color, cursor: { x: m.x, y: m.y }, last: performance.now() };
    updatePresence();
    requestRender();
  } else if (m.t === 'presence') {
    const who = m.pid || m.from;
    if (!peers[who]) peers[who] = { name: m.name, color: m.color, last: performance.now() };
    else { peers[who].name = m.name; peers[who].color = m.color; peers[who].last = performance.now(); }
    updatePresence();
  } else if (m.t === 'leave') {
    delete peers[m.pid || m.from];
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
  // peers 的键是 PeerJS id，自己要用 myId 过滤，不能用本地随机的 peerId
  const ids = Object.keys(peers).filter(id => id !== myId);
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
