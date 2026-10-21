/**
 * Main application entry point
 * @module app
 */

import { state, persist, setDeps, setPersistKey, persistKey } from './state.js';
import { initRenderer, resize, requestRender, clearImageCache } from './renderer.js';
import { initInteraction } from './interaction.js';
import { initEditor } from './editor.js';
import { initNetwork, updatePresence, broadcast } from './network.js';
import { initToolbar, updateZoomLabel, updateDeleteBtn, fitToContent } from './toolbar.js';

setDeps(broadcast, requestRender, clearImageCache, updateDeleteBtn);

function bootstrapStorage() {
  const hashRoom = (window.location.hash.replace(/^#/, '').match(/(?:room=)?([\w.-]+)/) || [])[1] || '';
  let storedId = '';
  try { storedId = localStorage.getItem('wb-peer-id') || ''; } catch (e) {}

  const ownRoom = !hashRoom || hashRoom === storedId;
  state.persistable = ownRoom;

  if (ownRoom) {
    setPersistKey('wb-elements-v2:' + (storedId || 'default'));
    let raw = null;
    try { raw = localStorage.getItem(persistKey); } catch (e) {}

    let migrated = false;
    if (!raw) {
      try { raw = localStorage.getItem('wb-elements-v1'); } catch (e) {}
      if (raw) {
        try {
          localStorage.setItem(persistKey, raw);
          localStorage.removeItem('wb-elements-v1');
          migrated = true;
        } catch (e) {}
      }
    }
    if (raw) {
      try { state.elements = JSON.parse(raw) || {}; } catch (e) {}
    }
    if (migrated || !raw) persist();
  } else {
    setPersistKey('wb-elements-v2:' + hashRoom);
  }
}

function load() {
  bootstrapStorage();

  initRenderer();
  initInteraction();
  initEditor();
  initToolbar();
  initNetwork();

  window.addEventListener('resize', resize);

  resize();
  updateZoomLabel();
  updatePresence();

  if (Object.keys(state.elements).length > 0) {
    fitToContent();
  }
  requestRender();
}

load();
