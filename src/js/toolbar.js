/**
 * Toolbar UI, context-aware property bar, and viewport controls
 * @module toolbar
 */

import {
  state, NOTE_COLORS, PEN_COLORS, CONN_COLORS,
  pushUndo, upsert, removeEl, undo, redo, duplicateSelected, undoStack, redoStack,
} from './state.js';
import { requestRender } from './renderer.js';
import { clamp, screenToWorld, toast } from './utils.js';
import { contentBounds } from './geometry.js';
import { insertImageFile } from './interaction.js';
import { bus, EVENTS } from './events.js';

const FS_MIN = 10, FS_MAX = 960, FS_LOG = Math.log(FS_MAX / FS_MIN);
const fsToSlider = fs => Math.round(100 * Math.log(Math.max(FS_MIN, fs) / FS_MIN) / FS_LOG);
const sliderToFs = v => Math.round(FS_MIN * Math.pow(FS_MAX / FS_MIN, v / 100));

export function initToolbar() {
  document.getElementById('tools').addEventListener('click', e => {
    const b = e.target.closest('.tool');
    if (!b || !b.dataset.tool) return;
    selectTool(b.dataset.tool);
  });

  // Note color swatches
  const ns = document.getElementById('note-swatches');
  ns.innerHTML = '';
  NOTE_COLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (i === 0 ? ' sel' : '');
    d.dataset.color = c;
    d.style.background = c;
    d.addEventListener('click', () => {
      state.noteColor = c;
      document.querySelectorAll('#note-swatches .sw').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      const sel = state.selectedId && state.elements[state.selectedId];
      if (sel && sel.type === 'note') {
        pushUndo();
        sel.color = c;
        upsert(sel);
      }
    });
    ns.appendChild(d);
  });

  // Pen color swatches & custom color picker (also applies to selected stroke!)
  const ps = document.getElementById('pen-swatches');
  ps.innerHTML = '';
  PEN_COLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (i === 1 ? ' sel' : '');
    d.dataset.color = c;
    d.style.background = c;
    d.addEventListener('click', () => {
      state.penColor = c;
      document.getElementById('pen-color').value = c.length === 7 ? c : '#e23b3b';
      document.querySelectorAll('#pen-swatches .sw').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      const sel = state.selectedId && state.elements[state.selectedId];
      if (sel && sel.type === 'stroke') {
        pushUndo();
        sel.color = c;
        upsert(sel);
      }
    });
    ps.appendChild(d);
  });

  document.getElementById('pen-color').addEventListener('input', e => {
    state.penColor = e.target.value;
    document.querySelectorAll('#pen-swatches .sw').forEach(x => x.classList.remove('sel'));
    const sel = state.selectedId && state.elements[state.selectedId];
    if (sel && sel.type === 'stroke') {
      sel.color = state.penColor;
      upsert(sel);
    }
  });

  document.getElementById('pen-size').addEventListener('input', e => {
    state.penSize = +e.target.value;
    document.getElementById('pen-size-val').textContent = state.penSize;
    const sel = state.selectedId && state.elements[state.selectedId];
    if (sel && sel.type === 'stroke') {
      sel.width = state.penSize;
      upsert(sel);
    }
  });

  // Note font size slider (log scale 10 -> 960)
  const fsSlider = document.getElementById('note-font-size');
  const fsVal = document.getElementById('note-font-size-val');
  fsSlider.value = fsToSlider(state.noteFontSize);
  fsVal.textContent = state.noteFontSize;
  fsSlider.addEventListener('input', e => {
    const size = sliderToFs(+e.target.value);
    state.noteFontSize = size;
    fsVal.textContent = size;
    const sel = state.selectedId && state.elements[state.selectedId];
    if (sel && sel.type === 'note') {
      sel.fontSize = size;
      upsert(sel);
    }
    requestRender();
  });

  // Note background opacity slider (0-100%)
  const bgOpSlider = document.getElementById('note-bg-opacity');
  const bgOpVal = document.getElementById('note-bg-opacity-val');
  bgOpSlider.addEventListener('input', e => {
    state.noteBgOpacity = +e.target.value;
    bgOpVal.textContent = state.noteBgOpacity;
    const sel = state.selectedId && state.elements[state.selectedId];
    if (sel && sel.type === 'note') {
      sel.bgOpacity = state.noteBgOpacity;
      upsert(sel);
    }
    requestRender();
  });

  // Note text opacity slider (0-100%)
  const textOpSlider = document.getElementById('note-text-opacity');
  const textOpVal = document.getElementById('note-text-opacity-val');
  textOpSlider.addEventListener('input', e => {
    state.noteTextOpacity = +e.target.value;
    textOpVal.textContent = state.noteTextOpacity;
    const sel = state.selectedId && state.elements[state.selectedId];
    if (sel && sel.type === 'note') {
      sel.textOpacity = state.noteTextOpacity;
      upsert(sel);
    }
    requestRender();
  });

  // Connection color swatches (also applies to selected connection!)
  const cs = document.getElementById('conn-swatches');
  cs.innerHTML = '';
  CONN_COLORS.forEach((c, i) => {
    const d = document.createElement('div');
    d.className = 'sw' + (i === 0 ? ' sel' : '');
    d.dataset.color = c;
    d.style.background = c;
    d.addEventListener('click', () => {
      state.connColor = c;
      document.getElementById('conn-color').value = c;
      document.querySelectorAll('#conn-swatches .sw').forEach(x => x.classList.remove('sel'));
      d.classList.add('sel');
      const sel = state.selectedId && state.elements[state.selectedId];
      if (sel && sel.type === 'connection') {
        pushUndo();
        sel.color = c;
        upsert(sel);
      }
    });
    cs.appendChild(d);
  });
  document.getElementById('conn-color').addEventListener('input', e => {
    state.connColor = e.target.value;
    document.querySelectorAll('#conn-swatches .sw').forEach(x => x.classList.remove('sel'));
    const sel = state.selectedId && state.elements[state.selectedId];
    if (sel && sel.type === 'connection') {
      sel.color = state.connColor;
      upsert(sel);
    }
  });

  // Viewport zoom controls
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

  // Undo / Redo toolbar buttons
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.addEventListener('click', () => undo());
  if (redoBtn) redoBtn.addEventListener('click', () => redo());

  // Duplicate button
  const dupBtn = document.getElementById('dup-btn');
  if (dupBtn) {
    dupBtn.addEventListener('click', () => duplicateSelected());
  }

  // Delete button
  document.getElementById('delete-btn').addEventListener('click', () => {
    if (state.selectedId) {
      pushUndo();
      removeEl(state.selectedId);
    } else {
      toast('请先选择一个元素');
    }
  });

  // Image upload button
  const uploadBtn = document.getElementById('upload-img-btn');
  const fileInput = document.getElementById('image-upload');
  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) insertImageFile(file);
    fileInput.value = '';
  });

  // Dismissible hint box
  const hintBox = document.getElementById('hint-box');
  const hintCloseBtn = document.getElementById('hint-close-btn');
  if (hintBox && hintCloseBtn) {
    try {
      if (localStorage.getItem('wb-hint-dismissed') === '1') {
        hintBox.style.display = 'none';
      }
    } catch (e) {}
    hintCloseBtn.addEventListener('click', () => {
      hintBox.style.display = 'none';
      try { localStorage.setItem('wb-hint-dismissed', '1'); } catch (e) {}
    });
  }

  bus.off(EVENTS.SELECTION_CHANGED, updateDeleteBtn);
  bus.on(EVENTS.SELECTION_CHANGED, updateDeleteBtn);
  bus.off(EVENTS.HISTORY_CHANGED, updateHistoryBtns);
  bus.on(EVENTS.HISTORY_CHANGED, updateHistoryBtns);
  updateHistoryBtns();
  updateDeleteBtn();
}

