/**
 * Note text editor
 * @module editor
 */

import { state, upsert } from './state.js';
import { worldToScreen } from './utils.js';
import { NOTE_FONT } from './renderer.js';

let editor;

export function initEditor() {
  editor = document.getElementById('editor');
  
  editor.addEventListener('blur', () => closeEditor(true));
  editor.addEventListener('input', () => {
    if (state.editingId == null) return;
    const n = state.elements[state.editingId];
    if (n) {
      n.text = editor.value;
      upsert(n);
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

export function openEditor(n) {
  state.editingId = n.id;
  const tl = worldToScreen(n.x, n.y, state.view);
  editor.style.display = 'block';
  editor.style.left = tl.x + 'px';
  editor.style.top = tl.y + 'px';
  editor.style.width = (n.w * state.view.scale) + 'px';
  editor.style.height = (n.h * state.view.scale) + 'px';
  editor.style.fontSize = (NOTE_FONT * state.view.scale) + 'px';
  editor.style.color = '#1c1f2b';
  editor.style.background = n.color;
  editor.style.borderRadius = '12px';
  editor.value = n.text || '';
  editor.focus();
  editor.select();
}

export function closeEditor(save) {
  if (state.editingId == null) return;
  const n = state.elements[state.editingId];
  if (save && n) {
    n.text = editor.value;
    upsert(n);
  }
  editor.style.display = 'none';
  state.editingId = null;
}
