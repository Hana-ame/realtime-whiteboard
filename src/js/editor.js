/**
 * Note text editor overlay
 * @module editor
 */

import { state, upsert, pushUndo } from './state.js';
import { worldToScreen } from './utils.js';
import { broadcastThrottled, clearThrottled } from './network.js';
import { requestRender } from './renderer.js';

let editor;

export function initEditor() {
  editor = document.getElementById('editor');
  if (!editor) return;

  editor.addEventListener('blur', () => closeEditor(true));
  editor.addEventListener('input', () => {
    if (state.editingId == null) return;
    const n = state.elements[state.editingId];
    if (n) {
      n.text = editor.value;
      broadcastThrottled(n);
      requestRender();
    }
  });
  editor.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeEditor(true);
    }
    e.stopPropagation();
  });
}

export function positionEditor(n) {
  if (!editor || !n) return;
  const tl = worldToScreen(n.x, n.y, state.view);
  const s = state.view.scale;
  editor.style.left = tl.x + 'px';
  editor.style.top = tl.y + 'px';
  editor.style.width = (n.w * s) + 'px';
  editor.style.height = (n.h * s) + 'px';
  const fs = n.fontSize || 16;
  editor.style.fontSize = (fs * s) + 'px';
  editor.style.padding = (Math.max(10, fs * 0.6) * s) + 'px';
  editor.style.lineHeight = '1.32';
  editor.style.borderRadius = (12 * s) + 'px';
  // Keep background transparent so the canvas-rendered note card (with exact
  // bgOpacity and drop shadow) shows underneath without double-rendering text
  editor.style.background = 'transparent';
  editor.style.opacity = String((n.textOpacity ?? 72) / 100);
  editor.style.transformOrigin = 'center center';
  editor.style.transform = n.rotation ? `rotate(${n.rotation}rad)` : '';
}

export function openEditor(n) {
  if (!editor || !n) return;
  state.editingId = n.id;
  pushUndo();
  editor.style.display = 'block';
  positionEditor(n);
  editor.style.color = '#1c1f2b';
  editor.value = n.text || '';
  requestRender();
  editor.focus();
  editor.select();
}

export function closeEditor(save) {
  if (state.editingId == null) return;
  const id = state.editingId;
  const n = state.elements[id];
  clearThrottled(id);
  state.editingId = null;
  if (editor) editor.style.display = 'none';
  if (save && n) {
    n.text = editor ? editor.value : n.text;
    upsert(n);
  } else {
    requestRender();
  }
}
