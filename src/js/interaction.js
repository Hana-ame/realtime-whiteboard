/**
 * Pointer, touch, and keyboard interaction handlers
 * @module interaction
 */

import {
  state, pushUndo, removeEl, upsert, bringToFront,
  undo, redo, undoStack, duplicateSelected,
} from './state.js';
import { screenToWorld, uid, clamp, toast, roundCoord } from './utils.js';
import { requestRender } from './renderer.js';
import { openEditor, closeEditor, positionEditor } from './editor.js';
import { broadcastCursor, broadcastThrottled, clearThrottled } from './network.js';
import { selectTool, updateZoomLabel, updateDeleteBtn } from './toolbar.js';
import {
  NOTE_W, NOTE_H, ROTATE_OFFSET,
  elCenter, rotatePointAround, hitNote, distToSeg, distToStroke,
  noteCenter, rectEdgePoint, connEndpoints, pick,
  noteHandles, hitHandle, hitRotateHandle, contentBounds,
  simplifyStrokePoints,
} from './geometry.js';

// Re-export geometry functions for backward compatibility (e.g. rotate.test.mjs)
export {
  NOTE_W, NOTE_H, ROTATE_OFFSET,
  elCenter, rotatePointAround, hitNote, distToSeg, distToStroke,
  noteCenter, rectEdgePoint, connEndpoints, pick,
  noteHandles, hitHandle, hitRotateHandle, contentBounds,
};

