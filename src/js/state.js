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
  noteFontSize: 16,
  connColor: '#9aa0b4',
  drag: null,
  spaceDown: false,
  connectFrom: null,
  pointerWorld: {x:0, y:0},
  editingId: null,
  W: 0,
  H: 0
};

export const undoStack = [];
export const redoStack = [];
export const MAX_HISTORY = 60;

export const peerId = Math.random().toString(36).slice(2,9);
export const peerName = '用户' + peerId.slice(0,3).toUpperCase();
export const peerColor = hslColor(peerId);
export const peers = {};

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
  try {
    localStorage.setItem('wb-elements-v1', JSON.stringify(state.elements));
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
  state.elements = undoStack.pop();
  state.selectedId = null;
  persist();
  if (_broadcastFn) _broadcastFn({ t: 'state', elements: state.elements, fullSync: true });
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
  state.elements = redoStack.pop();
  state.selectedId = null;
  persist();
  if (_broadcastFn) _broadcastFn({ t: 'state', elements: state.elements, fullSync: true });
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
  delete el._isLiveMove;
  state.elements[el.id] = el;
  persist();
  if (doBroadcast && _broadcastFn) _broadcastFn({ t: 'upsert', el: el });
  if (_requestRenderFn) _requestRenderFn();
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
    if (doBroadcast && _broadcastFn) _broadcastFn({t: 'delete', id: connId});
  });

  persist();
  if (doBroadcast && _broadcastFn) _broadcastFn({t: 'delete', id: id});
  if (_requestRenderFn) _requestRenderFn();
  if (_updateDeleteBtnFn) _updateDeleteBtnFn();
}
