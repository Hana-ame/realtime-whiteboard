/**
 * Note text editor
 * @module editor
 */

import { state, upsert, pushUndo } from './state.js';
import { worldToScreen } from './utils.js';

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

export function positionEditor(n) {
  const tl = worldToScreen(n.x, n.y, state.view);
  const s = state.view.scale;
  editor.style.left = tl.x + 'px';
  editor.style.top = tl.y + 'px';
  editor.style.width = (n.w * s) + 'px';
  editor.style.height = (n.h * s) + 'px';
  editor.style.fontSize = (state.noteFontSize * s) + 'px';
  editor.style.padding = (10 * s) + 'px';
  editor.style.lineHeight = '1.32';
  editor.style.borderRadius = (12 * s) + 'px';
  editor.style.background = n.color;
}

export function openEditor(n) {
  state.editingId = n.id;
  pushUndo();
  editor.style.display = 'block';
  positionEditor(n);
  editor.style.color = '#1c1f2b';
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
