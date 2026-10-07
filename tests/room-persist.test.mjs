/**
 * Room-persistence tests for src/js/network.js.
 *
 * Covers the persistence lifecycle:
 *   1. localStorage 'wb-peer-id' is read on initNetwork() and written back on
 *      open when the peer was booted from storage (fromStorage=true path).
 *   2. On first visit (no stored value), the random ID is written to
 *      localStorage so it is reused on refresh.
 *   3. URL hash #room=xxx triggers an automatic connectToPeer on open.
 *   4. 'unavailable-id' errors trigger a retry chain with 1.2 s backoff; after
 *      retries exhaust (4th error), a modal dialog is shown for user choice.
 *   5. Modal "Retry Original Room" button creates a new peer with the
 *      original ID (no localStorage change).
 *   6. Modal "Use New Room" button creates a new peer with a random ID and
 *      writes it to localStorage (via the _forceSaveId flag).
 *
 * What is NOT testable in Node (marked as browser-only below):
 *   - The modal's interactive behaviour (overlay animation, button hover
 *     states, z-index stacking, keyboard accessibility). The shim in
 *     tests/setup.mjs returns recording-only element stubs, so DOM presence
 *     and event-handler registration can be asserted (as in the tests above),
 *     but visual/interaction state cannot.
 *   - The real-time feel of the 1.2 s backoff delays. The test uses
 *     t.mock.timers to advance time in milliseconds instead of waiting for
 *     ~4.8 s of real wall-clock time.
 *
 * Timer management: the 1.2 s retry backoff is tested with t.mock.timers
 * (Node 20.12+), so the retry tests run in a few milliseconds.
 *
 * NOTE: the shim's makeEl() hardcodes tagName='DIV' for every createElement()
 * call, so we locate modal buttons by the presence of 'click' event listeners
 * rather than by tag name.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shim } from './setup.mjs';
import { MockPeer } from './mock-peer.mjs';
import { initNetwork } from '../src/js/network.js';

/** The exact error payload peerjs emits when the requested ID is taken. */
const unavailableIdError = { type: 'unavailable-id', message: 'ID taken' };

/**
 * Recursively find all descendant elements that have a 'click' event listener
 * registered. The shim's makeEl() sets tagName='DIV' for every createElement()
 * call, so we cannot search by tag name.
 */
function findAllClickable(el) {
  const results = [];
  if (el && el._listeners && el._listeners.has('click')) results.push(el);
  if (el && el.children) {
    for (const child of el.children) {
      results.push(...findAllClickable(child));
    }
  }
  return results;
}

/** Get the first 'click' handler registered on an element, or null. */
function getClickHandler(el) {
  const handlers = el._listeners && el._listeners.get('click');
  return handlers && handlers[0];
}

test('stored peer id is preserved in localStorage after open', () => {
  localStorage.setItem('wb-peer-id', 'stored-room-1');
  const before = MockPeer.instances.length;
  initNetwork();

  assert.equal(MockPeer.instances.length, before + 1, 'initNetwork created exactly one new Peer');
  const p = MockPeer.instances.at(-1);
  assert.equal(p.id, 'stored-room-1', 'the stored id was passed to the Peer constructor');

  p.emit('open', 'stored-room-1');

  assert.equal(
    localStorage.getItem('wb-peer-id'), 'stored-room-1',
    'localStorage still holds the stored peer id after open (fromStorage=true path)'
  );
  assert.match(
    shim.dom.getElementById('my-id').textContent, /stored-room-1/,
    'the my-id UI element shows the stored peer id'
  );
});

test('random peer id on first visit IS written to localStorage', () => {
  localStorage.removeItem('wb-peer-id');
  const before = MockPeer.instances.length;
  initNetwork();

  const p = MockPeer.instances.at(-1);
  assert.equal(p.id, undefined, 'bootPeer was called with undefined id when no stored value exists');

  p.emit('open', 'random-abc-123');

  // First-visit fix: even a random ID is written to localStorage so the
  // user returns to the same room after a page refresh.
  assert.equal(
    localStorage.getItem('wb-peer-id'), 'random-abc-123',
    'localStorage is written on first visit (random ID persisted for refresh)'
  );
  assert.match(
    shim.dom.getElementById('my-id').textContent, /random-abc-123/,
    'the my-id UI element shows the random peer id'
  );
});

