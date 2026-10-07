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

  // 自己的房间 = 没有 room= 的 hash，或 hash 就是自己的 PeerJS id（storedId 是
  // 上次会话自己存的 id）。别人的房间（URL room=xxx）：画布完全在内存处理，不读
  // 也不写 localStorage——persistable=false 让 persist() 自动失效，fullSync/upsert
  // 收到的别人的元素绝不落盘，否则下次自己打开看到的是别人的画布。
  const ownRoom = !hashRoom || hashRoom === storedId;
  state.persistable = ownRoom;

  if (ownRoom) {
    setPersistKey('wb-elements-v2:' + (storedId || 'default'));
    let raw = null;
    try { raw = localStorage.getItem(persistKey); } catch (e) {}

    // 一次性迁移旧版固定 key（'wb-elements-v1'，所有房间共用）→ 搬进自己的房间。
    // 只在"不是进别人房间"时做，避免把私有内容带进公共房间。
    let migrated = false;
    if (!raw) {
      try { raw = localStorage.getItem('wb-elements-v1'); } catch (e) {}
      if (raw) {
        try { localStorage.setItem(persistKey, raw); localStorage.removeItem('wb-elements-v1'); migrated = true; } catch (e) {}
      }
    }
    if (raw) {
      try { state.elements = JSON.parse(raw) || {}; } catch (e) {}
    }
    // 首屏不再无条件回写：刚从 localStorage 读出的大 JSON（含多张 base64 图片）又
    // JSON.stringify 一次写回，是首屏卡顿的根因之一。只在 v1→v2 迁移后、或本地
    // 本来没有任何内容（把空画布写一次占位）时才落盘；已有内容不立刻回写。
    if (migrated || !raw) persist();
  } else {
    // 别人的房间：把 key 对齐到 URL 房间（信息性，persistable=false 不会落盘），
    // 不读该 key 的本地旧内容——即便是旧方案残留的，也不是"我"的画布，等网络
    // fullSync 填充。
    setPersistKey('wb-elements-v2:' + hashRoom);
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
  // 如果有已有内容，自动适应视图
  if (Object.keys(state.elements).length > 0) {
    fitToContent();
  }
  requestRender();
}

load();
