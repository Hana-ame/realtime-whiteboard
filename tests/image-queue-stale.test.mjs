/**
 * Regression: swapping an image's dataUrl while the previous Image is still
 * sitting in the lazy-load queue must drop the stale entry.
 *
 * Bug site, src/js/renderer.js getImageObj(): the fast path
 *
 *     if (cached && cached._dataUrl === el.dataUrl) return cached;
 *
 * only short-circuits when the dataUrl is UNCHANGED. When the same element id
 * gets a NEW dataUrl, the function builds a fresh `new Image()` and overwrites
 * `imageCache[el.id]` — but the previous Image object is still sitting in
 * `imageQueue`, waiting for pumpImageQueue() to assign its `src`. Nothing
 * removed it: unqueueImage(id) is called only from clearImageCache(), which
 * fires when an element is DELETED, not when it is re-pointed at a new image.
 *
 * Two consequences, both asserted below:
 *
 *   1. Waste — the stale Image gets a `src` assignment (a full multi-MB base64
 *      parse) even though it has been evicted from imageCache and can never be
 *      painted.
 *   2. Spinner stops early — `loadingImages` is a Set keyed by element id, and
 *      the stale Image's onload/onerror handlers run `loadingImages.delete(el.id)`
 *      for the SAME id the new Image just added. The stale load therefore clears
 *      the new image's "still loading" marker, stopping the placeholder spinner
 *      while the new image is still in flight (blank/placeholder persists).
 *
 * Both are observable only while the stale entry survives in the queue, so the
 * test keeps pumpImageQueue() from draining between the two renders (the queue
 * is pumped via setTimeout, and the renderer module is imported fresh here, so
 * no pump can fire mid-test).
 *
 * Status: RED without `unqueueImage(el.id)` before the `new Image()`, GREEN
 * with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shim } from './setup.mjs';
import { state } from '../src/js/state.js';

// ── Canvas 2D recorder ───────────────────────────────────────────────────────
// render() walks the whole scene; every ctx call it makes must be a no-op that
// records nothing. A Proxy returning a chainable sink keeps that true without
// enumerating the 2D API surface.

function makeCtx() {
  const sink = () => sink;
  return new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'canvas') return { width: 0, height: 0 };
      // createPattern() must return an opaque handle; drawGrid stores it as
      // gridPattern and passes it back to ctx.fillStyle later.
      if (prop === 'createPattern') return () => ({ __pattern: true });
      return sink;
    },
    set: () => true,
  });
}

/**
 * getGridTile() builds an offscreen canvas via document.createElement('canvas');
 * the stock shim's getContext() returns null. Patch createElement so every
 * <canvas> — real or offscreen — hands back the recorder context.
 */
function installCanvasCtx() {
  const origCreate = shim.document.createElement;
  shim.document.createElement = (tag) => {
    const el = origCreate.call(shim.document, tag);
    if (String(tag).toLowerCase() === 'canvas') el.getContext = () => makeCtx();
    return el;
  };
  for (const id of ['board', 'mm']) shim.dom.getElementById(id).getContext = () => makeCtx();
}

/** Every Image the code under test constructed, in order. */
const createdImages = [];
class RecordingImage {
  constructor() {
    this._src = '';
    this.complete = false;
    this.naturalWidth = 0;
    this.onload = null;
    this.onerror = null;
    this.srcAssignments = 0;
    createdImages.push(this);
  }
  set src(v) { this._src = v; this.srcAssignments++; }
  get src() { return this._src; }
}

/** requestAnimationFrame callbacks queued (the spinner's self-rescheduling loop). */
let rafCalls = [];
/** cancelAnimationFrame calls — the direct signal that the spinner loop was torn down. */
let cancelCalls = 0;
function installRafRecorder() {
  rafCalls = [];
  cancelCalls = 0;
  globalThis.requestAnimationFrame = (fn) => { rafCalls.push(fn); return rafCalls.length; };
  globalThis.cancelAnimationFrame = () => { cancelCalls++; };
}

// renderNow is bound to the freshly imported renderer's requestRender below.
let renderNow = () => {};

const PNG_A = 'data:image/png;base64,AAAA';
const PNG_B = 'data:image/png;base64,BBBB';
const PNG_C = 'data:image/png;base64,CCCC';

