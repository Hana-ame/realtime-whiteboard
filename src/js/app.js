/**
 * Main application entry point
 * @module app
 */

import { state, NOTE_COLORS, persist, setDeps } from './state.js';
import { initRenderer, resize, requestRender } from './renderer.js';
import { initInteraction, NOTE_W, NOTE_H } from './interaction.js';
import { initEditor } from './editor.js';
import { initNetwork, updatePresence, broadcast } from './network.js';
import { initToolbar, updateZoomLabel } from './toolbar.js';

setDeps(broadcast, requestRender);

function load() {
  try {
    const raw = localStorage.getItem('wb-elements-v1');
    if (raw) {
      state.elements = JSON.parse(raw) || {};
    }
  } catch (e) {}

  if (Object.keys(state.elements).length === 0) {
    const cx = -(NOTE_W / 2), cy = -(NOTE_H / 2);
    state.elements['demo1'] = {
      id: 'demo1', type: 'note', x: cx - 200, y: cy - 40, w: NOTE_W, h: NOTE_H,
      text: '双击我编辑\n右键删除', color: NOTE_COLORS[0], rev: 1
    };
    state.elements['demo2'] = {
      id: 'demo2', type: 'note', x: cx + 120, y: cy + 60, w: NOTE_W, h: NOTE_H,
      text: '拖我移动\n用连线连起来', color: NOTE_COLORS[3], rev: 1
    };
    state.elements['demoC'] = {
      id: 'demoC', type: 'connection', from: 'demo1', to: 'demo2', rev: 1
    };
    persist();
  }
  
  initRenderer();
  initInteraction();
  initEditor();
  initToolbar();
  initNetwork();

  window.addEventListener('resize', resize);
  
  resize();
  updateZoomLabel();
  updatePresence();
  requestRender();
}

load();
