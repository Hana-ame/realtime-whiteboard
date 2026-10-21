/**
 * State management, undo/redo history, and persistence for the whiteboard
 * @module state
 */

import { hslColor, deepCopy, toast, uid } from './utils.js';
import { bus, EVENTS } from './events.js';
import { computeStateDiff } from './crdt.js';

export const NOTE_COLORS = ['#FFE08A', '#FFB3BA', '#BAFFC9', '#BAE1FF', '#E0BBE4', '#FFD8A8'];
export const PEN_COLORS  = ['#1c1f2b', '#e23b3b', '#1f8a4c', '#2b6fe2', '#f59e0b', '#8b3bd6'];
export const CONN_COLORS = ['#9aa0b4', '#e23b3b', '#1f8a4c', '#2b6fe2', '#f59e0b', '#8b3bd6', '#1c1f2b'];

export const state = {
  view: { x: 0, y: 0, scale: 1 },
  elements: {},
  selectedId: null,
  tool: 'select',
  noteColor: NOTE_COLORS[0],
  penColor: PEN_COLORS[1],
  penSize: 4,
  noteFontSize: 16,
  noteBgOpacity: 88,
  noteTextOpacity: 72,
  connColor: CONN_COLORS[0],
  drag: null,
  spaceDown: false,
  connectFrom: null,
  pointerWorld: { x: 0, y: 0 },
  editingId: null,
  W: 0,
  H: 0,
  // Structural mutation counter used to invalidate sortedIds & contentBounds caches
  __mut: 0,
  // True only when viewing/editing the user's own room; false when inside a foreign room
  persistable: true,
};

export const undoStack = [];
export const redoStack = [];
export const MAX_HISTORY = 60;

export const peerId = Math.random().toString(36).slice(2, 9);
export const peerName = '用户' + peerId.slice(0, 3).toUpperCase();
export const peerColor = hslColor(peerId);
export const peers = {};

// Deleted element IDs (tombstones) prevent stale snapshots from resurrecting deleted elements
export const tombstones = new Set();

// Room-scoped localStorage persistence key
export let persistKey = 'wb-elements-v2:default';
export function setPersistKey(k) {
  persistKey = k;
}
export function getRoomKey() {
  return persistKey.replace(/^wb-elements-v2:/, '');
}

// Local PeerJS ID assigned by signaling server
export let selfPeerId = null;
export function setSelfPeerId(id) {
  selfPeerId = id;
}

// Legacy dependency injection callbacks (kept alongside EventBus for backward compatibility)
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

function notifyRender() {
  if (_requestRenderFn) _requestRenderFn();
  bus.emit(EVENTS.RENDER_REQUEST);
}

function notifySelection() {
  if (_updateDeleteBtnFn) _updateDeleteBtnFn();
  bus.emit(EVENTS.SELECTION_CHANGED, state.selectedId);
}

function notifyBroadcast(msg) {
  if (_broadcastFn) _broadcastFn(msg);
  bus.emit(EVENTS.NET_BROADCAST, msg);
}

function notifyClearImageCache(id) {
  if (_clearImageCacheFn) _clearImageCacheFn(id);
  bus.emit(EVENTS.IMAGE_CACHE_CLEAR, id);
}

function notifyHistory() {
  bus.emit(EVENTS.HISTORY_CHANGED, {
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
  });
}

/**
 * Reset whiteboard state cleanly (useful for room transitions and tests)
 * @param {boolean} [clearHistory=true]
 */
export function resetState(clearHistory = true) {
  state.elements = {};
  state.selectedId = null;
  state.editingId = null;
  state.drag = null;
  state.connectFrom = null;
  state.__mut++;
  if (clearHistory) {
    undoStack.length = 0;
    redoStack.length = 0;
    tombstones.clear();
  }
  notifyHistory();
  notifySelection();
  notifyRender();
}

/**
 * Persist elements to localStorage (only when in user's own room)
 */
export function persist() {
  if (!state.persistable) return;
  try {
    localStorage.setItem(persistKey, JSON.stringify(state.elements));
  } catch (e) {}
}

/**
 * Push current state snapshot onto undo stack
 */
export function pushUndo() {
  undoStack.push(deepCopy(state.elements));
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  notifyHistory();
}

/**
 * Broadcast incremental element changes produced by undo/redo to connected peers
 * @param {Record<string, Object>} before
 * @param {Record<string, Object>} restored
 */
function broadcastHistoryDelta(before, restored) {
  if (!_broadcastFn && !bus._listeners.has(EVENTS.NET_BROADCAST)) return;
  const { upserts, deletes } = computeStateDiff(before, restored, selfPeerId || '');
  for (const id of deletes) {
    notifyBroadcast({ t: 'delete', id });
  }
  for (const el of upserts) {
    notifyBroadcast({ t: 'upsert', el });
  }
}

/**
 * Undo last action and synchronize incremental delta
 */