function getPos(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/**
 * Check if a connection between `fromId` and `toId` already exists
 */
function hasConnectionBetween(fromId, toId) {
  for (const id in state.elements) {
    const el = state.elements[id];
    if (el && el.type === 'connection' && el.from === fromId && el.to === toId) {
      return true;
    }
  }
  return false;
}

/**
 * Create a connection between two connectable elements if valid and non-duplicate
 */
function createConnectionIfValid(fromId, toId) {
  if (!fromId || !toId || fromId === toId) return false;
  if (hasConnectionBetween(fromId, toId)) {
    toast('已存在相同连线');
    return false;
  }
  pushUndo();
  const c = {
    id: uid(),
    type: 'connection',
    from: fromId,
    to: toId,
    color: state.connColor,
    rev: 0,
  };
  upsert(c);
  state.selectedId = c.id;
  updateDeleteBtn();
  return true;
}

/**
 * Insert an image file onto the board, scaling static images to max 1200px
 * while preserving animated GIF byte streams intact.
 */
export function insertImageFile(file) {
  const reader = new FileReader();
  reader.onload = evt => {
    const rawDataUrl = evt.target.result;
    const img = new Image();
    img.onload = () => {
      const isGif = rawDataUrl.startsWith('data:image/gif');
      let dataUrl = rawDataUrl;
      let targetW = img.naturalWidth;
      let targetH = img.naturalHeight;

      if (!isGif) {
        const maxDim = 1200;
        if (targetW > maxDim || targetH > maxDim) {
          const ratio = Math.min(maxDim / targetW, maxDim / targetH);
          targetW = Math.round(targetW * ratio);
          targetH = Math.round(targetH * ratio);
        }
        const offCanvas = document.createElement('canvas');
        offCanvas.width = targetW;
        offCanvas.height = targetH;
        const offCtx = offCanvas.getContext('2d');
        offCtx.drawImage(img, 0, 0, targetW, targetH);
        dataUrl = offCanvas.toDataURL('image/png');
      }

      const displayMax = 320;
      let dw = targetW, dh = targetH;
      if (dw > displayMax || dh > displayMax) {
        const dRatio = Math.min(displayMax / dw, displayMax / dh);
        dw = Math.round(dw * dRatio);
        dh = Math.round(dh * dRatio);
      }

      const center = screenToWorld(state.W / 2, state.H / 2, state.view);
      const hasMoved = state.pointerWorld.x !== 0 || state.pointerWorld.y !== 0;
      const px = hasMoved ? state.pointerWorld.x : center.x;
      const py = hasMoved ? state.pointerWorld.y : center.y;
      const posX = Math.round(px - dw / 2);
      const posY = Math.round(py - dh / 2);

      pushUndo();
      const imageEl = {
        id: uid(),
        type: 'image',
        x: posX,
        y: posY,
        w: dw,
        h: dh,
        dataUrl,
        rotation: 0,
        rev: 0,
      };
      upsert(imageEl, true);
      state.selectedId = imageEl.id;
      updateDeleteBtn();
      selectTool('select');
      toast('已插入' + (isGif ? '动图' : '图片'));
    };
    img.src = rawDataUrl;
  };
  reader.readAsDataURL(file);
}

export function initInteraction() {
  const canvas = document.getElementById('board');
  const stage = document.getElementById('stage');
  const mm = document.getElementById('mm');

  canvas.addEventListener('pointerdown', e => {
    if (state.editingId != null) closeEditor(true);
    canvas.setPointerCapture(e.pointerId);
    const sp = getPos(e, canvas);
    const wp = screenToWorld(sp.x, sp.y, state.view);
    state.pointerWorld = wp;
    const panMode = state.tool === 'pan' || state.spaceDown || e.button === 1;

    if (panMode) {
      state.drag = { mode: 'pan', sx: sp.x, sy: sp.y, vx: state.view.x, vy: state.view.y, pointerId: e.pointerId };
      stage.classList.add('panning');
      return;
    }
    if (e.button === 2) return;

    // 1. Rotation handle check on currently selected note/image
    if (state.selectedId && state.elements[state.selectedId]) {
      const sel = state.elements[state.selectedId];
      if ((sel.type === 'note' || sel.type === 'image') && hitRotateHandle(sel, sp)) {
        const c = elCenter(sel);
        pushUndo();
        state.drag = {
          mode: 'rotate',
          id: sel.id,
          center: c,
          startAngle: Math.atan2(wp.y - c.y, wp.x - c.x),
          origRotation: sel.rotation || 0,
          moved: false,
          pointerId: e.pointerId,
        };
        requestRender();
        return;
      }
    }

    // 2. Resize handle check on currently selected note/image
    if (state.selectedId && state.elements[state.selectedId]) {
      const sel = state.elements[state.selectedId];
      if (sel.type === 'note' || sel.type === 'image') {
        const hk = hitHandle(sel, sp);
        if (hk) {
          pushUndo();
          state.drag = {
            mode: 'resize',
            id: sel.id,
            hk,
            origX: sel.x,
            origY: sel.y,
            origW: sel.w,
            origH: sel.h,
            rotation: sel.rotation || 0,
            startWp: { x: wp.x, y: wp.y },
            moved: false,
            pointerId: e.pointerId,
          };
          requestRender();
          return;
        }
      }
    }

    // 3. Tool-specific creation / interaction modes
    if (state.tool === 'pen') {
      pushUndo();
      const s = {
        id: uid(),
        type: 'stroke',
        points: [{ x: roundCoord(wp.x), y: roundCoord(wp.y) }],
        color: state.penColor,
        width: state.penSize,
        rev: 0,
      };
      state.elements[s.id] = s;
      state.drag = { mode: 'draw', id: s.id, pointerId: e.pointerId };
      upsert(s, true);
      return;
    }

    if (state.tool === 'connect') {
      const hit = pick(wp);
      const isConnectable = hit && (hit.type === 'note' || hit.type === 'image');
      if (state.connectFrom && isConnectable && hit.id !== state.connectFrom) {
        // Complete two-click connection immediately
        createConnectionIfValid(state.connectFrom, hit.id);
        state.connectFrom = null;
        state.drag = null;
        requestRender();
        return;
      }
      if (isConnectable) {
        state.connectFrom = hit.id;
        state.drag = { mode: 'connect', fromId: hit.id, moved: false, pointerId: e.pointerId };
      } else {
        state.connectFrom = null;
        state.drag = { mode: 'pan', sx: sp.x, sy: sp.y, vx: state.view.x, vy: state.view.y, pointerId: e.pointerId };
      }
      requestRender();
      return;
    }

    if (state.tool === 'note') {
      const hit = pick(wp);
      if (hit && hit.type === 'note') {
        state.selectedId = hit.id;
        bringToFront(hit.id);
        updateDeleteBtn();
        selectTool('select');
        pushUndo();
        state.drag = { mode: 'move', id: hit.id, dx: wp.x - hit.x, dy: wp.y - hit.y, moved: false, pointerId: e.pointerId };
        requestRender();
      } else {
        pushUndo();
        const n = {
          id: uid(),
          type: 'note',
          x: Math.round(wp.x - NOTE_W / 2),
          y: Math.round(wp.y - NOTE_H / 2),
          w: NOTE_W,
          h: NOTE_H,
          text: '',
          color: state.noteColor,
          fontSize: state.noteFontSize,
          bgOpacity: state.noteBgOpacity,
          textOpacity: state.noteTextOpacity,
          rotation: 0,
          rev: 0,
        };
        upsert(n);
        state.selectedId = n.id;
        updateDeleteBtn();
        selectTool('select');
        openEditor(n);
      }
      return;
    }

    // 4. Default select / move / pan behavior
    const hit = pick(wp);
    if (!hit) {
      state.selectedId = null;
      updateDeleteBtn();
      state.drag = { mode: 'pan', sx: sp.x, sy: sp.y, vx: state.view.x, vy: state.view.y, pointerId: e.pointerId };
      requestRender();
      return;
    }

    state.selectedId = hit.id;
    bringToFront(hit.id);
    updateDeleteBtn();
    if (hit.type === 'note' || hit.type === 'image') {
      pushUndo();
      state.drag = { mode: 'move', id: hit.id, dx: wp.x - hit.x, dy: wp.y - hit.y, moved: false, pointerId: e.pointerId };
    } else if (hit.type === 'stroke') {
      pushUndo();
      state.drag = {
        mode: 'move-el',
        id: hit.id,
        sx: wp.x,
        sy: wp.y,
        orig: hit.points.map(p => ({ x: p.x, y: p.y })),
        moved: false,
        pointerId: e.pointerId,
      };
    }
    requestRender();
  });

  canvas.addEventListener('pointermove', e => {
    const sp = getPos(e, canvas);
    const wp = screenToWorld(sp.x, sp.y, state.view);
    state.pointerWorld = wp;
    broadcastCursor(wp);

    if (state.tool === 'connect' && state.connectFrom && !state.drag) {
      requestRender();
    }

    if (!state.drag) return;
    if (state.drag.pointerId !== e.pointerId) return;

    if (state.drag.mode === 'pan') {
      state.view.x = state.drag.vx + (sp.x - state.drag.sx);
      state.view.y = state.drag.vy + (sp.y - state.drag.sy);
      if (state.editingId != null) {
        const n = state.elements[state.editingId];
        if (n) positionEditor(n);
      }
      requestRender();
      return;
    }

    if (state.drag.mode === 'move') {
      const n = state.elements[state.drag.id];
      if (!n) return;
      n.x = Math.round(wp.x - state.drag.dx);
      n.y = Math.round(wp.y - state.drag.dy);
      state.drag.moved = true;
      state.elements[n.id] = n;
      broadcastThrottled(n);
      requestRender();
      return;
    }

    if (state.drag.mode === 'move-el') {
      const el = state.elements[state.drag.id];
      if (!el) return;
      if (el.type === 'stroke') {
        const dx = wp.x - state.drag.sx, dy = wp.y - state.drag.sy;
        el.points = state.drag.orig.map(p => ({ x: roundCoord(p.x + dx), y: roundCoord(p.y + dy) }));
        state.drag.moved = true;
        broadcastThrottled(el);
        requestRender();
      }
      return;
    }

    if (state.drag.mode === 'rotate') {
      const n = state.elements[state.drag.id];
      if (!n) return;
      const { center, startAngle, origRotation } = state.drag;
      const ang = Math.atan2(wp.y - center.y, wp.x - center.x);
      let rot = origRotation + (ang - startAngle);
      if (e.shiftKey) {
        const step = Math.PI / 12;
        rot = Math.round(rot / step) * step;
      }
      n.rotation = rot;
      state.drag.moved = true;
      state.drag.angle = rot;
      state.elements[n.id] = n;
      broadcastThrottled(n);
      requestRender();
      return;
    }

    if (state.drag.mode === 'resize') {
      const n = state.elements[state.drag.id];
      if (!n) return;
      const { hk, origX, origY, origW, origH, rotation } = state.drag;
      const sx = hk.includes('e') ? 1 : (hk.includes('w') ? -1 : 0);
      const sy = hk.includes('s') ? 1 : (hk.includes('n') ? -1 : 0);
      const c0 = { x: origX + origW / 2, y: origY + origH / 2 };

      const q = rotatePointAround(wp.x, wp.y, c0.x, c0.y, -rotation);
      const ax = sx === 1 ? origX : (sx === -1 ? origX + origW : c0.x);
      const ay = sy === 1 ? origY : (sy === -1 ? origY + origH : c0.y);

      const nw_min = 40;

      let nw, nh;
      if (sx !== 0 && sy !== 0) {
        const dx = sx * origW, dy = sy * origH;
        const vx = q.x - ax, vy = q.y - ay;
        let t = (vx * dx + vy * dy) / (dx * dx + dy * dy);
        const minT = Math.max(nw_min / origW, nw_min / origH);
        t = Math.max(minT, t);
        nw = origW * t;
        nh = origH * t;
      } else {
        nw = sx !== 0 ? Math.max(nw_min, sx * (q.x - ax)) : origW;
        nh = sy !== 0 ? Math.max(nw_min, sy * (q.y - ay)) : origH;
      }

      const aw = rotatePointAround(ax, ay, c0.x, c0.y, rotation);
      const ox = -sx * nw / 2, oy = -sy * nh / 2;
      const roff = rotatePointAround(ox, oy, 0, 0, rotation);
      const nx = aw.x - roff.x - nw / 2;
      const ny = aw.y - roff.y - nh / 2;

      n.x = Math.round(nx);
      n.y = Math.round(ny);
      n.w = Math.round(nw);
      n.h = Math.round(nh);
      state.drag.moved = true;
      state.elements[n.id] = n;
      broadcastThrottled(n);
      requestRender();
      return;
    }

    if (state.drag.mode === 'draw') {
      const s = state.elements[state.drag.id];
      if (!s) return;
      const last = s.points[s.points.length - 1];
      const minStep = 1.2 / state.view.scale;
      if (!last || Math.hypot(wp.x - last.x, wp.y - last.y) >= minStep) {
        s.points.push({ x: roundCoord(wp.x), y: roundCoord(wp.y) });
        broadcastThrottled(s);
        requestRender();
      }
      return;
    }

    if (state.drag.mode === 'connect') {
      state.drag.moved = true;
      requestRender();
      return;
    }
  });

  canvas.addEventListener('pointerup', e => {
    if (!state.drag) return;
    if (state.drag.pointerId !== e.pointerId) return;
    const mode = state.drag.mode;
    const dragId = state.drag.id;
    const moved = state.drag.moved;

    if (dragId) {
      clearThrottled(dragId);
    }

    if (mode === 'draw') {
      const s = state.elements[dragId];
      if (s) {
        if (s.points.length > 3) {
          s.points = simplifyStrokePoints(s.points, 0.6 / state.view.scale);
        }
        upsert(s);
      }
    } else if (mode === 'move' || mode === 'move-el' || mode === 'resize' || mode === 'rotate') {
      const el = state.elements[dragId];
      if (el && moved) {
        upsert(el);
      } else if (!moved && undoStack.length) {
        undoStack.pop();
      }
    } else if (mode === 'connect') {
      const sp = getPos(e, canvas);
      const wp = screenToWorld(sp.x, sp.y, state.view);
      const hit = pick(wp);
      if (state.connectFrom && hit && (hit.type === 'note' || hit.type === 'image')) {
        if (hit.id !== state.connectFrom) {
          createConnectionIfValid(state.connectFrom, hit.id);
          state.connectFrom = null;
        }
        // If released on the same source element, keep `state.connectFrom` active
        // so the user can click the target element next (two-click connect UX)
      } else {
        state.connectFrom = null;
      }
    }
    state.drag = null;
    stage.classList.remove('panning');
    requestRender();
  });

  canvas.addEventListener('pointercancel', () => {
    if (state.drag) {
      if (state.drag.id) {
        if (state.drag.moved && state.elements[state.drag.id]) {
          upsert(state.elements[state.drag.id]);
        }
        clearThrottled(state.drag.id);
      }
      state.drag = null;
      stage.classList.remove('panning');
      requestRender();
    }
  });

  canvas.addEventListener('dblclick', e => {
    const sp = getPos(e, canvas);
    const wp = screenToWorld(sp.x, sp.y, state.view);
    const hit = pick(wp);
    if (hit && hit.type === 'note') {
      state.selectedId = hit.id;
      bringToFront(hit.id);
      updateDeleteBtn();
      openEditor(hit);
    }
  });

  canvas.addEventListener('contextmenu', e => {
    e.preventDefault();
    const sp = getPos(e, canvas);
    const wp = screenToWorld(sp.x, sp.y, state.view);
    const hit = pick(wp);
    if (hit) {
      pushUndo();
      removeEl(hit.id);
    }
  });

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const sp = getPos(e, canvas);

    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= 40) {
      const before = screenToWorld(sp.x, sp.y, state.view);
      const zoomFactor = Math.exp(-e.deltaY * 0.0025);
      const newScale = clamp(state.view.scale * zoomFactor, 0.15, 6);
      state.view.scale = newScale;
      state.view.x = sp.x - before.x * newScale;
      state.view.y = sp.y - before.y * newScale;
      updateZoomLabel();
    } else {
      state.view.x -= e.deltaX;
      state.view.y -= e.deltaY;
    }
    if (state.editingId != null) {
      const n = state.elements[state.editingId];
      if (n) positionEditor(n);
    }
    requestRender();
  }, { passive: false });

  mm.addEventListener('pointerdown', e => {
    const m = mm._map;
    if (!m) return;
    const r = mm.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const wx = m.b.minX + (mx - m.ox) / m.sc;
    const wy = m.b.minY + (my - m.oy) / m.sc;
    state.view.x = state.W / 2 - wx * state.view.scale;
    state.view.y = state.H / 2 - wy * state.view.scale;
    requestRender();
  });

  window.addEventListener('keydown', e => {
    if (state.editingId != null) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.code === 'Space') {
      state.spaceDown = true;
      stage.classList.add('space');
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      state.connectFrom = null;
      if (state.selectedId) {
        state.selectedId = null;
        updateDeleteBtn();
      } else if (state.tool !== 'select') {
        selectTool('select');
      }
      requestRender();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      if (state.selectedId) {
        e.preventDefault();
        duplicateSelected();
      }
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedId) {
        pushUndo();
        removeEl(state.selectedId);
      }
      return;
    }
    if (e.shiftKey && state.selectedId && state.elements[state.selectedId]) {
      const el = state.elements[state.selectedId];
      if (el.type === 'note' || el.type === 'image') {
        const step = Math.PI / 12;
        if (e.code === 'KeyR') {
          e.preventDefault();
          pushUndo();
          el.rotation = Math.round(((el.rotation || 0) + step) / step) * step;
          upsert(el);
          toast('旋转 ' + Math.round(el.rotation * 180 / Math.PI) + '°');
          return;
        }
        if (e.code === 'Digit0') {
          e.preventDefault();
          pushUndo();
          el.rotation = 0;
          upsert(el);
          toast('旋转已复位');
          return;
        }
      }
    }

    const map = { v: 'select', n: 'note', p: 'pen', l: 'connect', h: 'pan' };
    const k = e.key.toLowerCase();
    if (map[k] && !e.ctrlKey && !e.metaKey) {
      selectTool(map[k]);
    }
  });

  window.addEventListener('keyup', e => {
    if (e.code === 'Space') {
      state.spaceDown = false;
      stage.classList.remove('space');
    }
  });

  window.addEventListener('paste', e => {
    if (state.editingId != null) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) insertImageFile(file);
        break;
      }
    }
  });

  // Pinch-to-zoom & two-finger pan (mobile)
  let pinchState = null;
  const getTouchDist = touches => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };
  const getTouchCenter = (touches, rect) => ({
    x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
    y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top,
  });

  canvas.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) return;
    if (state.drag) {
      if (state.drag.id) clearThrottled(state.drag.id);
      state.drag = null;
      stage.classList.remove('panning');
    }
    const rect = canvas.getBoundingClientRect();
    const c = getTouchCenter(e.touches, rect);
    pinchState = {
      dist: getTouchDist(e.touches),
      scale: state.view.scale,
      cx: c.x,
      cy: c.y,
      vx: state.view.x,
      vy: state.view.y,
    };
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !pinchState) return;
    const rect = canvas.getBoundingClientRect();
    const c = getTouchCenter(e.touches, rect);
    const dist = getTouchDist(e.touches);
    const newScale = clamp(pinchState.scale * (dist / pinchState.dist), 0.15, 6);
    const anchor = screenToWorld(pinchState.cx, pinchState.cy, {
      x: pinchState.vx,
      y: pinchState.vy,
      scale: pinchState.scale,
    });
    state.view.scale = newScale;
    state.view.x = pinchState.cx - anchor.x * newScale + (c.x - pinchState.cx);
    state.view.y = pinchState.cy - anchor.y * newScale + (c.y - pinchState.cy);
    updateZoomLabel();
    if (state.editingId != null) {
      const n = state.elements[state.editingId];
      if (n) positionEditor(n);
    }
    requestRender();
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchend', e => {
    if (e.touches.length < 2) pinchState = null;
  });
}
