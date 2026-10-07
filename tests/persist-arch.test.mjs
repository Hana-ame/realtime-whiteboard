/**
 * Persistence-architecture tests for the "localStorage holds ONLY my own room's
 * canvas" contract:
 *
 *   1. persist() is a no-op while state.persistable is false (someone else's
 *      room), so canvases received via peerjs never touch localStorage.
 *   2. Entering another room — URL #room=, manual remoteId, hashchange — flips
 *      persistable=false; returning to one's own room (hash cleared) flips it
 *      back and re-persists only one's own elements.
 *   3. state.__mut is bumped on structural changes (add/remove/re-z/undo/redo/
 *      fullSync) and NOT on in-place geometry edits, so renderer caches
 *      (sortedIds / contentBounds) can rely on it.
 *
 * Unlike room-persist.test.mjs this file drives real handleMsg()/persist()
 * paths and asserts against real localStorage contents.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shim } from './setup.mjs';
import { MockPeer } from './mock-peer.mjs';
import { initNetwork, connectToPeer } from '../src/js/network.js';
import {
  state, persist, pushUndo, upsert, removeEl, bringToFront, undo, redo,
  setPersistKey,
} from '../src/js/state.js';

/** Fire the most recently registered window 'hashchange' listener. */
function fireHashchange() {
  const handlers = shim.window._listeners.get('hashchange');
  assert.ok(handlers && handlers.length > 0, 'a hashchange listener must be registered');
  handlers[handlers.length - 1]();
}

test('persist() writes only while the canvas is persistable', () => {
  setPersistKey('wb-elements-v2:gate-test');
  localStorage.clear();
  state.persistable = true;
  state.elements = { A: { id: 'A', type: 'note', x: 1, y: 2, w: 10, h: 10 } };
  persist();
  const first = localStorage.getItem('wb-elements-v2:gate-test');
  assert.equal(first, JSON.stringify(state.elements), 'persistable=true → written');

  state.persistable = false;
  state.elements = {
    ...state.elements,
    B: { id: 'B', type: 'note', x: 3, y: 4, w: 10, h: 10 },
  };
  persist();
  assert.equal(
    localStorage.getItem('wb-elements-v2:gate-test'), first,
    'persistable=false → localStorage untouched (foreign canvas must never be stored)'
  );

  state.elements = {};
  state.persistable = true;
});

test('__mut bumps on structural changes but not on in-place edits', () => {
  state.persistable = true;
  state.elements = {};
  state.__mut = 0; // counter is only read by renderer caches — safe to reset here
  const m0 = state.__mut;

  upsert({ id: 'A', type: 'note', x: 1, y: 2, w: 10, h: 10, rev: 0, z: 0 });
  assert.equal(state.__mut, m0 + 1, 'upsert (add) bumps');

  upsert({ id: 'A', type: 'note', x: 9, y: 2, w: 10, h: 10, rev: 0, z: 0 });
  assert.equal(state.__mut, m0 + 2, 'upsert (update same id) bumps');

  state.elements.A.x = 42; // live-drag style in-place edit
  assert.equal(state.__mut, m0 + 2, 'in-place geometry edit does NOT bump');

  bringToFront('A'); // already on top → early return
  assert.equal(state.__mut, m0 + 2, 'bringToFront with no z change does NOT bump');

  upsert({ id: 'B', type: 'note', x: 3, y: 4, w: 10, h: 10, rev: 0, z: 0 });
  assert.equal(state.__mut, m0 + 3, 'adding a second element bumps');

  state.elements.A.z = 5; // in-place re-z, committed later via upsert
  assert.equal(state.__mut, m0 + 3, 'in-place z edit does NOT bump');

  bringToFront('B'); // B is below A → z changes → upsert bumps
  assert.equal(state.__mut, m0 + 4, 'bringToFront with real z change bumps');

  removeEl('B');
  assert.equal(state.__mut, m0 + 5, 'removeEl bumps');

  pushUndo(); // no structural change
  assert.equal(state.__mut, m0 + 5, 'pushUndo does NOT bump');

  upsert({ id: 'C', type: 'note', x: 5, y: 6, w: 10, h: 10, rev: 0 });
  assert.equal(state.__mut, m0 + 6, 'upsert (add C) bumps');

  undo();
  assert.equal(state.__mut, m0 + 7, 'undo bumps (wholesale replacement)');

  redo();
  assert.equal(state.__mut, m0 + 8, 'redo bumps (wholesale replacement)');

  state.elements = {};
});

test('manual remoteId join flips the canvas to non-persistable', () => {
  localStorage.setItem('wb-peer-id', 'own-1');
  initNetwork();
  const p = MockPeer.instances.at(-1);
  p.emit('open', 'own-1');
  assert.equal(state.persistable, true, 'own room starts persistable');

  shim.dom.getElementById('remote-id').value = 'friend-room-a';
  const btn = shim.dom.getElementById('connect-btn');
  const click = btn._listeners.get('click');
  click[click.length - 1]();
  assert.equal(state.persistable, false, 'manual join to another room → non-persistable');
  assert.equal(p._conns.at(-1).peer, 'friend-room-a', 'connection to the target was initiated');
});

