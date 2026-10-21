/**
 * PeerJS WebRTC P2P Mesh & Room Synchronization Layer
 *
 * Improvements in refactored network layer:
 * 1. Connection lifecycle guard: prevents stale/replaced connection `close`/`error`
 *    events from evicting an active replacement connection in `conns[peerId]`.
 * 2. Sliding-window deduplication (`BoundedSet`): replaces abrupt `seen.clear()`
 *    wipes with FIFO eviction so in-flight mesh relays never echo.
 * 3. Transparent large-payload chunking (`CHUNK_THRESHOLD = 48 KB`): splits
 *    oversized messages (e.g., high-res images or large snapshots) into chunks
 *    and reassembles them with TTL cleanup, while keeping standard messages
 *    unwrapped on the wire.
 * 4. CRDT & Tombstone synchronization: delegates conflict resolution to `crdt.js`
 *    and exchanges tombstones during `fullSync` so deleted items never resurrect.
 * 5. Clean room lifecycle (`joinRoom`, `leaveRoom`): allows users to leave a
 *    foreign room and return to their own persisted board with one click.
 * @module network
 */

import { Peer } from 'peerjs';
import {
  state, peers, peerId, peerName, peerColor, persist, removeEl,
  setPersistKey, getRoomKey, setSelfPeerId, tombstones,
} from './state.js';
import { uid, toast, deepCopy, BoundedSet } from './utils.js';
import { requestRender, clearImageCache } from './renderer.js';
import { beats, sanitizeElement, mergeConcurrentDragProps, applyLiveMoveGeometry } from './crdt.js';
import { bus, EVENTS } from './events.js';

export const NET_STATUS = Object.freeze({
  CONNECTING: 'connecting',
  ONLINE_SOLO: 'online_solo',
  COLLABORATING: 'collaborating',
  RECONNECTING: 'reconnecting',
  OFFLINE: 'offline',
});

let peer = null;
let myId = null;
let _forceSaveId = false;
let activeRoomId = null; // Non-null when user explicitly joined a foreign room
const conns = {};
const seen = new BoundedSet(4000);
let lastCursor = 0;
const _bcache = {};
const manualTargets = new Set();

const STALE_CONN_MS = 20000;
const CHUNK_THRESHOLD = 48 * 1024; // 48 KB threshold for WebRTC DataChannel framing
const CHUNK_SIZE = 32 * 1024;      // 32 KB per chunk
const CHUNK_TTL_MS = 30000;
const incomingChunks = new Map();  // chunkId -> { parts: string[], received: number, total: number, ts: number }

// References to registered DOM/window listeners so repeated initNetwork() calls
// (e.g. in test suites) replace rather than stack duplicate handlers.
let _boundHashChange = null;
let _boundBeforeUnload = null;
let _boundConnectClick = null;
let _boundRemoteKeydown = null;
let _boundMyIdClick = null;
let _boundShareClick = null;
let _boundLeaveClick = null;

