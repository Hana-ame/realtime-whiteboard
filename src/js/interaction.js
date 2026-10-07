/**
 * Pointer and keyboard interaction
 * @module interaction
 */

import { state, pushUndo, removeEl, upsert, bringToFront, undo, redo, undoStack } from './state.js';
import { screenToWorld, worldToScreen, uid, clamp, toast } from './utils.js';
import { requestRender, clearImageCache } from './renderer.js';
import { openEditor, closeEditor, positionEditor } from './editor.js';
import { broadcastCursor, broadcastThrottled, clearThrottled } from './network.js';
import { selectTool, updateZoomLabel, updateDeleteBtn } from './toolbar.js';

export const NOTE_W = 170;
export const NOTE_H = 120;

// Geometry helpers
export function hitNote(n, p) {
  return p.x >= n.x && p.x <= n.x + n.w && p.y >= n.y && p.y <= n.y + n.h;
}

export function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToStroke(s, p) {
  const th = 6 / state.view.scale;
  for (let i = 1; i < s.points.length; i++) {
    if (distToSeg(p, s.points[i - 1], s.points[i]) < th) return true;
  }
  return false;
}

export function noteCenter(n) {
  return { x: n.x + n.w / 2, y: n.y + n.h / 2 };
}

export function rectEdgePoint(n, toward) {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  const dx = toward.x - cx, dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const hw = n.w / 2, hh = n.h / 2;
  const sx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const sy = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const s = Math.min(sx, sy);
  return { x: cx + dx * s, y: cy + dy * s };
}

export function connEndpoints(c) {
  const a = state.elements[c.from], b = state.elements[c.to];
  if (!a || !b) return null;
  return { a: noteCenter(a), b: rectEdgePoint(b, noteCenter(a)) };
}

export function pick(p) {
  // 与渲染顺序一致：类型优先（便签>图片>描画>连线），同类型内 z 大的在上，
  // 同 z 按插入顺序（后插在上）。z 由 bringToFront 设置并广播，缺省 0。
  // 旧代码只按对象插入顺序，bringToFront 本地改不广播，各端分叉后点同一个
  // 交叠位置会选中不同元素。
  const ids = Object.keys(state.elements);
  const rank = { note: 3, image: 2, stroke: 1, connection: 0 };
  const idx = new Map(ids.map((id, i) => [id, i]));
  ids.sort((a, b) => {
    const ea = state.elements[a], eb = state.elements[b];
    const ra = rank[ea.type] ?? 0, rb = rank[eb.type] ?? 0;
    if (ra !== rb) return rb - ra;
    const za = ea.z || 0, zb = eb.z || 0;
    if (za !== zb) return zb - za;
    return idx.get(b) - idx.get(a);
  });
  for (const id of ids) {
    const el = state.elements[id];
    if (el.type === 'note' && hitNote(el, p)) return el;
    if (el.type === 'image' && hitNote(el, p)) return el;
    if (el.type === 'stroke' && distToStroke(el, p)) return el;
    if (el.type === 'connection') {
      const e = connEndpoints(el);
      if (e && distToSeg(p, e.a, e.b) < 7 / state.view.scale) return el;
    }
  }
  return null;
}

export function noteHandles(n) {
  const tl = worldToScreen(n.x, n.y, state.view);
  const sz = 8;
  const pts = {
    nw: { x: tl.x, y: tl.y },
    ne: { x: tl.x + n.w * state.view.scale, y: tl.y },
    sw: { x: tl.x, y: tl.y + n.h * state.view.scale },
    se: { x: tl.x + n.w * state.view.scale, y: tl.y + n.h * state.view.scale },
    n: { x: tl.x + n.w * state.view.scale / 2, y: tl.y },
    s: { x: tl.x + n.w * state.view.scale / 2, y: tl.y + n.h * state.view.scale },
    w: { x: tl.x, y: tl.y + n.h * state.view.scale / 2 },
    e: { x: tl.x + n.w * state.view.scale, y: tl.y + n.h * state.view.scale / 2 }
  };
  return { pts, sz };
}

export function hitHandle(n, p) {
  const { pts, sz } = noteHandles(n);
  for (const k in pts) {
    if (Math.abs(p.x - pts[k].x) <= sz && Math.abs(p.y - pts[k].y) <= sz) return k;
  }
  return null;
}