test('URL hash #room=xxx triggers an automatic connectToPeer on open', () => {
  shim.window.location.hash = '#room=target-room';
  try {
    localStorage.removeItem('wb-peer-id');
    const before = MockPeer.instances.length;
    initNetwork();

    const p = MockPeer.instances.at(-1);
    assert.equal(MockPeer.instances.length, before + 1, 'initNetwork created exactly one new Peer');
    p.emit('open', 'local-random-1');

    // onPeerOpen → roomFromHash() returns 'target-room' → joinRoomFromUrl → connectToPeer
    assert.equal(p._conns.length, 1, 'one DataConnection was created for the URL room');
    assert.equal(p._conns[0].peer, 'target-room', 'the connection targets the URL room id');
    assert.equal(
      shim.dom.getElementById('remote-id').value, 'target-room',
      'the remote-id input was pre-filled with the URL room id'
    );
  } finally {
    shim.window.location.hash = '';
  }
});

test('unavailable-id errors trigger retry chain then show modal', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    localStorage.setItem('wb-peer-id', 'taken-room');
    initNetwork();

    // --- Initial peer (retries=3) -----------------------------------------
    const p1 = MockPeer.instances.at(-1);
    assert.equal(p1.id, 'taken-room', 'first peer used the stored id');

    // --- Retry 1: retries=3 → schedules bootPeer(id, 2) after 1200ms ------
    p1.emit('error', unavailableIdError);
    t.mock.timers.tick(1200);
    const p2 = MockPeer.instances.at(-1);
    assert.notEqual(p2, p1, 'retry 1 created a new Peer instance');
    assert.equal(p2.id, 'taken-room', 'retry 1 reused the stored id');

    // --- Retry 2: retries=2 → schedules bootPeer(id, 1) after 1200ms ------
    p2.emit('error', unavailableIdError);
    t.mock.timers.tick(1200);
    const p3 = MockPeer.instances.at(-1);
    assert.notEqual(p3, p2, 'retry 2 created a new Peer instance');
    assert.equal(p3.id, 'taken-room', 'retry 2 reused the stored id');

    // --- Retry 3: retries=1 → schedules bootPeer(id, 0) after 1200ms ------
    p3.emit('error', unavailableIdError);
    t.mock.timers.tick(1200);
    const p4 = MockPeer.instances.at(-1);
    assert.notEqual(p4, p3, 'retry 3 created a new Peer instance');
    assert.equal(p4.id, 'taken-room', 'retry 3 (retries=0) still uses the stored id');

    // --- 4th error: retries=0 → shows modal (no new peer) -----------------
    p4.emit('error', unavailableIdError);

    // Modal should be appended to document.body
    const body = shim.dom.getElementById('body');
    assert.equal(body.children.length, 1, 'modal overlay was appended to body');
    const overlay = body.children[0];
    assert.equal(overlay.id, 'room-conflict-modal', 'modal overlay has the expected id');

    // localStorage should be unchanged — the modal does not auto-fallback
    assert.equal(
      localStorage.getItem('wb-peer-id'), 'taken-room',
      'localStorage is NOT overwritten while the modal is shown'
    );

    // The modal should have two clickable elements (buttons) with click handlers
    const buttons = findAllClickable(overlay);
    assert.equal(buttons.length, 2, 'modal has two clickable elements (buttons)');
    assert.equal(buttons[0].textContent, '重试原房间', 'first button is "Retry Original Room"');
    assert.equal(buttons[1].textContent, '使用新房间号', 'second button is "Use New Room"');

    console.log('retry chain: 4 peers created, modal shown, localStorage preserved');
  } finally {
    t.mock.timers.reset();
  }
});

