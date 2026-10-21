/**
 * Canvas rendering routines
 * @module renderer
 */

import { state, peers, peerId, selfPeerId } from './state.js';
import { screenToWorld, worldToScreen } from './utils.js';
import { connEndpoints, noteHandles, contentBounds } from './geometry.js';
import { decodeGifFrames } from './gif.js';
import { bus, EVENTS } from './events.js';

export const DPR = Math.max(1, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
export const GRID = 40;

let canvas, ctx, mm, mmx, stage;
let renderQueued = false;

// Image element cache: id -> HTMLImageElement
const imageCache = {};

// Lazy image src assignment queue so multi-MB base64 strings don't freeze first paint
const imageQueue = [];
let imagePumpTimer = null;

function pumpImageQueue() {
  const start = performance.now();
  while (imageQueue.length && performance.now() - start < 4) {
    const img = imageQueue.shift();
    img.src = img._dataUrl;
  }
  if (imageQueue.length) imagePumpTimer = setTimeout(pumpImageQueue, 0);
  else imagePumpTimer = null;
}

function queueImageSrc(img) {
  imageQueue.push(img);
  if (!imagePumpTimer) imagePumpTimer = setTimeout(pumpImageQueue, 0);
}

function unqueueImage(id) {
  for (let i = imageQueue.length - 1; i >= 0; i--) {
    if (imageQueue[i]._elId === id) imageQueue.splice(i, 1);
  }
}

let imageLoadRafId = null;
let lastSpinnerFrame = 0;
const SPINNER_FRAME_MS = 66;
const loadingImages = new Set();

function startImageLoadAnim() {
  if (imageLoadRafId) return;
  function tick(now) {
    if (loadingImages.size === 0) { imageLoadRafId = null; return; }
    if (now - lastSpinnerFrame >= SPINNER_FRAME_MS) {
      lastSpinnerFrame = now;
      requestRender();
    }
    imageLoadRafId = requestAnimationFrame(tick);
  }
  imageLoadRafId = requestAnimationFrame(tick);
}

function stopImageLoadAnim() {
  if (imageLoadRafId) { cancelAnimationFrame(imageLoadRafId); imageLoadRafId = null; }
}

let gridTile = null;
let gridTileBucket = -1;
let gridPattern = null;

const strokeBboxCache = new Map();
let boundsCache = null;

const gifState = {};
let gifAnimRunning = false;
let gifRafId = null;

function startGifAnim() {
  if (gifAnimRunning) return;
  gifAnimRunning = true;
  let last = performance.now();
  function tick(now) {
    if (!gifAnimRunning) return;
    const dt = now - last;
    last = now;
    let changed = false;
    for (const id in gifState) {
      const gs = gifState[id];
      if (!state.elements[id]) {
        delete gifState[id];
        if (!hasAnyGif()) stopGifAnim();
        continue;
      }
      if (!gs.frames || gs.frames.length <= 1) continue;
      gs.elapsed = Math.min(gs.elapsed + dt, 2000);
      while (gs.elapsed >= (gs.durations[gs.frameIndex] || 100)) {
        gs.elapsed -= (gs.durations[gs.frameIndex] || 100);
        gs.frameIndex = (gs.frameIndex + 1) % gs.frames.length;
        changed = true;
      }
    }
    if (changed) requestRender();
    gifRafId = requestAnimationFrame(tick);
  }
  gifRafId = requestAnimationFrame(tick);
}

function stopGifAnim() {
  gifAnimRunning = false;
  if (gifRafId) { cancelAnimationFrame(gifRafId); gifRafId = null; }
}

function hasAnyGif() {
  return Object.keys(gifState).length > 0;
}

function getImageObj(el) {
  const cached = imageCache[el.id];
  if (cached && cached._dataUrl === el.dataUrl) return cached;

  if (el.dataUrl && el.dataUrl.startsWith('data:image/gif') && !gifState[el.id]) {
    gifState[el.id] = { frames: null, durations: null, frameIndex: 0, elapsed: 0, pending: true };
    decodeGifFrames(el.dataUrl).then(result => {
      const gs = gifState[el.id];
      if (!gs) return;
      gs.pending = false;
      if (!result) return;
      gs.width = result.width;
      gs.height = result.height;
      gs.frames = result.frames;
      gs.durations = result.durations;
      if (result.frames.length) {
        gs.frameCanvas = document.createElement('canvas');
        gs.frameCanvas.width = result.width;
        gs.frameCanvas.height = result.height;
        gs.frameCtx = gs.frameCanvas.getContext('2d');
        startGifAnim();
        requestRender();
      }
    }).catch(() => {
      const gs = gifState[el.id];
      if (gs) gs.pending = false;
    });
  }

  unqueueImage(el.id);

  const img = new Image();
  img._dataUrl = el.dataUrl;
  img._elId = el.id;
  img.onload = () => {
    loadingImages.delete(el.id);
    requestRender();
    if (loadingImages.size === 0) stopImageLoadAnim();
  };
  img.onerror = () => {
    img.error = true;
    loadingImages.delete(el.id);
    requestRender();
    if (loadingImages.size === 0) stopImageLoadAnim();
  };
  imageCache[el.id] = img;
  loadingImages.add(el.id);
  startImageLoadAnim();
  queueImageSrc(img);
  return img;
}

export function clearImageCache(id) {
  delete imageCache[id];
  loadingImages.delete(id);
  unqueueImage(id);
  if (gifState[id]) {
    delete gifState[id];
    if (!hasAnyGif()) stopGifAnim();
  }
  if (loadingImages.size === 0) stopImageLoadAnim();
}

export function initRenderer() {
  canvas = document.getElementById('board');
  ctx = canvas.getContext('2d');
  stage = document.getElementById('stage');
  mm = document.getElementById('mm');
  mmx = mm.getContext('2d');

  bus.off(EVENTS.RENDER_REQUEST, requestRender);
  bus.on(EVENTS.RENDER_REQUEST, requestRender);
  bus.off(EVENTS.IMAGE_CACHE_CLEAR, clearImageCache);
  bus.on(EVENTS.IMAGE_CACHE_CLEAR, clearImageCache);
}

export function resize() {
  if (!stage || !canvas || !ctx || !mm || !mmx) return;
  const newW = stage.clientWidth;
  const newH = stage.clientHeight;
  if (newW === state.W && newH === state.H) return;
  state.W = newW;
  state.H = newH;
  canvas.width = Math.round(state.W * DPR);
  canvas.height = Math.round(state.H * DPR);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  const mr = mm.getBoundingClientRect();
  mm.width = Math.round(mr.width * DPR);
  mm.height = Math.round(mr.height * DPR);
  mmx.setTransform(DPR, 0, 0, DPR, 0, 0);
  requestRender();
}

export function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (!ctx || !mmx) return;
    render();
    drawMinimap();
  });
}

