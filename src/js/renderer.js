/**
 * Canvas rendering routines
 * @module renderer
 */

import { state, peers, peerId } from './state.js';
import { screenToWorld, worldToScreen } from './utils.js';
import { connEndpoints, noteHandles, contentBounds } from './interaction.js';

export const DPR = Math.max(1, window.devicePixelRatio || 1);
export const GRID = 40;

let canvas, ctx, mm, mmx, stage;
let renderQueued = false;

// Image element cache: id -> HTMLImageElement
const imageCache = {};

/**
 * Get or create a cached HTMLImageElement for an image element
 * @param {Object} el - Image element with dataUrl
 * @returns {HTMLImageElement}
 */
function getImageObj(el) {
  const cached = imageCache[el.id];
  if (cached && cached._dataUrl === el.dataUrl) return cached;
  const img = new Image();
  img._dataUrl = el.dataUrl;
  img.src = el.dataUrl;
  img.onload = () => requestRender();
  imageCache[el.id] = img;
  return img;
}

/**
 * Remove cached image when element is deleted
 * @param {string} id - Element id
 */
export function clearImageCache(id) {
  delete imageCache[id];
}

export function initRenderer() {
  canvas = document.getElementById('board');
  ctx = canvas.getContext('2d');
  stage = document.getElementById('stage');
  mm = document.getElementById('mm');
  mmx = mm.getContext('2d');
}

export function resize() {
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
    render();
    drawMinimap();
  });
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

  for (const id in state.elements) {
    const el = state.elements[id];
    if (el.type === 'connection') drawConnection(el);
  }
  for (const id in state.elements) {
    const el = state.elements[id];
    if (el.type === 'stroke') drawStroke(el);
  }
  for (const id in state.elements) {
    const el = state.elements[id];
    if (el.type === 'image') drawImageEl(el);
  }
  for (const id in state.elements) {
    const el = state.elements[id];
    if (el.type === 'note') drawNote(el);
  }

  if (state.tool === 'connect' && state.connectFrom && state.drag && state.drag.mode === 'connect') {
    const a = state.elements[state.connectFrom];
    if (a) {
      const c = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
      ctx.strokeStyle = '#4c8bf5';
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
  if (sel && (sel.type === 'note' || sel.type === 'image')) {
    drawSelection(sel);
  }
  drawPeerCursors();
}

function drawGrid() {
  const x0 = -state.view.x / state.view.scale;
  const y0 = -state.view.y / state.view.scale;
  const x1 = (state.W - state.view.x) / state.view.scale;
  const y1 = (state.H - state.view.y) / state.view.scale;
  const startX = Math.floor(x0 / GRID) * GRID;
  const startY = Math.floor(y0 / GRID) * GRID;
  
  ctx.lineWidth = 1 / state.view.scale;
  for (let x = startX; x <= x1; x += GRID) {
    const major = Math.round(x / GRID) % 5 === 0;
    ctx.strokeStyle = major ? '#e3e6ee' : '#eef0f4';
    ctx.beginPath(); ctx.moveTo(x, y0); ctx.lineTo(x, y1); ctx.stroke();
  }
  for (let y = startY; y <= y1; y += GRID) {
    const major = Math.round(y / GRID) % 5 === 0;
    ctx.strokeStyle = major ? '#e3e6ee' : '#eef0f4';
    ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
  }
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

function drawImageEl(el) {
  const img = getImageObj(el);
  if (!img.complete || !img.naturalWidth) return;

  ctx.save();
  ctx.shadowColor = 'rgba(20,24,40,.12)';
  ctx.shadowBlur = 12;
  ctx.shadowOffsetY = 4;
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.clip();
  ctx.drawImage(img, el.x, el.y, el.w, el.h);
  ctx.restore();

  // Subtle border
  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,.10)';
  ctx.lineWidth = 1.5 / state.view.scale;
  roundRect(ctx, el.x, el.y, el.w, el.h, 6);
  ctx.stroke();
  ctx.restore();
}

function drawNote(n) {
  ctx.save();
  ctx.globalAlpha = 0.88;
  ctx.shadowColor = 'rgba(20,24,40,.16)';
  ctx.shadowBlur = 14;
  ctx.shadowOffsetY = 5;
  roundRect(ctx, n.x, n.y, n.w, n.h, 12);
  ctx.fillStyle = n.color;
  ctx.fill();
  ctx.restore();
  
  ctx.save();
  ctx.globalAlpha = 0.72;
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
  if (s.points.length < 1) return;
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

function drawSelection(n) {
  const tl = worldToScreen(n.x, n.y, state.view);
  const w = n.w * state.view.scale;
  const h = n.h * state.view.scale;
  ctx.strokeStyle = '#4c8bf5';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.strokeRect(tl.x - 1, tl.y - 1, w + 2, h + 2);
  
  const { pts } = noteHandles(n);
  ctx.fillStyle = '#fff';
  for (const k in pts) {
    ctx.beginPath();
    ctx.rect(pts[k].x - 4, pts[k].y - 4, 8, 8);
    ctx.fill();
    ctx.stroke();
  }
}

function drawPeerCursors() {
  const now = performance.now();
  for (const id in peers) {
    if (id === peerId) continue;
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

function drawMinimap() {
  const mw = mm.clientWidth;
  const mh = mm.clientHeight;
  mmx.setTransform(DPR, 0, 0, DPR, 0, 0);
  mmx.clearRect(0, 0, mw, mh);
  mmx.fillStyle = '#fbfcfe';
  mmx.fillRect(0, 0, mw, mh);
  
  const cb = contentBounds();
  const vx0 = screenToWorld(0, 0, state.view);
  const vx1 = screenToWorld(state.W, state.H, state.view);
  const b = {
    minX: Math.min(cb.minX, vx0.x) - 40,
    minY: Math.min(cb.minY, vx0.y) - 40,
    maxX: Math.max(cb.maxX, vx1.x) + 40,
    maxY: Math.max(cb.maxY, vx1.y) + 40
  };
  const cw = Math.max(10, b.maxX - b.minX);
  const ch = Math.max(10, b.maxY - b.minY);
  const sc = Math.min(mw / cw, mh / ch);
  const ox = (mw - cw * sc) / 2;
  const oy = (mh - ch * sc) / 2;
  const tx = wx => ox + (wx - b.minX) * sc;
  const ty = wy => oy + (wy - b.minY) * sc;
  
  mm._map = { b, sc, ox, oy };
  
  for (const id in state.elements) {
    const el = state.elements[id];
    if (el.type === 'note') {
      mmx.fillStyle = el.color;
      mmx.fillRect(tx(el.x), ty(el.y), el.w * sc, el.h * sc);
    } else if (el.type === 'image') {
      mmx.fillStyle = '#c8cdd8';
      mmx.fillRect(tx(el.x), ty(el.y), el.w * sc, el.h * sc);
    } else if (el.type === 'stroke') {
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
