/**
 * State management for the whiteboard
 * @module state
 */

import { hslColor, deepCopy, toast } from './utils.js';

export const NOTE_COLORS = ['#FFE08A','#FFB3BA','#BAFFC9','#BAE1FF','#E0BBE4','#FFD8A8'];
export const PEN_COLORS  = ['#1c1f2b','#e23b3b','#1f8a4c','#2b6fe2','#f59e0b','#8b3bd6'];

export const state = {
  view: { x: 0, y: 0, scale: 1 },
  elements: {},
  selectedId: null,
  tool: 'select',
  noteColor: NOTE_COLORS[0],
  penColor: PEN_COLORS[1],
  penSize: 4,
  noteFontSize: 16, // default for new notes
  noteBgOpacity: 88, // background opacity percent
  noteTextOpacity: 72, // text opacity percent
  connColor: '#9aa0b4',
  drag: null,
  spaceDown: false,
  connectFrom: null,
  pointerWorld: {x:0, y:0},
  editingId: null,
  W: 0,
  H: 0,
  // Mutation counter: bumped on every structural change (add/remove/re-z/replace
  // of elements). renderer.js caches sorted-id order, the grid pattern and the
  // minimap contentBounds on it, so it MUST be bumped whenever state.elements
  // membership or z-order can change — including wholesale replacement (undo/
  // redo/fullSync/room switch).
  __mut: 0,
  // 当前画布是否属于"自己"（自己的房间 = 无 room= hash，或 hash 就是自己的
  // PeerJS id）。进入别人的房间（URL room= / 手动输入 remoteId）时置 false：
  // persist() 自动失效，收到的别人的画布只在内存处理、绝不写 localStorage，
  // 否则下次自己打开看到的是别人的画布。hash 清空切回自己的房间时恢复 true，
  // 并把自己的画布写回 localStorage。
  persistable: true
};

export const undoStack = [];
export const redoStack = [];
export const MAX_HISTORY = 60;

export const peerId = Math.random().toString(36).slice(2,9);
export const peerName = '用户' + peerId.slice(0,3).toUpperCase();
export const peerColor = hslColor(peerId);
export const peers = {};

// 被删除的元素 id。本地删过就永不复活——否则收到旧快照会把已删元素重新拉出来。
// 旧代码把 tombstones 放在 network.js，导致"本地自己删的元素"没有 tombstone，
// 收到含该元素的 fullSync 照样复活。元素 id 是全局唯一 uid，不会重造，所以
// tombstone 可以永久生效。
export const tombstones = new Set();

// 内容缓存挂在具体房间下。旧代码固定写 'wb-elements-v1'，是全部房间共用的一个锅，
// 换房间会把上一个房间的画布当成新房间的内容显示出来。
export let persistKey = 'wb-elements-v2:default';
export function setPersistKey(k) { persistKey = k; }
export function getRoomKey() {
  return persistKey.replace(/^wb-elements-v2:/, '');
}

// 自己的 PeerJS id。peers 表按它做键，头像渲染要据此过滤掉自己。
export let selfPeerId = null;
export function setSelfPeerId(id) { selfPeerId = id; }

let _broadcastFn = null;
let _requestRenderFn = null;
let _clearImageCacheFn = null;
let _updateDeleteBtnFn = null;

export function setDeps(broadcastFn, requestRenderFn, clearImageCacheFn, updateDeleteBtnFn) {
  _broadcastFn = broadcastFn;
  _requestRenderFn = requestRenderFn;
  _clearImageCacheFn = clearImageCacheFn;
  _updateDeleteBtnFn = updateDeleteBtnFn;
}

/**
 * Persist elements to local storage
 */
export function persist() {
  // 别人的画布只在内存：进入别人的房间（persistable=false）后，任何 upsert /
  // fullSync / 删除都不许落盘，否则下次自己打开画布看到的是别人的内容。
  if (!state.persistable) return;
  try {
    localStorage.setItem(persistKey, JSON.stringify(state.elements));
  } catch(e) {}
}

/**
 * Push current state to undo stack
 */
export function pushUndo() {
  undoStack.push(deepCopy(state.elements));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
}

/**
 * Undo last action
 */