function roomFromHash() {
  const hash = (window.location.hash || '').replace(/^#/, '');
  const m = hash.match(/(?:room=)?([a-zA-Z0-9_-]+)/);
  return m ? m[1] : '';
}

/**
 * Safely detach and close a connection, removing its entry from `conns` and `peers`.
 * Handles PeerJS 1.5.x quirk where `close()` on a never-opened connection does
 * not emit `'close'` and `peer-unavailable` does not clean up internal state.
 * @param {string} id
 */
function dropConn(id) {
  const c = conns[id];
  if (c) {
    c._detached = true;
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
    if (!conns[id]._opened && now - (conns[id]._ts || now) > STALE_CONN_MS) {
      dropConn(id);
    }
  }
  for (const [cid, entry] of incomingChunks.entries()) {
    if (now - entry.ts > CHUNK_TTL_MS) {
      incomingChunks.delete(cid);
    }
  }
}

/**
 * Connect to a remote peer ID
 * @param {string} remoteId
 * @param {boolean} [manual=false] Whether initiated directly by user action
 */
export function connectToPeer(remoteId, manual = false) {
  if (!remoteId || remoteId === myId) return;
  if (!peer || !myId || !peer.open) {
    toast('网络服务尚未就绪');
    return;
  }
  if (conns[remoteId] && !conns[remoteId]._opened) {
    dropConn(remoteId);
  }
  if (conns[remoteId]) return;

  let c = null;
  try {
    c = peer.connect(remoteId, { reliable: true });
  } catch (e) {
    return;
  }
  if (!c) return;
  if (manual) {
    manualTargets.add(remoteId);
    activeRoomId = remoteId;
  }
  setupConn(c, true);
}

/**
 * Leave the current foreign room and restore the user's own local whiteboard
 */
export function leaveRoom() {
  for (const id of Object.keys(conns)) {
    dropConn(id);
  }
  activeRoomId = null;
  if (window.location.hash) {
    window.location.hash = '';
  }
  const remoteInput = document.getElementById('remote-id');
  if (remoteInput) remoteInput.value = '';

  const myKey = 'wb-elements-v2:' + (myId || 'default');
  setPersistKey(myKey);
  try {
    const raw = localStorage.getItem(myKey);
    state.elements = raw ? (JSON.parse(raw) || {}) : {};
  } catch (e) {
    state.elements = {};
  }
  state.selectedId = null;
  state.__mut++;
  state.persistable = true;
  persist();
  updateNetUI();
  updatePresence();
  requestRender();
  toast('已返回个人画布');
}

/**
 * Return current network diagnostics / status snapshot
 */
export function getNetworkState() {
  const openPeers = Object.keys(conns).filter(id => conns[id] && conns[id]._opened);
  return {
    myId,
    activeRoomId,
    connectedPeers: openPeers,
    signalingOpen: Boolean(peer && peer.open),
    persistable: state.persistable,
  };
}

function showRoomConflictModal(oldId, onRetryOriginal, onUseNewRoom) {
  const existing = document.getElementById('room-conflict-modal');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'room-conflict-modal';
  overlay.style.cssText = [
    'position: fixed',
    'top: 0',
    'left: 0',
    'width: 100vw',
    'height: 100vh',
    'background: rgba(0,0,0,0.55)',
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'z-index: 100000',
  ].join(';');

  const box = document.createElement('div');
  box.style.cssText = [
    'background: #fff',
    'border-radius: 10px',
    'padding: 28px 32px',
    'max-width: 420px',
    'width: 90%',
    'box-shadow: 0 8px 30px rgba(0,0,0,0.25)',
  ].join(';');

  const h2 = document.createElement('h2');
  h2.style.cssText = 'margin:0 0 12px;font-size:18px;font-weight:600;color:#1a1a1a;';
  h2.textContent = '房间号被占用';
  box.appendChild(h2);

  const desc = document.createElement('p');
  desc.style.cssText = 'margin:0 0 6px;font-size:14px;color:#555;line-height:1.6;';
  desc.appendChild(document.createTextNode('原房间号 '));
  const code = document.createElement('code');
  code.style.cssText = 'background:#f0f0f0;padding:2px 6px;border-radius:4px;font-family:monospace;font-size:13px;';
  code.textContent = oldId;
  desc.appendChild(code);
  desc.appendChild(document.createTextNode(' 已被其他用户占用。'));
  box.appendChild(desc);

  const tip = document.createElement('p');
  tip.style.cssText = 'margin:0 0 20px;font-size:13px;color:#999;line-height:1.5;';
  tip.textContent = '你可以重试原房间号，或者使用一个新的随机房间号。';
  box.appendChild(tip);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex;gap:12px;';

  const retryBtn = document.createElement('button');
  retryBtn.style.cssText = [
    'flex:1',
    'padding:10px 16px',
    'border:1px solid #d0d0d0',
    'border-radius:6px',
    'background:#f5f5f5',
    'color:#333',
    'font-size:14px',
    'cursor:pointer',
  ].join(';');
  retryBtn.textContent = '重试原房间';
  retryBtn.addEventListener('mouseenter', () => { retryBtn.style.background = '#e8e8e8'; });
  retryBtn.addEventListener('mouseleave', () => { retryBtn.style.background = '#f5f5f5'; });
  retryBtn.addEventListener('click', () => { overlay.remove(); onRetryOriginal(); });
  btnRow.appendChild(retryBtn);

  const newBtn = document.createElement('button');
  newBtn.style.cssText = [
    'flex:1',
    'padding:10px 16px',
    'border:none',
    'border-radius:6px',
    'background:#2b6fe2',
    'color:#fff',
    'font-size:14px',
    'font-weight:500',
    'cursor:pointer',
  ].join(';');
  newBtn.textContent = '使用新房间号';
  newBtn.addEventListener('mouseenter', () => { newBtn.style.background = '#2361cb'; });
  newBtn.addEventListener('mouseleave', () => { newBtn.style.background = '#2b6fe2'; });
  newBtn.addEventListener('click', () => { overlay.remove(); onUseNewRoom(); });
  btnRow.appendChild(newBtn);

  box.appendChild(btnRow);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function showShareDialog(url) {
  const existing = document.getElementById('share-dialog');
  if (existing) existing.remove();

  const targetRoom = activeRoomId || myId;
  const overlay = document.createElement('div');
  overlay.id = 'share-dialog';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);';

  dialog.innerHTML = `
    <h3 style="margin:0 0 12px 0;font-size:16px;">分享房间链接</h3>
    <p style="margin:0 0 12px 0;font-size:13px;color:#666;">复制链接发给好友，对方打开即可加入同屏协作。</p>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;">
      <input type="text" id="share-url-input" value="${url}" readonly 
        style="flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:12px;font-family:monospace;">
      <button id="share-copy-btn" style="padding:8px 16px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;">复制链接</button>
    </div>
    <div style="display:flex;gap:8px;">
      <button id="share-copy-id-btn" style="padding:8px 16px;background:#f0f0f0;color:#333;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;">复制房间ID (${targetRoom})</button>
      <button id="share-close-btn" style="padding:8px 16px;background:#f0f0f0;color:#333;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;margin-left:auto;">关闭</button>
    </div>
  `;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  document.getElementById('share-copy-btn').addEventListener('click', () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(() => toast('已复制链接')).catch(() => toast(url));
    } else {
      toast(url);
    }
  });

  document.getElementById('share-copy-id-btn').addEventListener('click', () => {
    if (navigator.clipboard) {
      navigator.clipboard.writeText(targetRoom).then(() => toast('已复制房间ID')).catch(() => toast(targetRoom));
    } else {
      toast(targetRoom);
    }
  });

  document.getElementById('share-close-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

function bootPeer(id, retries) {
  let p;
  try {
    p = new Peer(id);
  } catch (e) {
    toast('无法创建网络连接');
    return;
  }
  peer = p;

  p.on('open', id2 => onPeerOpen(id2, Boolean(id)));

  p.on('connection', conn => setupConn(conn, false));

  p.on('error', err => {
    if (!err) return;
    if (err.type === 'peer-unavailable') {
      const m = String(err.message || '').match(/peer ([\w.-]+)/);
      const target = m ? m[1] : null;
      const isManual = target ? manualTargets.has(target) : manualTargets.size > 0;
      if (target) dropConn(target);
      else pruneStaleConns();
      if (isManual) toast('目标用户未在线或房间号不存在');
      return;
    }
    if (err.type === 'unavailable-id') {
      try { p.destroy(); } catch (e) {}
      if (retries > 0) {
        toast('房间号被占用，正在重试…');
        setTimeout(() => bootPeer(id, retries - 1), 1200);
      } else {
        showRoomConflictModal(id, () => {
          bootPeer(id, 3);
        }, () => {
          _forceSaveId = true;
          bootPeer(undefined, 0);
        });
      }
      return;
    }
    toast('网络提示: ' + err.type);
  });

  p.on('disconnected', () => {
    if (peer === p && !p.destroyed) {
      try { p.reconnect(); } catch (e) {}
    }
  });
  return p;
}

function onPeerOpen(id, fromStorage) {
  myId = id;
  setSelfPeerId(id);
  if (fromStorage || _forceSaveId || !localStorage.getItem('wb-peer-id')) {
    try { localStorage.setItem('wb-peer-id', id); } catch (e) {}
  }
  _forceSaveId = false;

  if (!roomFromHash()) {
    setPersistKey('wb-elements-v2:' + id);
  }
  const el = document.getElementById('my-id');
  if (el) {
    el.textContent = '房间: ' + id;
    el.title = '点击复制我的房间ID: ' + id;
  }
  updateNetUI();
  broadcast({ t: 'presence', name: peerName, color: peerColor });
  toast('已上线，可邀请好友同屏协作');

  const target = roomFromHash();
  if (target && target !== id) {
    state.persistable = false;
    activeRoomId = target;
    joinRoomFromUrl(target);
  }
}

function joinRoomFromUrl(targetRoomId) {
  const remoteInput = document.getElementById('remote-id');
  if (remoteInput) remoteInput.value = targetRoomId;
  toast('正在加入房间: ' + targetRoomId);
  connectToPeer(targetRoomId, true);
}

export function initNetwork() {
  // Reset connection state cleanly on re-initialization
  for (const id of Object.keys(conns)) {
    delete conns[id];
  }
  manualTargets.clear();
  incomingChunks.clear();
  activeRoomId = null;

  let storedId;
  try { storedId = localStorage.getItem('wb-peer-id') || undefined; } catch (e) { storedId = undefined; }
  bootPeer(storedId, 3);

  if (_boundHashChange) window.removeEventListener('hashchange', _boundHashChange);
  _boundHashChange = () => {
    const newRoom = roomFromHash();
    const ownHash = !newRoom || newRoom === myId;
    if (newRoom && newRoom !== myId && newRoom !== getRoomKey()) {
      persist();
      state.persistable = false;
      activeRoomId = newRoom;
      state.elements = {};
      state.selectedId = null;
      state.__mut++;
      const newKey = 'wb-elements-v2:' + newRoom;
      setPersistKey(newKey);
      updateNetUI();
      requestRender();
    } else if (ownHash && !state.persistable) {
      activeRoomId = null;
      const myKey = 'wb-elements-v2:' + (myId || 'default');
      setPersistKey(myKey);
      try {
        const raw = localStorage.getItem(myKey);
        state.elements = raw ? (JSON.parse(raw) || {}) : {};
      } catch (e) {
        state.elements = {};
      }
      state.selectedId = null;
      state.__mut++;
      state.persistable = true;
      persist();
      updateNetUI();
      requestRender();
    }
    if (newRoom && newRoom !== myId && !conns[newRoom]) {
      joinRoomFromUrl(newRoom);
    }
  };
  window.addEventListener('hashchange', _boundHashChange);

  setInterval(() => {
    if (peer && peer.open) {
      broadcast({ t: 'presence', name: peerName, color: peerColor });
    }
  }, 4000);

  if (_boundBeforeUnload) window.removeEventListener('beforeunload', _boundBeforeUnload);
  _boundBeforeUnload = () => {
    broadcast({ t: 'leave' });
    if (peer) try { peer.destroy(); } catch (e) {}
  };
  window.addEventListener('beforeunload', _boundBeforeUnload);

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

  const myIdEl = document.getElementById('my-id');
  if (myIdEl) {
    myIdEl.style.cursor = 'pointer';
    if (_boundMyIdClick) myIdEl.removeEventListener('click', _boundMyIdClick);
    _boundMyIdClick = () => {
      const idToCopy = activeRoomId || myId;
      if (!idToCopy) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(idToCopy).then(() => toast('已复制房间ID: ' + idToCopy)).catch(() => toast(idToCopy));
      } else {
        toast(idToCopy);
      }
    };
    myIdEl.addEventListener('click', _boundMyIdClick);
  }

  const shareBtn = document.getElementById('share-link-btn');
  if (shareBtn) {
    if (_boundShareClick) shareBtn.removeEventListener('click', _boundShareClick);
    _boundShareClick = () => {
      const targetRoom = activeRoomId || myId;
      if (!targetRoom) { toast('请等待连接建立'); return; }
      const url = new URL(window.location.href);
      url.hash = `room=${targetRoom}`;
      showShareDialog(url.toString());
    };
    shareBtn.addEventListener('click', _boundShareClick);
  }

  const connectBtn = document.getElementById('connect-btn');
  if (connectBtn) {
    if (_boundConnectClick) connectBtn.removeEventListener('click', _boundConnectClick);
    _boundConnectClick = () => {
      const v = document.getElementById('remote-id').value.trim();
      if (!v) return;
      if (v === myId) { toast('不能连接自己'); return; }
      if (conns[v] && conns[v]._opened) { toast('已连接'); return; }
      persist();
      state.persistable = false;
      activeRoomId = v;
      connectToPeer(v, true);
      updateNetUI();
      toast('正在连接…');
    };
    connectBtn.addEventListener('click', _boundConnectClick);
  }

  const leaveBtn = document.getElementById('leave-btn');
  if (leaveBtn) {
    if (_boundLeaveClick) leaveBtn.removeEventListener('click', _boundLeaveClick);
    _boundLeaveClick = () => leaveRoom();
    leaveBtn.addEventListener('click', _boundLeaveClick);
  }

  const remoteInput = document.getElementById('remote-id');
  if (remoteInput) {
    if (_boundRemoteKeydown) remoteInput.removeEventListener('keydown', _boundRemoteKeydown);
    _boundRemoteKeydown = e => {
      if (e.key === 'Enter') document.getElementById('connect-btn').click();
    };
    remoteInput.addEventListener('keydown', _boundRemoteKeydown);
  }
}

