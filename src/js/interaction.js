/**
 * Pointer and keyboard interaction
 * @module interaction
 */

import { state, pushUndo, removeEl, upsert, undo, redo } from './state.js';
import { screenToWorld, worldToScreen, uid, clamp, toast } from './utils.js';
import { requestRender, NOTE_FONT, clearImageCache } from './renderer.js';
import { openEditor, closeEditor } from './editor.js';
import { broadcastCursor, broadcastThrottled } from './network.js';
import { selectTool, updateZoomLabel } from './toolbar.js';

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
  const ids = Object.keys(state.elements);
  for (let i = ids.length - 1; i >= 0; i--) {
    const el = state.elements[ids[i]];
    if (el.type === 'note' && hitNote(el, p)) return el;
  }
  for (let i = ids.length - 1; i >= 0; i--) {
    const el = state.elements[ids[i]];
    if (el.type === 'image' && hitNote(el, p)) return el;
  }
  for (let i = ids.length - 1; i >= 0; i--) {
    const el = state.elements[ids[i]];
    if (el.type === 'stroke' && distToStroke(el, p)) return el;
  }
  for (let i = ids.length - 1; i >= 0; i--) {
    const el = state.elements[ids[i]];
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

  // 将当前视口范围也纳入计算，确保用户平移/缩放时迷你地图实时跟随视口动态映射
  const vx0 = -state.view.x / state.view.scale;
  const vy0 = -state.view.y / state.view.scale;
  const vx1 = (state.W - state.view.x) / state.view.scale;
  const vy1 = (state.H - state.view.y) / state.view.scale;

  if (!has) {
    minX = vx0;
    minY = vy0;
    maxX = vx1;
    maxY = vy1;
  } else {
    minX = Math.min(minX, vx0);
    minY = Math.min(minY, vy0);
    maxX = Math.max(maxX, vx1);
    maxY = Math.max(maxY, vy1);
  }

  const pad = 80;
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad };
}

function getPos(e, canvas) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
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
      state.drag = { mode: 'pan', sx: sp.x, sy: sp.y, vx: state.view.x, vy: state.view.y };
      stage.classList.add('panning');
      return;
    }
    if (e.button === 2) return;

    if (state.tool === 'note') {
      const hit = pick(wp);
      if (hit && hit.type === 'note') {
        state.selectedId = hit.id;
        selectTool('select');
        pushUndo();
        state.drag = { mode: 'move', id: hit.id, dx: wp.x - hit.x, dy: wp.y - hit.y, moved: false };
      } else {
        pushUndo();
        const n = {
          id: uid(), type: 'note',
          x: wp.x - NOTE_W / 2, y: wp.y - NOTE_H / 2,
          w: NOTE_W, h: NOTE_H,
          text: '', color: state.noteColor, rev: 0
        };
        upsert(n);
        state.selectedId = n.id;
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
      state.drag = { mode: 'draw', id: s.id };
      upsert(s, true);
      return;
    }

    if (state.tool === 'connect') {
      const hit = pick(wp);
      if (hit && hit.type === 'note') {
        state.connectFrom = hit.id;
        state.drag = { mode: 'connect' };
      }
      return;
    }

    const hit = pick(wp);
    if (!hit) {
      state.selectedId = null;
      state.drag = { mode: 'pan', sx: sp.x, sy: sp.y, vx: state.view.x, vy: state.view.y };
      requestRender();
      return;
    }
    
    if ((hit.type === 'note' || hit.type === 'image') && state.selectedId === hit.id) {
      const hk = hitHandle(hit, sp);
      if (hk) {
        pushUndo();
        state.drag = {
          mode: 'resize',
          id: hit.id,
          hk: hk,
          origX: hit.x,
          origY: hit.y,
          origW: hit.w,
          origH: hit.h,
          startWp: { x: wp.x, y: wp.y }
        };
        return;
      }
    }
    
    state.selectedId = hit.id;
    if (hit.type === 'note' || hit.type === 'image') {
      pushUndo();
      state.drag = { mode: 'move', id: hit.id, dx: wp.x - hit.x, dy: wp.y - hit.y, moved: false };
    } else if (hit.type === 'stroke') {
      pushUndo();
      state.drag = {
        mode: 'move-el', id: hit.id,
        sx: wp.x, sy: wp.y,
        orig: hit.points.map(p => ({ x: p.x, y: p.y })), moved: false
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
    
    if (state.drag.mode === 'pan') {
      state.view.x = state.drag.vx + (sp.x - state.drag.sx);
      state.view.y = state.drag.vy + (sp.y - state.drag.sy);
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
    const mode = state.drag.mode;
    if (mode === 'draw') {
      const s = state.elements[state.drag.id];
      if (s) upsert(s);
    } else if (mode === 'move' || mode === 'move-el' || mode === 'resize') {
      const el = state.elements[state.drag.id];
      if (el) upsert(el);
    } else if (mode === 'connect') {
      const sp = getPos(e, canvas);
      const wp = screenToWorld(sp.x, sp.y, state.view);
      const hit = pick(wp);
      if (state.connectFrom && hit && hit.type === 'note' && hit.id !== state.connectFrom) {
        pushUndo();
        const c = { id: uid(), type: 'connection', from: state.connectFrom, to: hit.id, rev: 0 };
        upsert(c);
      }
      state.connectFrom = null;
    }
    state.drag = null;
    stage.classList.remove('panning');
    requestRender();
  });

  canvas.addEventListener('dblclick', e => {
    const sp = getPos(e, canvas);
    const wp = screenToWorld(sp.x, sp.y, state.view);
    const hit = pick(wp);
    if (hit && hit.type === 'note') {
      state.selectedId = hit.id;
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
    const before = screenToWorld(sp.x, sp.y, state.view);
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    state.view.scale = clamp(state.view.scale * factor, 0.15, 6);
    state.view.x = sp.x - before.x * state.view.scale;
    state.view.y = sp.y - before.y * state.view.scale;
    updateZoomLabel();
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
        if (!file) continue;

        const reader = new FileReader();
        reader.onload = evt => {
          const rawDataUrl = evt.target.result;
          const img = new Image();
          img.onload = () => {
            // 对超大图片进行合理尺寸缩放限制（保持比例，便于快速 P2P 传输与存储）
            const maxDim = 1200;
            let targetW = img.naturalWidth;
            let targetH = img.naturalHeight;
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
            const optimizedDataUrl = offCanvas.toDataURL('image/jpeg', 0.85);

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
            const posX = state.pointerWorld ? state.pointerWorld.x - dw / 2 : center.x - dw / 2;
            const posY = state.pointerWorld ? state.pointerWorld.y - dh / 2 : center.y - dh / 2;

            pushUndo();
            const imageEl = {
              id: uid(),
              type: 'image',
              x: posX,
              y: posY,
              w: dw,
              h: dh,
              dataUrl: optimizedDataUrl,
              rev: 0
            };
            upsert(imageEl, true);
            state.selectedId = imageEl.id;
            selectTool('select');
            toast('已粘贴图片');
          };
          img.src = rawDataUrl;
        };
        reader.readAsDataURL(file);
        break;
      }
    }
  });
}