test('swapping an image drops the stale queued entry and keeps the spinner alive', async () => {
  const prevImage = globalThis.Image;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancelRaf = globalThis.cancelAnimationFrame;
  globalThis.Image = RecordingImage;

  try {
    installRafRecorder();

    // Fresh module instance so imageQueue / loadingImages start empty.
    const renderer = await import(`../src/js/renderer.js?v=${Date.now()}`);
    const { initRenderer, requestRender, clearImageCache } = renderer;

    installCanvasCtx();
    initRenderer();

    // renderer.requestRender() defers render() into requestAnimationFrame; drive
    // that callback synchronously. The spinner's self-rescheduling tick must NOT
    // run synchronously (it would recurse forever), so only the FIRST rAF of a
    // render pass is executed inline and everything after it is just recorded.
    renderNow = () => {
      let ran = false;
      globalThis.requestAnimationFrame = (fn) => {
        rafCalls.push(fn);
        if (!ran) { ran = true; fn(0); }
        return rafCalls.length;
      };
      requestRender();
      globalThis.requestAnimationFrame = (fn) => { rafCalls.push(fn); return rafCalls.length; };
    };

    state.W = 1280;
    state.H = 800;
    state.view.x = 0;
    state.view.y = 0;
    state.view.scale = 1;

    const el = { id: 'IMG1', type: 'image', x: 40, y: 40, w: 200, h: 150, z: 0 };
    state.elements = { IMG1: { ...el, dataUrl: PNG_A } };

    // --- render #1: first view of the image, Image #1 created + queued -------
    renderNow();
    assert.equal(createdImages.length, 1, 'first render creates one Image');
    const img1 = createdImages[0];
    assert.equal(img1.srcAssignments, 0, 'img1 is queued, not yet assigned (pump is deferred)');

    // --- swap twice while img1 is still queued (the reported scenario) ---------
    state.elements.IMG1.dataUrl = PNG_B;
    renderNow();
    assert.equal(createdImages.length, 2, 'second render creates a second Image');
    const img2 = createdImages[1];

    // ...and a third, still with img1 pending, to show the fix is not a
    // one-shot: every superseded Image must be dropped, not just the first.
    state.elements.IMG1.dataUrl = PNG_C;
    renderNow();
    assert.equal(createdImages.length, 3, 'third render creates a third Image');
    const img3 = createdImages[2];

    // Let the queue pump run, then assert what got a src assignment.
    // (pumpImageQueue is internal; it runs via setTimeout — flush it.)
    await new Promise(r => setTimeout(r, 5));

    const assigned = createdImages.filter(i => i.srcAssignments > 0);
    assert.deepEqual(
      assigned.map(i => i._src),
      [PNG_C],
      'only the CURRENT image gets its src assigned — every stale entry is dropped, not parsed',
    );

    // Superseded Images must never be handed a src at all.
    assert.equal(img1.srcAssignments, 0, 'stale img1 never had src assigned (no wasted multi-MB parse)');
    assert.equal(img2.srcAssignments, 0, 'stale img2 never had src assigned (no wasted multi-MB parse)');
    assert.equal(img3.srcAssignments, 1, 'the live image is assigned exactly once');

    // --- spinner regression, mechanism as actually fixed ----------------------
    // The bug is that the stale Image is STILL LOADABLE: pumpImageQueue() gives
    // it a src, the browser parses it and fires its onload, and that onload runs
    // `loadingImages.delete(el.id)` for the SAME id the new Image just added —
    // so the new image's "still loading" marker is wiped and the placeholder
    // spinner stops while the new image is still in flight.
    //
    // The fix cuts the causal chain at the head: the stale Image never receives
    // a src, so it can never load, so its onload can never fire. Asserting
    // "calling the stale onload by hand must not cancel" would be asserting a
    // property the fix does NOT provide (the handler is still id-keyed), and it
    // would fail for a reason unrelated to the queue. The honest assertion is
    // the reachability one above: img1.srcAssignments === 0 means the stale
    // onload is unreachable, which is what keeps the spinner honest.
    //
    // Counter-check: once the stale entry is unreachable, the live image's own
    // load genuinely stops the spinner — the animation timing is unchanged.
    cancelCalls = 0;
    img3.onload && img3.onload();
    assert.equal(cancelCalls, 1, 'the real onload stops the spinner once loading is genuinely done');

    clearImageCache('IMG1');
    state.elements = {};
  } finally {
    globalThis.Image = prevImage;
    globalThis.requestAnimationFrame = prevRaf;
    globalThis.cancelAnimationFrame = prevCancelRaf;
  }
});