export function updateHistoryBtns() {
  const undoBtn = document.getElementById('undo-btn');
  const redoBtn = document.getElementById('redo-btn');
  if (undoBtn) undoBtn.disabled = undoStack.length === 0;
  if (redoBtn) redoBtn.disabled = redoStack.length === 0;
}

/**
 * Synchronize context property bar visibility with both the active tool AND
 * the currently selected element type so users can inspect/edit properties
 * directly when clicking an element with the Select tool.
 */
function syncContextBar() {
  const t = state.tool;
  const sel = state.selectedId ? state.elements[state.selectedId] : null;
  const showNote = t === 'note' || (sel && sel.type === 'note');
  const showPen = t === 'pen' || (sel && sel.type === 'stroke');
  const showConn = t === 'connect' || (sel && sel.type === 'connection');

  const ctxNote = document.getElementById('ctx-note');
  const ctxPen = document.getElementById('ctx-pen');
  const ctxConn = document.getElementById('ctx-connect');
  if (ctxNote) ctxNote.classList.toggle('hidden', !showNote);
  if (ctxPen) ctxPen.classList.toggle('hidden', !showPen);
  if (ctxConn) ctxConn.classList.toggle('hidden', !showConn);

  const bar = document.getElementById('ctx-bar');
  if (bar) {
    bar.classList.toggle('empty', !showNote && !showPen && !showConn && !state.selectedId);
  }
}