test('URL room= joiner (onPeerOpen) becomes non-persistable, reads/writes nothing', () => {
  shim.window.location.hash = '#room=friend-room-b';
  try {
    localStorage.setItem('wb-peer-id', 'own-2');
    initNetwork();
    const p = MockPeer.instances.at(-1);
    p.emit('open', 'own-2');
    assert.equal(state.persistable, false, 'URL room= join → non-persistable');
    assert.equal(p._conns.at(-1).peer, 'friend-room-b', 'auto-connected to the URL room');
    assert.equal(
      localStorage.getItem('wb-elements-v2:friend-room-b'), null,
      'the foreign room key is never written'
    );
  } finally {
    shim.window.location.hash = '';
  }
});

test('received fullSync/upsert/delete never touch localStorage while non-persistable', () => {
  setPersistKey('wb-elements-v2:my-key-5');
  localStorage.clear();
  state.persistable = true;
  state.elements = {};

  localStorage.setItem('wb-peer-id', 'own-3');
  initNetwork();
  const p = MockPeer.instances.at(-1);
  p.emit('open', 'own-3');
  connectToPeer('remote-5', true);
  const conn = p._conns.at(-1);
  conn.emit('open');

  state.persistable = false; // simulate being inside someone else's room
  const foreignNote = (id, text) =>
    ({ id, type: 'note', x: 1, y: 2, w: 10, h: 10, text, rev: 1, cid: 'remote-5' });

  // __mut must keep tracking structural changes delivered over the wire too.
  const m0 = state.__mut;

  conn.emit('data', { t: 'state', fullSync: true, elements: { X: foreignNote('X', 'foreign') } });
  assert.equal(state.elements.X.text, 'foreign', 'fullSync content lands in memory');
  assert.equal(
    localStorage.getItem('wb-elements-v2:my-key-5'), null,
    'fullSync from another room is never written to localStorage'
  );
  assert.equal(state.__mut, m0 + 1, 'fullSync merge bumps __mut');

  conn.emit('data', { t: 'upsert', el: foreignNote('Y', 'foreign2') });
  assert.equal(state.elements.Y.text, 'foreign2', 'upsert content lands in memory');
  assert.equal(
    localStorage.getItem('wb-elements-v2:my-key-5'), null,
    'upsert from another room is never written to localStorage'
  );
  assert.equal(state.__mut, m0 + 2, 'remote upsert (new element) bumps __mut');

  // bringToFront is broadcast as a plain upsert carrying a new z on an EXISTING
  // element — a winning replacement must invalidate the sortedIds cache too.
  conn.emit('data', { t: 'upsert', el: { ...foreignNote('Y', 'foreign3'), rev: 2, z: 42 } });
  assert.equal(state.elements.Y.z, 42, 'remote re-z applied');
  assert.equal(state.__mut, m0 + 3, 'remote upsert carrying a z change bumps __mut');

  conn.emit('data', { t: 'delete', id: 'X' });
  assert.equal(state.elements.X, undefined, 'delete still applies in memory');
  assert.equal(
    localStorage.getItem('wb-elements-v2:my-key-5'), null,
    'delete from another room is never written to localStorage'
  );

  state.elements = {};
  state.persistable = true;
});

test('hashchange: switching to another room stops persistence; coming back restores own canvas', () => {
  localStorage.setItem('wb-peer-id', 'own-room');
  shim.window.location.hash = '';
  initNetwork();
  const p = MockPeer.instances.at(-1);
  p.emit('open', 'own-room');
  assert.equal(state.persistable, true, 'own room is persistable');

  const mine = { M: { id: 'M', type: 'note', x: 10, y: 20, w: 30, h: 30, rev: 0 } };
  state.elements = mine;
  state.persistable = true;
  persist();
  const ownSnapshot = JSON.stringify(mine);
  assert.equal(localStorage.getItem('wb-elements-v2:own-room'), ownSnapshot, 'own canvas stored');

  // --- switch to another room ---------------------------------------------
  shim.window.location.hash = '#room=other-room';
  fireHashchange();
  assert.equal(state.persistable, false, 'other room → non-persistable');
  assert.deepEqual(state.elements, {}, 'canvas cleared, waits for network fullSync');
  assert.equal(
    localStorage.getItem('wb-elements-v2:other-room'), null,
    'the other room key is never touched'
  );
  assert.equal(
    localStorage.getItem('wb-elements-v2:own-room'), ownSnapshot,
    'own canvas is still intact under the own-room key'
  );

  // --- come back to own room (hash cleared) -------------------------------
  shim.window.location.hash = '';
  fireHashchange();
  assert.equal(state.persistable, true, 'own room restored → persistable again');
  assert.deepEqual(state.elements, JSON.parse(ownSnapshot), 'own canvas loaded back');
  assert.equal(
    localStorage.getItem('wb-elements-v2:own-room'), ownSnapshot,
    'own canvas re-persisted to the own-room key'
  );

  state.elements = {};
});