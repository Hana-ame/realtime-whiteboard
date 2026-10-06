/**
 * Toolbar UI and controls
 * @module toolbar
 */

import { state, NOTE_COLORS, PEN_COLORS, pushUndo, upsert } from './state.js';
import { requestRender } from './renderer.js';
import { clamp, screenToWorld } from './utils.js';
import { contentBounds } from './interaction.js';

export function initToolbar() {
  document.getElementById('tools').addEventListener('click', e => {
    const b = e.target.closest('.tool');
    if (!b) return;
    selectTool(b.dataset.tool);
  });

  const ns = document.getElementById('note-swatches');
  NOTE_COLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (i === 0 ? ' sel' : '');
    d.style.background = c;
    d.addEventListener('click', () => {
      state.noteColor = c;
      document.querySelectorAll('#note-swatches .sw').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      if (state.selectedId && state.elements[state.selectedId] && state.elements[state.selectedId].type === 'note') {
        pushUndo();
        state.elements[state.selectedId].color = c;
        upsert(state.elements[state.selectedId]);
      }
    });
    ns.appendChild(d);
  });

  const ps = document.getElementById('pen-swatches');
  PEN_COLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (i === 1 ? ' sel' : '');
    d.style.background = c;
    d.addEventListener('click', () => {
      state.penColor = c;
      document.getElementById('pen-color').value = c.length === 7 ? c : '#e23b3b';
      document.querySelectorAll('#pen-swatches .sw').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
    });
    ps.appendChild(d);
  });

  document.getElementById('pen-color').addEventListener('input', e => {
    state.penColor = e.target.value;
    document.querySelectorAll('#pen-swatches .sw').forEach(x => x.classList.remove('sel'));
  });

  document.getElementById('pen-size').addEventListener('input', e => {
    state.penSize = +e.target.value;
    document.getElementById('pen-size-val').textContent = state.penSize;
  });

  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
  document.getElementById('zoom-reset').addEventListener('click', () => {
    state.view.scale = 1;
    updateZoomLabel();
    requestRender();
  });
  document.getElementById('fit').addEventListener('click', fitToContent);

  // 提示框关闭逻辑
  const hintBox = document.getElementById('hint-box');
  const hintCloseBtn = document.getElementById('hint-close-btn');
  if (hintBox && hintCloseBtn) {
    if (localStorage.getItem('wb-hint-dismissed') === '1') {
      hintBox.style.display = 'none';
    }
    hintCloseBtn.addEventListener('click', () => {
      hintBox.style.display = 'none';
      try { localStorage.setItem('wb-hint-dismissed', '1'); } catch (e) {}
    });
  }
}

export function selectTool(t) {
  state.tool = t;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  document.getElementById('ctx-note').classList.toggle('hidden', t !== 'note');
  document.getElementById('ctx-pen').classList.toggle('hidden', t !== 'pen');
  document.getElementById('stage').className = 'stage tool-' + t;
  if (t !== 'connect') state.connectFrom = null;
}

export function updateZoomLabel() {
  document.getElementById('zoom-reset').textContent = Math.round(state.view.scale * 100) + '%';
}

export function zoomBy(f) {
  const cx = state.W / 2, cy = state.H / 2;
  const before = screenToWorld(cx, cy, state.view);
  state.view.scale = clamp(state.view.scale * f, 0.15, 6);
  state.view.x = cx - before.x * state.view.scale;
  state.view.y = cy - before.y * state.view.scale;
  updateZoomLabel();
  requestRender();
}

function fitToContent() {
  const b = contentBounds();
  const cw = b.maxX - b.minX, ch = b.maxY - b.minY;
  const s = clamp(Math.min(state.W / cw, state.H / ch) * 0.85, 0.15, 2);
  state.view.scale = s;
  state.view.x = state.W / 2 - (b.minX + b.maxX) / 2 * s;
  state.view.y = state.H / 2 - (b.minY + b.maxY) / 2 * s;
  updateZoomLabel();
  requestRender();
}
