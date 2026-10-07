/**
 * Main application entry point
 * @module app
 */

import { state, NOTE_COLORS, persist, setDeps } from './state.js';
import { initRenderer, resize, requestRender, clearImageCache } from './renderer.js';
import { initInteraction, NOTE_W, NOTE_H } from './interaction.js';
import { initEditor } from './editor.js';
import { initNetwork, updatePresence, broadcast } from './network.js';
import { initToolbar, updateZoomLabel } from './toolbar.js';

setDeps(broadcast, requestRender, clearImageCache);

function load() {
  try {
    const raw = localStorage.getItem('wb-elements-v1');
    if (raw) {
      state.elements = JSON.parse(raw) || {};
    }
  } catch (e) {}

  // 仅在本地存储中读取已有白板数据，默认保持干净空白画布
  persist();
  
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