export function undo() {
  if (!undoStack.length) return;
  redoStack.push(deepCopy(state.elements));
  const before = state.elements;
  const restored = undoStack.pop();
  // 撤销删除的元素要清 tombstone，否则它会显示出来但再也无法被更新
  for (const id in restored) tombstones.delete(id);
  // 撤销添加的元素要进 tombstone，否则旧 fullSync 会把它复活
  for (const id in before) {
    if (!restored.hasOwnProperty(id)) tombstones.add(id);
  }
  state.elements = restored;
  state.selectedId = null;
  state.__mut++; // 整幅替换：sortedIds / contentBounds 缓存必须失效
  persist();
  // 刻意不广播：undo 是本地历史。广播全量快照会覆盖别人并发的改动，
  // 而且旧快照里还留着已删元素，会触发"删除复活"（见 network.js fullSync 分支）
  if (_requestRenderFn) _requestRenderFn();
  if (_updateDeleteBtnFn) _updateDeleteBtnFn();
  toast('已撤销');
}

/**
 * Redo last action
 */
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(deepCopy(state.elements));
  const before = state.elements;
  const restored = redoStack.pop();
  for (const id in restored) tombstones.delete(id);
  // 重做删除的元素要进 tombstone，否则旧 fullSync 会把它复活
  for (const id in before) {
    if (!restored.hasOwnProperty(id)) tombstones.add(id);
  }
  state.elements = restored;
  state.selectedId = null;
  state.__mut++; // 整幅替换：sortedIds / contentBounds 缓存必须失效
  persist();
  if (_requestRenderFn) _requestRenderFn();
  if (_updateDeleteBtnFn) _updateDeleteBtnFn();
  toast('已重做');
}

/**
 * Update or insert an element
 * @param {Object} el 
 * @param {boolean} doBroadcast 
 */
export function upsert(el, doBroadcast = true) {
  const cur = state.elements[el.id];
  el.rev = Math.max(el.rev || 0, cur?.rev || 0) + 1;
  el.updatedAt = Date.now();
  // cid = 最后一次改动的客户端（PeerJS id）。rev 是每元素自增计数器，本身不构成
  // 全序：两个端同时改同一元素会算出相同 rev，严格 > 比较会丢掉第二条、谁赢取决于
  // 网络到达顺序，端间永久分叉。带 cid 后所有端都能算出同一个赢家。
  el.cid = selfPeerId || el.cid || '';
  delete el._isLiveMove;
  state.elements[el.id] = el;
  state.__mut++; // 新增元素/替换/z 变化都会影响排序，sortedIds 缓存必须失效
  persist();
  if (doBroadcast && _broadcastFn) _broadcastFn({ t: 'upsert', el: el });
  if (_requestRenderFn) _requestRenderFn();
}

/**
 * Bring an element to the front (top of z-order) by re-inserting it
 */
export function bringToFront(id) {
  if (!state.elements[id]) return;
  const el = state.elements[id];
  // 用显式 z 而非对象插入顺序：旧代码靠 delete+reinsert 改插入顺序且本地不广播，
  // 各端叠放顺序分叉，点同一个交叠位置会选中不同元素。
  let maxZ = el.z || 0;
  for (const k in state.elements) {
    const z = state.elements[k].z || 0;
    if (z > maxZ) maxZ = z;
  }
  if (el.z === maxZ) return;   // 已经在最上层，不动（否则每次点击都广播一次无意义变化）
  el.z = maxZ + 1;
  upsert(el, true);            // 必须广播，否则各端又分叉
}

/**
 * Remove an element by id
 * @param {string} id 
 * @param {boolean} doBroadcast 
 */
export function removeEl(id, doBroadcast = true) {
  if (!state.elements[id]) return;
  const el = state.elements[id];
  if (el.type === 'image' && _clearImageCacheFn) _clearImageCacheFn(id);
  delete state.elements[id];
  if (state.selectedId === id) state.selectedId = null;
  tombstones.add(id);

  // 同时清理与该元素关联的所有连线
  const linkedConnections = [];
  for (const key in state.elements) {
    const el = state.elements[key];
    if (el && el.type === 'connection' && (el.from === id || el.to === id)) {
      linkedConnections.push(key);
    }
  }
  linkedConnections.forEach(connId => {
    delete state.elements[connId];
    tombstones.add(connId);
    if (doBroadcast && _broadcastFn) _broadcastFn({t: 'delete', id: connId});
  });

  state.__mut++; // 删除元素（含关联连线）：sortedIds / contentBounds 缓存必须失效
  persist();
  if (doBroadcast && _broadcastFn) _broadcastFn({t: 'delete', id: id});
  if (_requestRenderFn) _requestRenderFn();
  if (_updateDeleteBtnFn) _updateDeleteBtnFn();
}