function setupConn(conn, isInitiator = false) {
  const prev = conns[conn.peer];
  if (prev && prev !== conn) {
    prev._detached = true;
    if (!prev._opened) {
      try { prev.close(); } catch (e) {}
    }
  }

  conns[conn.peer] = conn;
  conn._opened = false;
  conn._detached = false;
  conn._ts = Date.now();

  conn.on('open', () => {
    if (conn._detached) return;
    conn._opened = true;
    manualTargets.delete(conn.peer);
    updateNetUI();

    const existingPeers = Object.keys(conns).filter(p => p !== conn.peer && conns[p]._opened);
    if (existingPeers.length > 0) {
      sendOnConn(conn, { t: 'peer_list', list: existingPeers });
    }

    if (isInitiator) {
      sendOnConn(conn, { t: 'request' });
    }
    broadcast({ t: 'presence', name: peerName, color: peerColor });
  });

  conn.on('data', m => {
    if (!m || conn._detached) return;
    if (m.t === 'chunk') {
      handleChunk(m, conn);
      return;
    }
    if (m.mid) {
      if (seen.has(m.mid)) return;
      seen.add(m.mid);
    }
    handleMsg(m, conn);
    relay(m, conn.peer);
  });

  conn.on('close', () => {
    if (conn._detached || (conns[conn.peer] && conns[conn.peer] !== conn)) return;
    delete conns[conn.peer];
    delete peers[conn.peer];
    manualTargets.delete(conn.peer);
    updateNetUI();
    updatePresence();
    requestRender();
  });

  conn.on('error', () => {
    if (conn._detached || (conns[conn.peer] && conns[conn.peer] !== conn)) return;
    if (!conn._opened) dropConn(conn.peer);
  });
}