function getStrokeBBox(el) {
  const cached = strokeBboxCache.get(el.id);
  if (cached && cached.points === el.points && cached.len === el.points.length) {
    return cached.bbox;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of el.points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const halfW = (el.width || 1) / 2;
  const bbox = { x0: minX - halfW, y0: minY - halfW, x1: maxX + halfW, y1: maxY + halfW };
  strokeBboxCache.set(el.id, { bbox, points: el.points, len: el.points.length });
  return bbox;
}

function isCulled(el, vr) {
  if (!el) return true;
  if (el.type === 'note' || el.type === 'image') {
    let x0, y0, x1, y1;
    if (el.rotation) {
      const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
      const c = Math.abs(Math.cos(el.rotation)), s = Math.abs(Math.sin(el.rotation));
      const hw = (el.w * c + el.h * s) / 2;
      const hh = (el.w * s + el.h * c) / 2;
      x0 = cx - hw; y0 = cy - hh; x1 = cx + hw; y1 = cy + hh;
    } else {
      x0 = el.x; y0 = el.y; x1 = el.x + el.w; y1 = el.y + el.h;
    }
    return x1 < vr.x0 || x0 > vr.x1 || y1 < vr.y0 || y0 > vr.y1;
  }
  if (el.type === 'stroke') {
    if (!el.points || !el.points.length) return true;
    const bb = getStrokeBBox(el);
    return bb.x1 < vr.x0 || bb.x0 > vr.x1 ||
           bb.y1 < vr.y0 || bb.y0 > vr.y1;
  }
  return false;
}

let sortedIdsCache = null;
let sortedIdsMut = -1;
function getSortedIds() {
  const mut = state.__mut || 0;
  if (sortedIdsCache && sortedIdsMut === mut) return sortedIdsCache;
  const ids = Object.keys(state.elements);
  const pairs = ids.map((id, i) => [id, i, state.elements[id].z || 0]);
  pairs.sort((a, b) => {
    if (a[2] !== b[2]) return a[2] - b[2];
    return a[1] - b[1];
  });
  const result = pairs.map(p => p[0]);
  sortedIdsCache = result;
  sortedIdsMut = mut;
  return result;
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, state.W, state.H);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, state.W, state.H);

  ctx.save();
  ctx.translate(state.view.x, state.view.y);
  ctx.scale(state.view.scale, state.view.scale);
  drawGrid();

  const m = 120 / state.view.scale;
  const vr = {
    x0: -state.view.x / state.view.scale - m,
    y0: -state.view.y / state.view.scale - m,
    x1: (state.W - state.view.x) / state.view.scale + m,
    y1: (state.H - state.view.y) / state.view.scale + m,
  };
  const ids = getSortedIds();

  for (const id of ids) {
    const el = state.elements[id];
    if (!el || el.type !== 'connection') continue;
    const fromEl = state.elements[el.from];
    const toEl = state.elements[el.to];
    if (!fromEl || !toEl) continue;
    if (isCulled(fromEl, vr) && isCulled(toEl, vr)) continue;
    drawConnection(el);
  }
  for (const id of ids) {
    const el = state.elements[id];
    if (!el || el.type !== 'stroke') continue;
    if (isCulled(el, vr)) continue;
    drawStroke(el);
  }
  for (const id of ids) {
    const el = state.elements[id];
    if (!el || el.type !== 'image') continue;
    if (isCulled(el, vr)) continue;
    drawImageEl(el);
  }
  for (const id of ids) {
    const el = state.elements[id];
    if (!el || el.type !== 'note') continue;
    if (isCulled(el, vr)) continue;
    drawNote(el);
  }

  // Draw active connection preview line (both during drag and two-click connect mode)
  if (state.tool === 'connect' && state.connectFrom) {
    const a = state.elements[state.connectFrom];
    if (a) {
      const c = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      ctx.strokeStyle = state.connColor || '#4c8bf5';
      ctx.lineWidth = 2 / state.view.scale;
      ctx.setLineDash([6 / state.view.scale, 5 / state.view.scale]);
      ctx.beginPath();
      ctx.moveTo(c.x, c.y);
      ctx.lineTo(state.pointerWorld.x, state.pointerWorld.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();

  const sel = state.selectedId && state.elements[state.selectedId];
  if (sel) {
    drawSelection(sel);
  }
  drawPeerCursors();
}

function getGridTile() {
  const scale = state.view.scale;
  const bucket = Math.round(scale * 8);
  if (gridTile && gridTileBucket === bucket) return gridTile;

  const px = Math.max(2, Math.round(GRID * 5 * scale));
  const c = document.createElement('canvas');
  c.width = px;
  c.height = px;
  const g = c.getContext('2d');
  const step = px / 5;

  g.strokeStyle = '#eef0f4';
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 1; i < 5; i++) {
    const p = i * step;
    g.moveTo(p, 0); g.lineTo(p, px);
    g.moveTo(0, p); g.lineTo(px, p);
  }
  g.stroke();

  g.strokeStyle = '#e3e6ee';
  g.beginPath();
  g.moveTo(0, 0); g.lineTo(0, px);
  g.moveTo(0, 0); g.lineTo(px, 0);
  g.moveTo(px, 0); g.lineTo(px, px);
  g.moveTo(0, px); g.lineTo(px, px);
  g.stroke();

  gridTile = c;
  gridTileBucket = bucket;
  gridPattern = null;
  return c;
}

function drawGrid() {
  const tile = getGridTile();
  if (!gridPattern) gridPattern = ctx.createPattern(tile, 'repeat');
  ctx.fillStyle = gridPattern;
  const x0 = -state.view.x / state.view.scale;
  const y0 = -state.view.y / state.view.scale;
  const x1 = (state.W - state.view.x) / state.view.scale;
  const y1 = (state.H - state.view.y) / state.view.scale;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

function applyElRotation(el) {
  if (!el.rotation) return;
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  ctx.translate(cx, cy);
  ctx.rotate(el.rotation);
  ctx.translate(-cx, -cy);
}

function roundRect(c, x, y, w, h, r) {
  if (c.roundRect) {
    c.beginPath(); c.roundRect(x, y, w, h, r); return;
  }
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawSpinner(cx, cy, size) {
  const time = performance.now() / 1000;
  const startAngle = (time * 2 * Math.PI) % (2 * Math.PI);
  const endAngle = startAngle + Math.PI * 1.5;

  ctx.save();
  ctx.strokeStyle = '#4f46e5';
  ctx.lineWidth = 3 / state.view.scale;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy, size, startAngle, endAngle);
  ctx.stroke();
  ctx.restore();
}

function drawImagePlaceholder(el, img) {
  ctx.save();
  ctx.fillStyle = 'rgba(245,245,245,0.8)';
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.fill();

  ctx.setLineDash([6 / state.view.scale, 4 / state.view.scale]);
  ctx.strokeStyle = '#bbb';
  ctx.lineWidth = 1.5 / state.view.scale;
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.stroke();
  ctx.setLineDash([]);

  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const size = Math.max(8, Math.min(el.w, el.h) * 0.12);

  if (img && img.error) {
    ctx.fillStyle = '#e74c3c';
    ctx.font = `bold ${Math.max(14, size * 2)}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('✕', cx, cy - size * 0.3);
    ctx.font = `${Math.max(10, size)}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
    ctx.fillText('加载失败', cx, cy + size * 1.6);
  } else {
    drawSpinner(cx, cy, size);
  }

  ctx.restore();
}

function drawImageEl(el) {
  ctx.save();
  applyElRotation(el);

  let drawSource;
  const gs = gifState[el.id];
  if (el.dataUrl && el.dataUrl.startsWith('data:image/gif') && gs && gs.frames && gs.frames.length) {
    const fc = gs.frameCanvas;
    const fx = gs.frameCtx;
    if (fc && fx) {
      const frameData = gs.frames[gs.frameIndex];
      fx.putImageData(new ImageData(frameData, gs.width, gs.height), 0, 0);
      drawSource = fc;
    } else {
      drawSource = getImageObj(el);
    }
  } else {
    drawSource = getImageObj(el);
    if (!drawSource.complete || !drawSource.naturalWidth) {
      drawImagePlaceholder(el, drawSource);
      ctx.restore();
      return;
    }
  }

  ctx.save();
  ctx.shadowColor = 'rgba(20,24,40,.12)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.clip();
  ctx.drawImage(drawSource, el.x, el.y, el.w, el.h);
  ctx.restore();

  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,.10)';
  ctx.lineWidth = 1.5 / state.view.scale;
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}

function drawNote(n) {
  ctx.save();
  applyElRotation(n);
  ctx.save();
  ctx.globalAlpha = (n.bgOpacity ?? 88) / 100;
  ctx.shadowColor = 'rgba(20,24,40,.16)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 5;
  roundRect(ctx, n.x, n.y, n.w, n.h, 12);
  ctx.fillStyle = n.color;
  ctx.fill();
  ctx.restore();

  // Skip canvas text when the note is actively being edited in the overlaid <textarea>
  // to prevent double-text ghosting while preserving background opacity and shadow.
  if (state.editingId === n.id) {
    ctx.restore();
    return;
  }

  ctx.save();
  ctx.globalAlpha = (n.textOpacity ?? 72) / 100;
  ctx.fillStyle = '#1c1f2b';
  const fs = n.fontSize || 16;
  ctx.font = `${fs}px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif`;
  ctx.textBaseline = 'top';
  const pad = Math.max(10, fs * 0.6);
  const lines = wrapText(n.text || '', n.w - pad * 2);
  let yy = n.y + pad;
  for (const ln of lines) {
    if (yy > n.y + n.h - pad) break;
    ctx.fillText(ln, n.x + pad, yy);
    yy += fs * 1.32;
  }
  ctx.restore();
  ctx.restore();
}

function wrapText(text, maxW) {
  const out = [];
  for (const raw of String(text).split('\n')) {
    if (raw === '') { out.push(''); continue; }
    let line = '';
    for (const ch of raw) {
      if (ctx.measureText(line + ch).width > maxW && line) {
        out.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    out.push(line);
  }
  return out;
}

function drawStroke(s) {
  if (!s.points || s.points.length < 1) return;
  ctx.strokeStyle = s.color;
  ctx.lineWidth = s.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(s.points[0].x, s.points[0].y);
  for (let i = 1; i < s.points.length; i++) {
    ctx.lineTo(s.points[i].x, s.points[i].y);
  }
  if (s.points.length === 1) {
    ctx.lineTo(s.points[0].x + 0.1, s.points[0].y + 0.1);
  }
  ctx.stroke();
}

function drawConnection(c) {
  const e = connEndpoints(c);
  if (!e) return;
  const col = c.color || '#9aa0b4';
  ctx.strokeStyle = col;
  ctx.lineWidth = 2 / state.view.scale;
  ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(e.a.x, e.a.y);
  ctx.lineTo(e.b.x, e.b.y);
  ctx.stroke();

  const ang = Math.atan2(e.b.y - e.a.y, e.b.x - e.a.x);
  const ah = 10 / state.view.scale;
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.moveTo(e.b.x, e.b.y);
  ctx.lineTo(e.b.x - ah * Math.cos(ang - 0.4), e.b.y - ah * Math.sin(ang - 0.4));
  ctx.lineTo(e.b.x - ah * Math.cos(ang + 0.4), e.b.y - ah * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
}

function drawSelection(sel) {
  if (sel.type === 'note' || sel.type === 'image') {
    const { pts, sz, rotScreen, rotCx } = noteHandles(sel);
    ctx.strokeStyle = '#4c8bf5';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([]);

    ctx.beginPath();
    ctx.moveTo(pts.nw.x, pts.nw.y);
    ctx.lineTo(pts.ne.x, pts.ne.y);
    ctx.lineTo(pts.se.x, pts.se.y);
    ctx.lineTo(pts.sw.x, pts.sw.y);
    ctx.closePath();
    ctx.stroke();

    ctx.save();
    ctx.strokeStyle = 'rgba(76,139,245,.55)';
    ctx.beginPath();
    ctx.moveTo(rotCx.x, rotCx.y);
    ctx.lineTo(rotScreen.x, rotScreen.y);
    ctx.stroke();
    ctx.restore();

    const half = sz / 2;
    ctx.fillStyle = '#fff';
    for (const k in pts) {
      ctx.beginPath();
      ctx.rect(pts[k].x - half, pts[k].y - half, sz, sz);
      ctx.fill();
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(rotScreen.x, rotScreen.y, half + 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    const drag = state.drag;
    if (drag && drag.mode === 'rotate' && drag.id === sel.id && drag.angle != null) {
      const label = Math.round(drag.angle * 180 / Math.PI) + '°';
      ctx.save();
      ctx.font = '12px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(31,35,48,.92)';
      ctx.fillRect(rotScreen.x + 10, rotScreen.y - 24, tw + 14, 20);
      ctx.fillStyle = '#fff';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, rotScreen.x + 17, rotScreen.y - 13);
      ctx.restore();
    }
    return;
  }

  if (sel.type === 'stroke' && sel.points && sel.points.length) {
    const bb = getStrokeBBox(sel);
    const tl = worldToScreen(bb.x0, bb.y0, state.view);
    const br = worldToScreen(bb.x1, bb.y1, state.view);
    const pad = 6;
    ctx.save();
    ctx.strokeStyle = '#4c8bf5';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(tl.x - pad, tl.y - pad, (br.x - tl.x) + pad * 2, (br.y - tl.y) + pad * 2);
    ctx.restore();
    return;
  }

  if (sel.type === 'connection') {
    const e = connEndpoints(sel);
    if (!e) return;
    const sa = worldToScreen(e.a.x, e.a.y, state.view);
    const sb = worldToScreen(e.b.x, e.b.y, state.view);
    ctx.save();
    ctx.strokeStyle = '#4c8bf5';
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sa.x, sa.y);
    ctx.lineTo(sb.x, sb.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    for (const pt of [sa, sb]) {
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawPeerCursors() {
  const now = performance.now();
  for (const id in peers) {
    if (id === peerId || id === selfPeerId) continue;
    const p = peers[id];
    if (!p.cursor || now - p.last > 12000) continue;
    const s = worldToScreen(p.cursor.x, p.cursor.y, state.view);
    if (s.x < -40 || s.y < -40 || s.x > state.W + 40 || s.y > state.H + 40) continue;

    ctx.save();
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x, s.y + 16);
    ctx.lineTo(s.x + 4.5, s.y + 12);
    ctx.lineTo(s.x + 11, s.y + 11);
    ctx.closePath();
    ctx.fill();

    ctx.font = '11px sans-serif';
    const tw = ctx.measureText(p.name).width;
    ctx.fillStyle = p.color;
    ctx.fillRect(s.x + 10, s.y + 12, tw + 10, 16);
    ctx.fillStyle = '#fff';
    ctx.fillText(p.name, s.x + 15, s.y + 15);
    ctx.restore();
  }
}

function getCachedContentBounds() {
  const mut = state.__mut || 0;
  if (boundsCache && boundsCache.mut === mut) return boundsCache.result;
  const result = contentBounds();
  boundsCache = { mut, result };
  return result;
}

function drawMinimap() {
  const mw = mm.clientWidth;
  const mh = mm.clientHeight;
  mmx.setTransform(DPR, 0, 0, DPR, 0, 0);
  mmx.clearRect(0, 0, mw, mh);
  mmx.fillStyle = '#fbfcfe';
  mmx.fillRect(0, 0, mw, mh);

  const cb = getCachedContentBounds();
  const vx0 = screenToWorld(0, 0, state.view);
  const vx1 = screenToWorld(state.W, state.H, state.view);
  const b = {
    minX: Math.min(cb.minX, vx0.x) - 40,
    minY: Math.min(cb.minY, vx0.y) - 40,
    maxX: Math.max(cb.maxX, vx1.x) + 40,
    maxY: Math.max(cb.maxY, vx1.y) + 40,
  };
  const cw = Math.max(10, b.maxX - b.minX);
  const ch = Math.max(10, b.maxY - b.minY);
  const sc = Math.min(mw / cw, mh / ch);
  const ox = (mw - cw * sc) / 2;
  const oy = (mh - ch * sc) / 2;
  const tx = wx => ox + (wx - b.minX) * sc;
  const ty = wy => oy + (wy - b.minY) * sc;

  mm._map = { b, sc, ox, oy };

  const mmRect = (el, fill) => {
    mmx.fillStyle = fill;
    if (el.rotation) {
      const cx = tx(el.x + el.w / 2), cy = ty(el.y + el.h / 2);
      mmx.save();
      mmx.translate(cx, cy);
      mmx.rotate(el.rotation);
      mmx.fillRect(-el.w * sc / 2, -el.h * sc / 2, el.w * sc, el.h * sc);
      mmx.restore();
    } else {
      mmx.fillRect(tx(el.x), ty(el.y), el.w * sc, el.h * sc);
    }
  };

  for (const id in state.elements) {
    const el = state.elements[id];
    if (!el) continue;
    if (el.type === 'note') {
      mmRect(el, el.color);
    } else if (el.type === 'image') {
      mmRect(el, '#c8cdd8');
    } else if (el.type === 'stroke' && el.points) {
      mmx.strokeStyle = el.color;
      mmx.lineWidth = 1;
      mmx.beginPath();
      el.points.forEach((pt, i) => i ? mmx.lineTo(tx(pt.x), ty(pt.y)) : mmx.moveTo(tx(pt.x), ty(pt.y)));
      mmx.stroke();
    }
  }
  mmx.strokeStyle = '#4c8bf5';
  mmx.lineWidth = 1.5;
  mmx.strokeRect(tx(vx0.x), ty(vx0.y), (vx1.x - vx0.x) * sc, (vx1.y - vx0.y) * sc);
}
