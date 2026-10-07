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
  const fs = n.fontSize || 16;
  editor.style.fontSize = (fs * s) + 'px';
  editor.style.padding = (Math.max(10, fs * 0.6) * s) + 'px';
  editor.style.lineHeight = '1.32';
  editor.style.borderRadius = (12 * s) + 'px';
  editor.style.background = n.color;
  // 便签带旋转时，编辑框跟着转（与 canvas 绘制同绕中心旋转，Word 式）
  editor.style.transformOrigin = 'center center';
  editor.style.transform = n.rotation ? `rotate(${n.rotation}rad)` : '';
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