function handleChunk(m, conn) {
  const { chunkId, idx, total, data } = m;
  if (!chunkId || typeof idx !== 'number' || typeof total !== 'number' || total <= 0 || total > 512) return;
  let entry = incomingChunks.get(chunkId);
  if (!entry) {
    entry = { parts: new Array(total), received: 0, total, ts: Date.now() };
    incomingChunks.set(chunkId, entry);
  }
  if (idx >= 0 && idx < total && entry.parts[idx] === undefined) {
    entry.parts[idx] = data;
    entry.received++;
    entry.ts = Date.now();
  }
  if (entry.received === entry.total) {
    incomingChunks.delete(chunkId);
    try {
      const fullMsg = JSON.parse(entry.parts.join(''));
      if (fullMsg.mid) {
        if (seen.has(fullMsg.mid)) return;
        seen.add(fullMsg.mid);
      }
      handleMsg(fullMsg, conn);
      relay(fullMsg, conn.peer);
    } catch (e) {}
  }
}

/**
 * Send a message over a single DataConnection, automatically chunking if the
 * serialized payload exceeds `CHUNK_THRESHOLD` (e.g. high-res base64 images).
 * Normal messages are passed directly as plain objects so mocks and small
 * messages incur zero serialization overhead.
 */
function sendOnConn(conn, msg) {
  if (!conn || !conn.open) return;
  try {
    // Only check size when message potentially carries heavy image/state data
    const mightBeLarge =
      (msg.t === 'upsert' && msg.el && msg.el.type === 'image' && msg.el.dataUrl && msg.el.dataUrl.length > CHUNK_THRESHOLD) ||
      (msg.t === 'state' && msg.elements && Object.keys(msg.elements).length > 25);

    if (mightBeLarge) {
      const raw = JSON.stringify(msg);
      if (raw.length > CHUNK_THRESHOLD) {
        const chunkId = uid();
        const total = Math.ceil(raw.length / CHUNK_SIZE);
        for (let i = 0; i < total; i++) {
          conn.send({
            t: 'chunk',
            chunkId,
            idx: i,
            total,
            data: raw.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE),
          });
        }
        return;
      }
    }
    conn.send(msg);
  } catch (e) {}
}

