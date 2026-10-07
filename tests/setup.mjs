/**
 * Test bootstrap: `node --import ./tests/setup.mjs --test "tests/*.test.mjs"`.
 *
 * Two jobs, in this order:
 *
 * 1. Install browser globals on globalThis BEFORE any src/ module is imported.
 *    src/js/renderer.js line 10 is `export const DPR = Math.max(1, window.devicePixelRatio || 1)`
 *    — a bare `window` read at module-evaluation time, so the shim must exist before
 *    network.js's import graph is loaded.
 * 2. `register()` the ESM hooks module, which resolves the bare 'peerjs' specifier
 *    (src/js/network.js line 1) to tests/mock-peer.mjs so the real library is never
 *    linked or instantiated.
 *
 * What the shim deliberately does NOT do: it never makes src/ code succeed. Every
 * `getElementById()` returns a throwaway element that only records writes, so a test
 * can read `shim.dom.getElementById('net-count').textContent` to observe what the
 * real UI code would have painted.
 *
 * `setInterval`/`clearInterval` are neutralised: network.js registers a 4 s presence
 * broadcast and a 5 s pruneStaleConns() sweep from initNetwork(), and live timers
 * would pin the test runner's event loop open.
 */

import { register } from 'node:module';

/* ---------------------------------------------------------------- DOM stubs */

function makeEl(id) {
  const el = {
    id,
    tagName: 'DIV',
    textContent: '',
    innerHTML: '',
    value: '',
    className: '',
    title: '',
    checked: false,
    dataset: {},
    style: {},
    children: [],
    parentNode: null,
    _listeners: new Map(),

    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    dispatchEvent() { return true; },
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    replaceChild(next, prev) {
      const i = this.children.indexOf(prev);
      if (i >= 0) this.children[i] = next;
      next.parentNode = this;
      prev.parentNode = null;
      return prev;
    },
    insertBefore(child) { this.children.unshift(child); return child; },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    insertAdjacentHTML() {},
    closest() { return null; },
    focus() {},
    blur() {},
    click() {},
    select() {},
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    hasAttribute() { return false; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() {
      return { left: 0, right: 0, top: 0, bottom: 0, x: 0, y: 0, width: 0, height: 0 };
    },
    getContext() { return null; },
  };
  return el;
}

function installBrowserShims() {
  const byId = new Map();

  const document = {
    readyState: 'complete',
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl(id));
      return byId.get(id);
    },
    createElement(tag) { return makeEl(String(tag).toUpperCase()); },
    createElementNS(_, tag) { return makeEl(String(tag).toUpperCase()); },
    createTextNode(text) { return { nodeValue: text, textContent: text }; },
    createComment(text) { return { text }; },
    createDocumentFragment() { return makeEl('#fragment'); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  document.body = document.getElementById('body');
  document.documentElement = document.getElementById('html');
  document.head = document.getElementById('head');

  const window = {
    devicePixelRatio: 2,
    innerWidth: 1280,
    innerHeight: 800,
    scrollX: 0,
    scrollY: 0,
    location: { hash: '', href: 'http://localhost:5173/', search: '', pathname: '/' },
    // Record handlers (like makeEl) so tests can fire e.g. the hashchange
    // listener network.js registers — needed to exercise room switching.
    _listeners: new Map(),
    addEventListener(type, fn) {
      if (!this._listeners.has(type)) this._listeners.set(type, []);
      this._listeners.get(type).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this._listeners.get(type);
      if (!list) return;
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    scrollTo() {},
    scroll() {},
    focus() {},
    close() {},
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
    },
  };

  const store = new Map();
  const localStorage = {
    getItem(key) { return store.has(key) ? store.get(key) : null; },
    setItem(key, val) { store.set(String(key), String(val)); },
    removeItem(key) { store.delete(key); },
    clear() { store.clear(); },
    get length() { return store.size; },
    key(i) { return [...store.keys()][i] ?? null; },
  };

  class Image {
    constructor() { this._src = ''; this.onload = null; this.onerror = null; }
    set src(v) { this._src = v; }
    get src() { return this._src; }
  }

  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.Image = Image;
  if (typeof globalThis.requestAnimationFrame !== 'function') {
    // No-op so renderer.js's requestRender() never schedules render()/drawMinimap(),
    // which would reach into canvas 2D context API that is out of scope here.
    globalThis.requestAnimationFrame = () => 0;
  }
  if (typeof globalThis.cancelAnimationFrame !== 'function') globalThis.cancelAnimationFrame = () => {};
  // Keep node's own performance (node --test relies on it).
  if (!globalThis.performance) globalThis.performance = { now: () => Date.now() };

  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};

  return { dom: { byId, getElementById: id => document.getElementById(id) }, localStorage, window, document };
}

export const shim = installBrowserShims();

/* --------------------------------------------------------------- loader hooks */

register(new URL('./hooks.mjs', import.meta.url).href);