export function undo() {
  if (!undoStack.length) return;
  redoStack.push(deepCopy(state.elements));
  const before = state.elements;
  const restored = undoStack.pop();

  for (const id in restored) tombstones.delete(id);
  for (const id in before) {
    if (!Object.prototype.hasOwnProperty.call(restored, id)) {
      tombstones.add(id);
      if (before[id]?.type === 'image') notifyClearImageCache(id);
    }
  }

  state.elements = restored;
  state.selectedId = null;
  state.__mut++;
  broadcastHistoryDelta(before, restored);
  persist();
  notifyHistory();
  notifySelection();
  notifyRender();
  toast('已撤销');
}

/**
 * Redo last undone action and synchronize incremental delta
 */
export function redo() {
  if (!redoStack.length) return;
  undoStack.push(deepCopy(state.elements));
  const before = state.elements;
  const restored = redoStack.pop();

  for (const id in restored) tombstones.delete(id);
  for (const id in before) {
    if (!Object.prototype.hasOwnProperty.call(restored, id)) {
      tombstones.add(id);
      if (before[id]?.type === 'image') notifyClearImageCache(id);
    }
  }

  state.elements = restored;
  state.selectedId = null;
  state.__mut++;
  broadcastHistoryDelta(before, restored);
  persist();
  notifyHistory();
  notifySelection();
  notifyRender();
  toast('已重做');
}

/**
 * Update or insert an element with monotonic revision and client ID
 * @param {Object} el
 * @param {boolean} [doBroadcast=true]
 */
export function upsert(el, doBroadcast = true) {
  if (!el || !el.id) return;
  const cur = state.elements[el.id];
  el.rev = Math.max(el.rev || 0, cur?.rev || 0) + 1;
  el.updatedAt = Date.now();
  el.cid = selfPeerId || el.cid || '';
  delete el._isLiveMove;
  tombstones.delete(el.id);
  state.elements[el.id] = el;
  state.__mut++;
  persist();
  if (doBroadcast) notifyBroadcast({ t: 'upsert', el });
  bus.emit(EVENTS.ELEMENT_UPSERTED, el);
  notifyRender();
}

/**
 * Bring an element to the top of the z-order if it is not already at the top
 * @param {string} id
 */
export function bringToFront(id) {
  if (!state.elements[id]) return;
  const el = state.elements[id];
  let maxZ = el.z || 0;
  for (const k in state.elements) {
    const z = state.elements[k].z || 0;
    if (z > maxZ) maxZ = z;
  }
  if ((el.z || 0) === maxZ && Object.keys(state.elements).filter(k => (state.elements[k].z || 0) === maxZ).length <= 1) {
    return;
  }
  if (el.z === maxZ) return;
  el.z = maxZ + 1;
  upsert(el, true);
}

/**
 * Remove an element by ID and cascade-delete any attached connections
 * @param {string} id
 * @param {boolean} [doBroadcast=true]
 */
export function removeEl(id, doBroadcast = true) {
  if (!state.elements[id]) return;
  const el = state.elements[id];
  if (el.type === 'image') notifyClearImageCache(id);
  delete state.elements[id];
  if (state.selectedId === id) state.selectedId = null;
  tombstones.add(id);

  const linkedConnections = [];
  for (const key in state.elements) {
    const item = state.elements[key];
    if (item && item.type === 'connection' && (item.from === id || item.to === id)) {
      linkedConnections.push(key);
    }
  }
  for (const connId of linkedConnections) {
    delete state.elements[connId];
    tombstones.add(connId);
    if (doBroadcast) notifyBroadcast({ t: 'delete', id: connId });
  }

  state.__mut++;
  persist();
  if (doBroadcast) notifyBroadcast({ t: 'delete', id });
  bus.emit(EVENTS.ELEMENT_REMOVED, id);
  notifySelection();
  notifyRender();
}

/**
 * Duplicate the currently selected element with a small spatial offset
 * @returns {Object|null} The duplicated element
 */
export function duplicateSelected() {
  const id = state.selectedId;
  if (!id || !state.elements[id]) return null;
  const src = state.elements[id];
  if (src.type === 'connection') return null;

  pushUndo();
  const copy = deepCopy(src);
  copy.id = uid();
  copy.rev = 0;
  const offset = 24;
  if (copy.type === 'note' || copy.type === 'image') {
    copy.x = (copy.x || 0) + offset;
    copy.y = (copy.y || 0) + offset;
  } else if (copy.type === 'stroke' && Array.isArray(copy.points)) {
    copy.points = copy.points.map(p => ({ x: p.x + offset, y: p.y + offset }));
  }
  let maxZ = 0;
  for (const k in state.elements) {
    const z = state.elements[k].z || 0;
    if (z > maxZ) maxZ = z;
  }
  copy.z = maxZ + 1;
  upsert(copy, true);
  state.selectedId = copy.id;
  notifySelection();
  toast('已复制元素');
  return copy;
}