export function contentBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, has = false;
  for (const id in state.elements) {
    const el = state.elements[id];
    let x0, y0, x1, y1;
    if (el.type === 'note' || el.type === 'image') {
      x0 = el.x; y0 = el.y; x1 = el.x + el.w; y1 = el.y + el.h;
    } else if (el.type === 'stroke') {
      if (!el.points || el.points.length === 0) continue;
      for (const pt of el.points) {
        x0 = Math.min(x0 ?? pt.x, pt.x);
        y0 = Math.min(y0 ?? pt.y, pt.y);
        x1 = Math.max(x1 ?? pt.x, pt.x);
        y1 = Math.max(y1 ?? pt.y, pt.y);
      }
    } else continue;
    minX = Math.min(minX, x0);
    minY = Math.min(minY, y0);
    maxX = Math.max(maxX, x1);
    maxY = Math.max(maxY, y1);
    has = true;
  }
  if (!has) return { minX: -state.W / 2, minY: -state.H / 2, maxX: state.W / 2, maxY: state.H / 2 };
  const pad = 80;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function getPos(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

/**
 * 插入图片到画布（从文件或粘贴事件复用）
 * 缩放至最大 1200px 保持 P2P 传输效率，显示尺寸 320px
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

      // GIF 保留原始 dataUrl（动图帧信息不能丢，toDataURL('png') 只会得到第一帧）
      // 静态图缩放到 1200px 并重新编码为 PNG（减小 P2P 传输与存储体积）
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

      // 画布上显示的适中初始尺寸
      const displayMax = 320;
      let dw = targetW, dh = targetH;
      if (dw > displayMax || dh > displayMax) {
        const dRatio = Math.min(displayMax / dw, displayMax / dh);
        dw = Math.round(dw * dRatio);
        dh = Math.round(dh * dRatio);
      }

      // 放置在当前鼠标/光标世界坐标，或视口中心
      const center = screenToWorld(state.W / 2, state.H / 2, state.view);
      const hasMoved = state.pointerWorld.x !== 0 || state.pointerWorld.y !== 0;
      const px = hasMoved ? state.pointerWorld.x : center.x;
      const py = hasMoved ? state.pointerWorld.y : center.y;
      const posX = px - dw / 2;
      const posY = py - dh / 2;

      pushUndo();
      const imageEl = {
        id: uid(),
        type: 'image',
        x: posX,
        y: posY,
        w: dw,
        h: dh,
        dataUrl,
        rev: 0
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

    // Resize handle check (before tool-specific handlers so it works in any tool)
    if (state.selectedId && state.elements[state.selectedId]) {
      const sel = state.elements[state.selectedId];
      if (sel.type === 'note' || sel.type === 'image') {
        const hk = hitHandle(sel, sp);
        if (hk) {
          pushUndo();
          state.drag = {
            mode: 'resize',
            id: sel.id,
            hk: hk,
            origX: sel.x,
            origY: sel.y,
            origW: sel.w,
            origH: sel.h,
            startWp: { x: wp.x, y: wp.y },
            pointerId: e.pointerId
          };
          requestRender();
          return;
        }
      }
    }

    // Auto-select note on click (except pen/connect which have their own note handling)
    if (state.tool !== 'pen' && state.tool !== 'connect') {
      const hit = pick(wp);
      if (hit && hit.type === 'note') {
        state.selectedId = hit.id;
        bringToFront(hit.id);
        updateDeleteBtn();
        selectTool('select');
        pushUndo();
        state.drag = { mode: 'move', id: hit.id, dx: wp.x - hit.x, dy: wp.y - hit.y, moved: false, pointerId: e.pointerId };
        requestRender();
        return;
      }
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
      } else {
        pushUndo();
        const n = {
          id: uid(), type: 'note',
          x: wp.x - NOTE_W / 2, y: wp.y - NOTE_H / 2,
          w: NOTE_W, h: NOTE_H,
          text: '', color: state.noteColor, fontSize: state.noteFontSize, rev: 0
        };
        upsert(n);
        state.selectedId = n.id;
        updateDeleteBtn();
        selectTool('select');
        openEditor(n);
      }
      return;
    }

    if (state.tool === 'pen') {
      pushUndo();
      const s = {
        id: uid(), type: 'stroke',
        points: [{ x: wp.x, y: wp.y }],
        color: state.penColor, width: state.penSize, rev: 0
      };
      state.elements[s.id] = s;
      state.drag = { mode: 'draw', id: s.id, pointerId: e.pointerId };
      upsert(s, true);
      return;
    }

    if (state.tool === 'connect') {
      const hit = pick(wp);
      if (hit && (hit.type === 'note' || hit.type === 'image')) {
        state.connectFrom = hit.id;
        state.drag = { mode: 'connect', pointerId: e.pointerId };
      }
      return;
    }

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
        mode: 'move-el', id: hit.id,
        sx: wp.x, sy: wp.y,
        orig: hit.points.map(p => ({ x: p.x, y: p.y })), moved: false,
        pointerId: e.pointerId
      };
    }
    requestRender();
  });

  canvas.addEventListener('pointermove', e => {
    const sp = getPos(e, canvas);
    const wp = screenToWorld(sp.x, sp.y, state.view);
    state.pointerWorld = wp;
    broadcastCursor(wp);
    
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
      n.x = wp.x - state.drag.dx;
      n.y = wp.y - state.drag.dy;
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
        el.points = state.drag.orig.map(p => ({ x: p.x + dx, y: p.y + dy }));
        state.drag.moved = true;
        broadcastThrottled(el);
        requestRender();
      }
      return;
    }
    
    if (state.drag.mode === 'resize') {
      const n = state.elements[state.drag.id];
      if (!n) return;
      const { hk, origX, origY, origW, origH, startWp } = state.drag;
      const dx = wp.x - startWp.x;
      const dy = wp.y - startWp.y;

      let nx = origX, ny = origY, nw = origW, nh = origH;

      if (hk.includes('e')) {
        nw = Math.max(40, origW + dx);
      } else if (hk.includes('w')) {
        const potentialW = origW - dx;
        if (potentialW >= 40) {
          nx = origX + dx;
          nw = potentialW;
        } else {
          nx = origX + origW - 40;
          nw = 40;
        }
      }

      if (hk.includes('s')) {
        nh = Math.max(40, origH + dy);
      } else if (hk.includes('n')) {
        const potentialH = origH - dy;
        if (potentialH >= 40) {
          ny = origY + dy;
          nh = potentialH;
        } else {
          ny = origY + origH - 40;
          nh = 40;
        }
      }

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
      s.points.push({ x: wp.x, y: wp.y });
      broadcastThrottled(s);
      requestRender();
      return;
    }
    
    if (state.drag.mode === 'connect') {
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
      if (s) upsert(s);
    } else if (mode === 'move' || mode === 'move-el' || mode === 'resize') {
      const el = state.elements[dragId];
      if (el && moved) {
        upsert(el);
      } else if (!moved && undoStack.length) {
        // Click without movement — pop phantom undo entry
        undoStack.pop();
      }
    } else if (mode === 'connect') {
      const sp = getPos(e, canvas);
      const wp = screenToWorld(sp.x, sp.y, state.view);
      const hit = pick(wp);
      if (state.connectFrom && hit && (hit.type === 'note' || hit.type === 'image') && hit.id !== state.connectFrom) {
        pushUndo();
        const c = { id: uid(), type: 'connection', from: state.connectFrom, to: hit.id, color: state.connColor, rev: 0 };
        upsert(c);
      }
      state.connectFrom = null;
    }
    state.drag = null;
    stage.classList.remove('panning');
    requestRender();
  });

  canvas.addEventListener('pointercancel', () => {
    if (state.drag) {
      if (state.drag.id) {
        // Persist partial changes before clearing drag
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

    // 如果是触摸板双指平移（无 ctrlKey 且没有大步阶跳跃）
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= 40) {
      // 缩放模式：以当前鼠标光标所在的世界坐标为锚点进行平滑缩放
      const before = screenToWorld(sp.x, sp.y, state.view);
      const zoomFactor = Math.exp(-e.deltaY * 0.0025);
      const newScale = clamp(state.view.scale * zoomFactor, 0.15, 6);
      state.view.scale = newScale;
      state.view.x = sp.x - before.x * newScale;
      state.view.y = sp.y - before.y * newScale;
      updateZoomLabel();
    } else {
      // 双指平移模式（跟手平滑平移）
      state.view.x -= e.deltaX;
      state.view.y -= e.deltaY;
    }
    // Re-position editor if editing
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
    // Ignore shortcuts when typing in an input/textarea
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.code === 'Space') {
      state.spaceDown = true;
      stage.classList.add('space');
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedId) {
        pushUndo();
        removeEl(state.selectedId);
      }
      return;
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

  // 粘贴图片处理 (P2P 局域/对等网络范围传输与本地持久化)
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

  // --- Pinch-to-zoom & two-finger pan (mobile) ---
  let pinchState = null;
  const getTouchDist = touches => {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  };
  const getTouchCenter = (touches, rect) => {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2 - rect.left,
      y: (touches[0].clientY + touches[1].clientY) / 2 - rect.top
    };
  };

  canvas.addEventListener('touchstart', e => {
    if (e.touches.length !== 2) return;
    // Cancel any single-finger drag when pinch begins
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
      cx: c.x, cy: c.y,
      vx: state.view.x, vy: state.view.y
    };
    e.preventDefault();
  }, { passive: false });

  canvas.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || !pinchState) return;
    const rect = canvas.getBoundingClientRect();
    const c = getTouchCenter(e.touches, rect);
    const dist = getTouchDist(e.touches);
    const newScale = clamp(pinchState.scale * (dist / pinchState.dist), 0.15, 6);
    const anchor = screenToWorld(pinchState.cx, pinchState.cy, { x: pinchState.vx, y: pinchState.vy, scale: pinchState.scale });
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