export function selectTool(t) {
  state.tool = t;
  document.querySelectorAll('.tool[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
  syncContextBar();
  const stage = document.getElementById('stage');
  if (stage) {
    stage.classList.remove('tool-select', 'tool-note', 'tool-pen', 'tool-connect', 'tool-pan');
    stage.classList.add('tool-' + t);
  }
  if (t !== 'connect') state.connectFrom = null;
  bus.emit(EVENTS.TOOL_CHANGED, t);
  requestRender();
}

export function updateDeleteBtn() {
  const delBtn = document.getElementById('delete-btn');
  const dupBtn = document.getElementById('dup-btn');
  const el = state.selectedId ? state.elements[state.selectedId] : null;
  if (delBtn) delBtn.style.display = el ? '' : 'none';
  if (dupBtn) dupBtn.style.display = (el && el.type !== 'connection') ? '' : 'none';

  if (el && el.type === 'note') {
    const fs = el.fontSize || 16;
    state.noteFontSize = fs;
    document.getElementById('note-font-size').value = fsToSlider(fs);
    document.getElementById('note-font-size-val').textContent = fs;
    const bgOp = el.bgOpacity ?? 88;
    state.noteBgOpacity = bgOp;
    document.getElementById('note-bg-opacity').value = bgOp;
    document.getElementById('note-bg-opacity-val').textContent = bgOp;
    const textOp = el.textOpacity ?? 72;
    state.noteTextOpacity = textOp;
    document.getElementById('note-text-opacity').value = textOp;
    document.getElementById('note-text-opacity-val').textContent = textOp;
    document.querySelectorAll('#note-swatches .sw').forEach(sw => {
      sw.classList.toggle('sel', sw.dataset.color === el.color);
    });
  } else if (el && el.type === 'stroke') {
    state.penColor = el.color || state.penColor;
    state.penSize = el.width || state.penSize;
    document.getElementById('pen-size').value = state.penSize;
    document.getElementById('pen-size-val').textContent = state.penSize;
    if (state.penColor.length === 7) document.getElementById('pen-color').value = state.penColor;
    document.querySelectorAll('#pen-swatches .sw').forEach(sw => {
      sw.classList.toggle('sel', sw.dataset.color === state.penColor);
    });
  } else if (el && el.type === 'connection') {
    state.connColor = el.color || state.connColor;
    if (state.connColor.length === 7) document.getElementById('conn-color').value = state.connColor;
    document.querySelectorAll('#conn-swatches .sw').forEach(sw => {
      sw.classList.toggle('sel', sw.dataset.color === state.connColor);
    });
  }

  syncContextBar();
}

export function updateZoomLabel() {
  const z = document.getElementById('zoom-reset');
  if (z) z.textContent = Math.round(state.view.scale * 100) + '%';
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
  const cw = Math.max(1, b.maxX - b.minX), ch = Math.max(1, b.maxY - b.minY);
  const s = clamp(Math.min(state.W / cw, state.H / ch) * 0.85, 0.15, 2);
  state.view.scale = s;
  state.view.x = state.W / 2 - (b.minX + b.maxX) / 2 * s;
  state.view.y = state.H / 2 - (b.minY + b.maxY) / 2 * s;
  updateZoomLabel();
  requestRender();
}
