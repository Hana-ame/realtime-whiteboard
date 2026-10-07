/**
 * Toolbar UI and controls
 * @module toolbar
 */

import { state, NOTE_COLORS, PEN_COLORS, pushUndo, upsert, removeEl } from './state.js';
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

  // Note font size (per-note, log scale 10→960)
  const FS_MIN = 10, FS_MAX = 960, FS_LOG = Math.log(FS_MAX / FS_MIN);
  const fsSlider = document.getElementById('note-font-size');
  const fsVal = document.getElementById('note-font-size-val');
  const fsToSlider = (fs) => Math.round(100 * Math.log(Math.max(FS_MIN, fs) / FS_MIN) / FS_LOG);
  const sliderToFs = (v) => Math.round(FS_MIN * Math.pow(FS_MAX / FS_MIN, v / 100));
  fsSlider.value = fsToSlider(state.noteFontSize);
  fsVal.textContent = state.noteFontSize;
  fsSlider.addEventListener('input', e => {
    const size = sliderToFs(+e.target.value);
    state.noteFontSize = size;
    fsVal.textContent = size;
    if (state.selectedId && state.elements[state.selectedId] && state.elements[state.selectedId].type === 'note') {
      pushUndo();
      state.elements[state.selectedId].fontSize = size;
      upsert(state.elements[state.selectedId]);
    }
    requestRender();
  });

  // Note background opacity slider (0-100%)
  const bgOpSlider = document.getElementById('note-bg-opacity');
  const bgOpVal = document.getElementById('note-bg-opacity-val');
  bgOpSlider.addEventListener('input', e => {
    state.noteBgOpacity = +e.target.value;
    bgOpVal.textContent = state.noteBgOpacity;
    if (state.selectedId && state.elements[state.selectedId] && state.elements[state.selectedId].type === 'note') {
      pushUndo();
      state.elements[state.selectedId].bgOpacity = state.noteBgOpacity;
      upsert(state.elements[state.selectedId]);
    }
    requestRender();
  });

  // Note text opacity slider (0-100%)
  const textOpSlider = document.getElementById('note-text-opacity');
  const textOpVal = document.getElementById('note-text-opacity-val');
  textOpSlider.addEventListener('input', e => {
    state.noteTextOpacity = +e.target.value;
    textOpVal.textContent = state.noteTextOpacity;
    if (state.selectedId && state.elements[state.selectedId] && state.elements[state.selectedId].type === 'note') {
      pushUndo();
      state.elements[state.selectedId].textOpacity = state.noteTextOpacity;
      upsert(state.elements[state.selectedId]);
    }
    requestRender();
  });

  // Connection color swatches
  const CONN_COLORS = ['#9aa0b4','#e23b3b','#1f8a4c','#2b6fe2','#f59e0b','#8b3bd6','#1c1f2b'];
  const cs = document.getElementById('conn-swatches');
  CONN_COLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (i === 0 ? ' sel' : '');
    d.style.background = c;
    d.addEventListener('click', () => {
      state.connColor = c;
      document.getElementById('conn-color').value = c;
      document.querySelectorAll('#conn-swatches .sw').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
    });
    cs.appendChild(d);
  });
  document.getElementById('conn-color').addEventListener('input', e => {
    state.connColor = e.target.value;
    document.querySelectorAll('#conn-swatches .sw').forEach(x => x.classList.remove('sel'));
  });

  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.2));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(1 / 1.2));
  document.getElementById('zoom-reset').addEventListener('click', () => {
    state.view.scale = 1;
    state.view.x = state.W / 2;
    state.view.y = state.H / 2;
    updateZoomLabel();
    requestRender();
    toast('已重置视图至中心 100%');
  });
  document.getElementById('fit').addEventListener('click', fitToContent);

  // Delete button (for mobile where right-click/keyboard are unavailable)
  document.getElementById('delete-btn').addEventListener('click', () => {
    if (state.selectedId) {
      pushUndo();
      removeEl(state.selectedId);
    } else {
      toast('请先选择一个元素');
    }
  });

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
  document.getElementById('ctx-connect').classList.toggle('hidden', t !== 'connect');
  const bar = document.getElementById('ctx-bar');
  if (bar) bar.classList.toggle('empty', t !== 'note' && t !== 'pen' && t !== 'connect' && !state.selectedId);
  const stage = document.getElementById('stage');
  stage.classList.remove('tool-select', 'tool-note', 'tool-pen', 'tool-connect', 'tool-pan');
  stage.classList.add('tool-' + t);
  if (t !== 'connect') state.connectFrom = null;
  requestRender();
}

export function updateDeleteBtn() {
  const btn = document.getElementById('delete-btn');
  if (btn) btn.style.display = state.selectedId ? '' : 'none';
  // Sync font size slider with selected note (log scale)
  const el = state.selectedId ? state.elements[state.selectedId] : null;
  if (el && el.type === 'note') {
    const fs = el.fontSize || 16;
    state.noteFontSize = fs;
    const FS_MIN = 10, FS_MAX = 960, FS_LOG = Math.log(FS_MAX / FS_MIN);
    document.getElementById('note-font-size').value = Math.round(100 * Math.log(Math.max(FS_MIN, fs) / FS_MIN) / FS_LOG);
    document.getElementById('note-font-size-val').textContent = fs;
    const bgOp = el.bgOpacity ?? 88;
    state.noteBgOpacity = bgOp;
    document.getElementById('note-bg-opacity').value = bgOp;
    document.getElementById('note-bg-opacity-val').textContent = bgOp;
    const textOp = el.textOpacity ?? 72;
    state.noteTextOpacity = textOp;
    document.getElementById('note-text-opacity').value = textOp;
    document.getElementById('note-text-opacity-val').textContent = textOp;
  }
  // Toggle empty state on ctx-bar
  const bar = document.getElementById('ctx-bar');
  if (bar) {
    const toolActive = state.tool === 'note' || state.tool === 'pen' || state.tool === 'connect';
    bar.classList.toggle('empty', !toolActive && !state.selectedId);
  }
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

export function fitToContent() {
  const b = contentBounds();
  const cw = b.maxX - b.minX, ch = b.maxY - b.minY;
  const s = clamp(Math.min(state.W / cw, state.H / ch) * 0.85, 0.15, 2);
  state.view.scale = s;
  state.view.x = state.W / 2 - (b.minX + b.maxX) / 2 * s;
  state.view.y = state.H / 2 - (b.minY + b.maxY) / 2 * s;
  updateZoomLabel();
  requestRender();
}