test('modal "Retry Original Room" button creates a new peer with the original ID', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Clear any modals left over from previous tests (showRoomConflictModal
    // doesn't fully clean up because document.getElementById creates a dummy
    // element instead of finding the real one in the DOM tree).
    shim.dom.getElementById('body').children.length = 0;
    localStorage.setItem('wb-peer-id', 'taken-room');
    initNetwork();

    // Exhaust retries to show the modal
    for (let i = 0; i < 4; i++) {
      MockPeer.instances.at(-1).emit('error', unavailableIdError);
      if (i < 3) t.mock.timers.tick(1200);
    }

    // Find the modal and click the retry button (first clickable element)
    const body = shim.dom.getElementById('body');
    const overlay = body.children[0];
    const buttons = findAllClickable(overlay);
    const before = MockPeer.instances.length;

    getClickHandler(buttons[0])();  // click "重试原房间"

    // The modal should be removed from the DOM
    assert.equal(body.children.length, 0, 'modal was removed from body after retry click');

    // A new peer should be created with the original ID and 3 retries
    assert.equal(MockPeer.instances.length, before + 1, 'retry click created a new Peer');
    const newPeer = MockPeer.instances.at(-1);
    assert.equal(newPeer.id, 'taken-room', 'retry click reused the original room id');

    // localStorage should be unchanged
    assert.equal(
      localStorage.getItem('wb-peer-id'), 'taken-room',
      'localStorage is unchanged after retry click'
    );
  } finally {
    t.mock.timers.reset();
  }
});

test('modal "Use New Room" button writes new random ID to localStorage', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // Clear any modals left over from previous tests.
    shim.dom.getElementById('body').children.length = 0;
    localStorage.setItem('wb-peer-id', 'taken-room');
    initNetwork();

    // Exhaust retries to show the modal
    for (let i = 0; i < 4; i++) {
      MockPeer.instances.at(-1).emit('error', unavailableIdError);
      if (i < 3) t.mock.timers.tick(1200);
    }

    // Find the modal and click the fallback button (second clickable element)
    const body = shim.dom.getElementById('body');
    const overlay = body.children[0];
    const buttons = findAllClickable(overlay);
    const before = MockPeer.instances.length;

    getClickHandler(buttons[1])();  // click "使用新房间号"

    // The modal should be removed from the DOM
    assert.equal(body.children.length, 0, 'modal was removed from body after fallback click');

    // A new peer should be created with undefined (random) ID
    assert.equal(MockPeer.instances.length, before + 1, 'fallback click created a new Peer');
    const newPeer = MockPeer.instances.at(-1);
    assert.equal(newPeer.id, undefined, 'fallback click created a peer with random (undefined) id');

    // localStorage should still have the old value (peer not yet open)
    assert.equal(
      localStorage.getItem('wb-peer-id'), 'taken-room',
      'localStorage is unchanged before the new peer opens'
    );

    // Simulate the new peer opening
    newPeer.emit('open', 'new-random-456');

    // _forceSaveId was set to true by the fallback handler, so onPeerOpen
    // writes the new ID to localStorage even though fromStorage=false.
    assert.equal(
      localStorage.getItem('wb-peer-id'), 'new-random-456',
      'localStorage is updated with the new random ID (via _forceSaveId)'
    );
  } finally {
    t.mock.timers.reset();
  }
});

// MARKED BROWSER-ONLY: the modal's interactive behaviour (overlay animation,
// button hover states, z-index stacking, keyboard accessibility) requires a
// real DOM to observe. The shim in tests/setup.mjs returns recording-only
// element stubs, so DOM presence and event-handler registration can be
// asserted (as in the tests above), but visual/interaction state cannot.
test.skip('modal interactive behaviour (BROWSER-ONLY)', () => {
  // Requires: real DOM, CSS rendering, z-index, hover states, keyboard nav.
  // The shim records getElementById writes and addEventListener calls, so
  // the modal's DOM structure and event handlers are verified in the tests
  // above. Visual and interaction tests need a headless browser (Puppeteer).
});
