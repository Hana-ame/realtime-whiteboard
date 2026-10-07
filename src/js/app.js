/**
 * Main application entry point
 * @module app
 */

import { state, NOTE_COLORS, persist, setDeps, setPersistKey, persistKey } from './state.js';
import { initRenderer, resize, requestRender, clearImageCache } from './renderer.js';
import { initInteraction, NOTE_W, NOTE_H } from './interaction.js';
import { initEditor } from './editor.js';
import { initNetwork, updatePresence, broadcast } from './network.js';
import { initToolbar, updateZoomLabel, updateDeleteBtn, fitToContent } from './toolbar.js';

setDeps(broadcast, requestRender, clearImageCache, updateDeleteBtn);

function load() {
  // 先定房间再定缓存 key。进别人的房间时绝不能去读本地旧内容，否则会把
  // 上一个房间的画布当成这个房间的内容显示出来。
  const hashRoom = (window.location.hash.replace(/^#/, '').match(/(?:room=)?([\w.-]+)/) || [])[1] || '';
  let storedId = '';
  try { storedId = localStorage.getItem('wb-peer-id') || ''; } catch (e) {}
  setPersistKey('wb-elements-v2:' + (hashRoom || storedId || 'default'));

  let raw = null;
  try { raw = localStorage.getItem(persistKey); } catch (e) {}

  // 一次性迁移旧版固定 key（'wb-elements-v1'，所有房间共用）→ 搬进自己的房间。
  // 只在"不是进别人房间"时做，避免把私有内容带进公共房间。
  if (!raw && !hashRoom) {
    try { raw = localStorage.getItem('wb-elements-v1'); } catch (e) {}
    if (raw) {
      try { localStorage.setItem(persistKey, raw); localStorage.removeItem('wb-elements-v1'); } catch (e) {}
    }
  }
  if (raw) {
    try { state.elements = JSON.parse(raw) || {}; } catch (e) {}
  }

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
  // 如果有已有内容，自动适应视图
  if (Object.keys(state.elements).length > 0) {
    fitToContent();
  }
  requestRender();
}

load();
