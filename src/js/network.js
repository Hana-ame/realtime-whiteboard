import { Peer } from 'peerjs';
import { state, peers, peerId, peerName, peerColor, persist, removeEl, setPersistKey, getRoomKey, setSelfPeerId, tombstones } from './state.js';
import { uid, toast, deepCopy } from './utils.js';
import { requestRender, clearImageCache } from './renderer.js';

let peer = null;
let myId = null;
let _forceSaveId = false; // 用户选择"使用新房间号"后，下次 onPeerOpen 应写入 localStorage
const conns = {};
const seen = new Set();
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
 * 比较两个版本的元素谁更新。rev 是每元素自增计数器，本身不构成全序：两个端同时
 * 改同一元素会算出相同的 rev，严格 > 比较会丢掉第二条、谁赢取决于网络到达顺序，
 * 端间永久分叉（A 留下改法 1、C 留下改法 2）。用 (rev, cid) 打破平局——cid 是
 * PeerJS id，所有端都能算出同一个赢家，结果收敛。
 */
function beats(a, cur) {
  const ar = a.rev || 0, cr = cur.rev || 0;
  if (ar !== cr) return ar > cr;
  return String(a.cid || '') > String(cur.cid || '');
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
 * 弹出模态框：原房间号被占用后让用户选择重试原号或使用新随机号。
 * 覆盖全屏、阻止点击穿透、只通过按钮关闭——避免用户无意间关掉而没做选择。
 */
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

/** 弹出分享对话框：展示房间链接并提供复制按钮 */
function showShareDialog(url) {
  const existing = document.getElementById('share-dialog');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'share-dialog';
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.55);z-index:10000;display:flex;align-items:center;justify-content:center;';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#fff;border-radius:12px;padding:24px;max-width:400px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);';

  dialog.innerHTML = `
    <h3 style="margin:0 0 12px 0;font-size:16px;">分享房间链接</h3>
    <p style="margin:0 0 12px 0;font-size:13px;color:#666;">复制链接发给好友，对方打开即可加入同屏。</p>
    <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px;">
      <input type="text" id="share-url-input" value="${url}" readonly 
        style="flex:1;padding:8px 12px;border:1px solid #ddd;border-radius:6px;font-size:12px;font-family:monospace;">
      <button id="share-copy-btn" style="padding:8px 16px;background:#4f46e5;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px;white-space:nowrap;">复制</button>
    </div>
    <div style="display:flex;gap:8px;">
      <button id="share-copy-id-btn" style="padding:8px 16px;background:#f0f0f0;color:#333;border:1px solid #ddd;border-radius:6px;cursor:pointer;font-size:13px;">复制房间ID</button>
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
      navigator.clipboard.writeText(myId).then(() => toast('已复制房间ID')).catch(() => toast(myId));
    } else {
      toast(myId);
    }
  });

  document.getElementById('share-close-btn').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
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
      // 退出留下的残留注册。先重试，等残留过期；都失败则弹窗让用户选择，
      // 不静默切换——静默换号会让别人按旧链接进来找不到人。
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

  p.on('disconnected', () => { if (peer === p && !p.destroyed) { try { p.reconnect(); } catch (e) {} } });
  return p;
}

/** peer 上线后的统一收尾：登记 id、写本地缓存、按 URL 自动进房间 */
function onPeerOpen(id, fromStorage) {
  myId = id;
  setSelfPeerId(id);
  // 首次访问没有存储的 ID，也需写入 localStorage 以便刷新后复用同一房间号
  if (fromStorage || _forceSaveId || !localStorage.getItem('wb-peer-id')) {
    try { localStorage.setItem('wb-peer-id', id); } catch (e) {}
  }
  _forceSaveId = false;
  // 没有显式房间时用自己的 id 作为缓存房间，让本地内容归到自己的房间名下
  if (!roomFromHash()) setPersistKey('wb-elements-v2:' + id);
  const el = document.getElementById('my-id');
  if (el) { el.textContent = '房间: ' + id; el.title = id; }
  updateNetUI();
  broadcast({ t: 'presence', name: peerName, color: peerColor });
  toast('已上线，可邀请好友同屏协作');

  const target = roomFromHash();
  if (target && target !== id) {
    // 通过 URL room= 进别人的房间：画布完全在内存处理，绝不写 localStorage。
    // 之后收到的 fullSync/upsert 只进 state.elements，persist() 因 persistable=false
    // 自动落空，下次自己打开仍是自己的画布。
    state.persistable = false;
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
  let storedId;
  try { storedId = localStorage.getItem('wb-peer-id') || undefined; } catch(e) { storedId = undefined; }
  bootPeer(storedId, 3);

  window.addEventListener('hashchange', () => {
    const newRoom = roomFromHash();
    // 自己的房间 = hash 为空，或 hash 指向自己的 PeerJS id
    const ownHash = !newRoom || newRoom === myId;
    // 切到另一个房间：若还在自己的房间，先把画布存回自己的 key（在别人的房间里
    // persistable 已是 false，persist() 自动不落盘），再清空画布。刻意不广播
    // delete——那些元素不属于"我"，广播出去会让上一个房间的人跟着丢内容。
    // 自己的房间号不触发（点"分享链接"复制的是我自己的 id，不算换房间）。
    if (newRoom && newRoom !== myId && newRoom !== getRoomKey()) {
      persist();
      state.persistable = false;
      state.elements = {};
      state.selectedId = null;
      state.__mut++; // 整幅替换：sortedIds / contentBounds 缓存必须失效
      const newKey = 'wb-elements-v2:' + newRoom;
      setPersistKey(newKey);
      // 别人的房间内容只通过网络同步。不读该 key 的本地旧内容——即便是旧方案
      // 残留的，也不是"我"的画布，读进来会显示成别人的旧画布。
      requestRender();
    } else if (ownHash && !state.persistable) {
      // hash 清空（或指向自己）= 切回自己的房间：恢复可持久化，加载并写回自己
      // 的画布。绝不把别人的元素写进 localStorage——只持久化自己的元素。
      const myKey = 'wb-elements-v2:' + (myId || 'default');
      setPersistKey(myKey);
      try {
        const raw = localStorage.getItem(myKey);
        state.elements = raw ? (JSON.parse(raw) || {}) : {};
      } catch (e) {
        state.elements = {};
      }
      state.selectedId = null;
      state.__mut++; // 整幅替换：sortedIds / contentBounds 缓存必须失效
      state.persistable = true;
      persist();
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

  // #copy-id 元素不存在，改由 #my-id 本身承担复制点击
  const myIdEl = document.getElementById('my-id');
  if (myIdEl) {
    myIdEl.style.cursor = 'pointer';
    myIdEl.addEventListener('click', () => {
      if (!myId) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(myId).then(() => toast('已复制房间ID')).catch(() => toast(myId));
      } else {
        toast(myId);
      }
    });
  }

  // 复制多人同屏房间链接
  const shareBtn = document.getElementById('share-link-btn');
  if (shareBtn) {
    shareBtn.addEventListener('click', () => {
      if (!myId) { toast('请等待连接建立'); return; }
      const url = new URL(window.location.href);
      url.hash = `room=${myId}`;
      showShareDialog(url.toString());
    });
  }

  document.getElementById('connect-btn').addEventListener('click', () => {
    const v = document.getElementById('remote-id').value.trim();
    if (!v) return;
    if (v === myId) { toast('不能连接自己'); return; }
    if (conns[v] && conns[v]._opened) { toast('已连接'); return; }
    // 手动输入 remoteId 加入 = 进入别人的房间：收到的画布只在内存处理，不写
    // localStorage；否则下次自己打开看到的是别人的画布。
    state.persistable = false;
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
    if (tombstones.has(el.id)) return;
    el.cid = el.cid || m.pid || '';
    const cur = state.elements[el.id];
    // 本地正在拖这个元素：只拒几何字段（避免拖一半被远程位置盖掉），非几何字段
    // （文字/颜色/字号/透明度）照收——否则对方在拖拽期间改的文字我这边永远停在旧值，
    // 松手后我广播的本地全量还会用旧文字盖掉对方的改动
    if (state.drag && state.drag.id === el.id) {
      if (!el._isLiveMove && cur) {
        let changed = false;
        for (const k of ['text', 'color', 'fontSize', 'bgOpacity', 'textOpacity']) {
          if (k in el && el[k] !== cur[k]) { cur[k] = el[k]; changed = true; }
        }
        if (changed) {
          // 把 rev 抬到对方的版本：我松手后的最终 upsert 会算出 R+2 严格胜出，
          // 否则我和对方都是 R+1 只能靠 cid 猜，猜输了我拖的位置就丢了
          if ((el.rev || 0) > (cur.rev || 0)) cur.rev = el.rev;
          persist();
          requestRender();
        }
      }
      return;
    }
    // 直播拖拽时 dataUrl 被剥离了，保留本地已有的
    if (cur && cur.type === 'image' && cur.dataUrl && !el.dataUrl) {
      el.dataUrl = cur.dataUrl;
    }
    if (!cur || el._isLiveMove || beats(el, cur)) {
      if (el._isLiveMove && cur) {
        // 直播拖拽只更新几何字段，保留非几何字段（文字/颜色/dataUrl）
        if ((cur.rev || 0) > (el.rev || 0)) el.rev = cur.rev;
        Object.assign(cur, { x: el.x, y: el.y, w: el.w, h: el.h, rotation: el.rotation, points: el.points });
      } else {
        // 新增元素或网络 upsert 覆盖：可能改变排序结果（包括对方 bringToFront
        // 随 upsert 带过来的 z 变化），sortedIds / contentBounds 缓存必须失效。
        state.__mut++;
        state.elements[el.id] = el;
      }
      if (!el._isLiveMove) persist();
      requestRender();
    }
  } else if (m.t === 'delete') {
    if (state.elements[m.id]) {
      // removeEl 内部记 tombstone
      clearThrottled(m.id);
      removeEl(m.id, false);
    }
  } else if (m.t === 'state') {
    if (m.fullSync) {
      // Preserve local drag position during fullSync to avoid position jumps
      const dragId = state.drag && state.drag.id;
      const dragPos = dragId && state.elements[dragId]
        ? { x: state.elements[dragId].x, y: state.elements[dragId].y, rotation: state.elements[dragId].rotation } : null;
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
        // 本地删过的元素永不复活——旧快照里还留着它们，不能因为收到快照就清 tombstone
        if (tombstones.has(id)) continue;
        el.cid = el.cid || m.pid || '';
        const cur = state.elements[id];
        if (!cur || beats(el, cur)) {
          state.elements[id] = el;
        }
      }
      // Remove elements that exist locally but not in sync AND are not locally newer
      // (don't delete — a stale sync might just be missing them)
      // Restore drag position if it was displaced by fullSync
      if (dragId && dragPos && state.elements[dragId]) {
        state.elements[dragId].x = dragPos.x;
        state.elements[dragId].y = dragPos.y;
        if (dragPos.rotation !== undefined) state.elements[dragId].rotation = dragPos.rotation;
      }
    } else {
      for (const id in m.elements) {
        const el = m.elements[id];
        if (tombstones.has(id)) continue;
        el.cid = el.cid || m.pid || '';
        const cur = state.elements[id];
        if (!cur || beats(el, cur)) state.elements[id] = el;
      }
    }
    // fullSync / 增量同步合并后整幅可能已经变化：sortedIds / contentBounds 缓存
    // 必须失效（persist() 内部由 persistable 控制是否落盘，别人的画布不会写进
    // localStorage）。
    state.__mut++;
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