export function broadcast(msg) {
  msg.from = peerId;
  msg.pid = myId;
  sendLocal(msg);
}

function sendLocal(msg) {
  if (!msg.mid) msg.mid = uid();
  seen.add(msg.mid);
  for (const id in conns) {
    if (conns[id].open) {
      sendOnConn(conns[id], msg);
    }
  }
}

function relay(msg, exceptId) {
  for (const id in conns) {
    if (id !== exceptId && conns[id].open) {
      sendOnConn(conns[id], msg);
    }
  }
}

function handleMsg(m, conn) {
  if (m.t === 'upsert') {
    const el = sanitizeElement(m.el, m.pid);
    if (!el) return;
    if (tombstones.has(el.id)) return;
    const cur = state.elements[el.id];

    // If local user is dragging this exact element, accept concurrent style/text
    // updates while preserving local drag coordinates
    if (state.drag && state.drag.id === el.id) {
      if (mergeConcurrentDragProps(cur, el)) {
        persist();
        requestRender();
      }
      return;
    }

    // Preserve local cached dataUrl when receiving a stripped live-move frame
    if (cur && cur.type === 'image' && cur.dataUrl && !el.dataUrl) {
      el.dataUrl = cur.dataUrl;
    }

    if (!cur || el._isLiveMove || beats(el, cur)) {
      if (el._isLiveMove && cur) {
        applyLiveMoveGeometry(cur, el);
      } else {
        state.__mut++;
        state.elements[el.id] = el;
      }
      if (!el._isLiveMove) persist();
      bus.emit(EVENTS.SELECTION_CHANGED, state.selectedId);
      requestRender();
    }
  } else if (m.t === 'delete') {
    if (m.id) {
      tombstones.add(m.id);
      if (state.elements[m.id]) {
        clearThrottled(m.id);
        removeEl(m.id, false);
      }
    }
  } else if (m.t === 'state') {
    if (Array.isArray(m.tombstones)) {
      for (const tid of m.tombstones) {
        if (typeof tid === 'string' && tid) {
          tombstones.add(tid);
          if (state.elements[tid]) {
            if (state.elements[tid].type === 'image') clearImageCache(tid);
            delete state.elements[tid];
          }
        }
      }
    }
    if (m.fullSync) {
      const dragId = state.drag && state.drag.id;
      const dragPos = dragId && state.elements[dragId]
        ? { x: state.elements[dragId].x, y: state.elements[dragId].y, rotation: state.elements[dragId].rotation }
        : null;
      const incoming = m.elements || {};

      for (const id in state.elements) {
        const cur = state.elements[id];
        const inc = incoming[id];
        if (cur.type === 'image' && (!inc || (inc.rev || 0) >= (cur.rev || 0))) {
          clearImageCache(id);
        }
      }
      for (const id in incoming) {
        if (tombstones.has(id)) continue;
        const el = sanitizeElement(incoming[id], m.pid);
        if (!el) continue;
        const cur = state.elements[id];
        if (!cur || beats(el, cur)) {
          state.elements[id] = el;
        }
      }
      if (dragId && dragPos && state.elements[dragId]) {
        state.elements[dragId].x = dragPos.x;
        state.elements[dragId].y = dragPos.y;
        if (dragPos.rotation !== undefined) state.elements[dragId].rotation = dragPos.rotation;
      }
    } else {
      for (const id in m.elements) {
        if (tombstones.has(id)) continue;
        const el = sanitizeElement(m.elements[id], m.pid);
        if (!el) continue;
        const cur = state.elements[id];
        if (!cur || beats(el, cur)) state.elements[id] = el;
      }
    }
    state.__mut++;
    persist();
    requestRender();
  } else if (m.t === 'request') {
    const syncPayload = {
      t: 'state',
      elements: state.elements,
      tombstones: Array.from(tombstones),
      fullSync: true,
    };
    if (conn && conn.open) {
      sendOnConn(conn, syncPayload);
    } else {
      broadcast(syncPayload);
    }
  } else if (m.t === 'cursor') {
    const who = m.pid || m.from;
    if (!who) return;
    peers[who] = { name: m.name, color: m.color, cursor: { x: m.x, y: m.y }, last: performance.now() };
    updatePresence();
    requestRender();
  } else if (m.t === 'presence') {
    const who = m.pid || m.from;
    if (!who) return;
    if (!peers[who]) peers[who] = { name: m.name, color: m.color, last: performance.now() };
    else {
      peers[who].name = m.name;
      peers[who].color = m.color;
      peers[who].last = performance.now();
    }
    updatePresence();
  } else if (m.t === 'leave') {
    delete peers[m.pid || m.from];
    updatePresence();
    requestRender();
  } else if (m.t === 'peer_list' && Array.isArray(m.list)) {
    m.list.forEach(otherPeerId => {
      if (otherPeerId && otherPeerId !== myId && !conns[otherPeerId]) {
        connectToPeer(otherPeerId, false);
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

export function clearThrottled(id) {
  const c = _bcache[id];
  if (c) {
    if (c.timer) clearTimeout(c.timer);
    delete _bcache[id];
  }
}

export function broadcastThrottled(el) {
  if (!el || !el.id) return;
  const now = performance.now();
  let c = _bcache[el.id];
  if (!c) {
    _bcache[el.id] = c = { lastTime: 0, timer: null, payload: null };
  }

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

  const interval = 25;
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

  const leaveBtn = document.getElementById('leave-btn');
  if (leaveBtn) {
    leaveBtn.style.display = (!state.persistable || activeRoomId) ? '' : 'none';
  }
  bus.emit(EVENTS.NET_STATUS, { peers: n, persistable: state.persistable, activeRoomId });
}

export function updatePresence() {
  const box = document.getElementById('avatars');
  if (!box) return;
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
  const countEl = document.getElementById('online-count');
  if (countEl) countEl.textContent = all.length + ' 人在线';
  bus.emit(EVENTS.PRESENCE_CHANGED, all);
}
