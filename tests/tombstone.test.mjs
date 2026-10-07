/**
 * Regression: a deleted element must not be resurrected by a stale fullSync.
 *
 * Bug site at HEAD (b49d5dc), src/js/network.js:362 — `tombstones.delete(id)` inside
 * the `m.t === 'state'` / `m.fullSync` merge branch. The tombstone set is the *only*
 * thing standing between a peer and a stale copy of an element it already deleted, and
 * that single line cleared it unconditionally whenever the sync payload happened to
 * contain the id — even when the sender never heard about the local delete.
 * Combined with `if (!cur || ...)` on the very next line, the deleted element was
 * straight back on the canvas.
 *
 * The fix (working tree) replaces that line with `if (tombstones.has(id)) continue;`
 * at network.js:390 and moves `tombstones` into state.js, which is also what lets a
 * *locally* deleted element be tombstoned (the old code only recorded tombstones for
 * deletes received over the wire).
 *
 * Topology: the process under test is peer B (the one real network.js instance).
 * Peer A is a MockDataConnection whose 'data' event we drive with A's outbound
 * messages. handleMsg() does not inspect the sender for upsert/delete/state, so that
 * is a faithful delivery path.
 *
 * Status: RED against HEAD (documents the bug), GREEN against the fix. Asserted
 * observable is state.elements, so the test works whether or not `tombstones` is
 * exported from state.js.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shim } from './setup.mjs';
import { MockPeer } from './mock-peer.mjs';
import { initNetwork, connectToPeer } from '../src/js/network.js';
import { state } from '../src/js/state.js';

const EL_X = { id: 'X', type: 'note', text: 'hello', x: 10, y: 20, w: 170, h: 120, rev: 1 };

test('fullSync must not resurrect an element that this peer deleted', () => {
  // --- boot B -------------------------------------------------------------
  initNetwork();
  const peerB = MockPeer.instances.at(-1);
  peerB.emit('open', 'peer-B');

  // --- A connects to B, and the link actually opens -----------------------
  connectToPeer('peer-A', true);
  const connA = peerB._conns.at(-1);
  assert.equal(connA.peer, 'peer-A', 'connectToPeer produced a link to peer-A');
  connA.emit('open');
  assert.equal(connA.open, true, 'A<->B link is open');

  /** Deliver one of A's outbound messages into B's real handleMsg(). */
  const fromA = msg => connA.emit('data', msg);

  // 1) A upserts X; B receives it.
  fromA({ t: 'upsert', el: { ...EL_X } });
  assert.equal(
    state.elements.X && state.elements.X.text, 'hello',
    'step 1: B should have received A\'s X'
  );
  assert.equal(shim.dom.getElementById('net-count').textContent, '同屏中: 2人');

  // 2) B learns X was deleted -> handleMsg('delete') adds the tombstone and
  //    removes the element locally.
  fromA({ t: 'delete', id: 'X' });
  assert.equal(
    state.elements.X, undefined,
    'step 2: B should have deleted X locally (elements.X=' +
      JSON.stringify(state.elements.X) + ')'
  );

  // 3) A never heard the delete, so its fullSync still carries X.
  fromA({ t: 'state', fullSync: true, elements: { X: { ...EL_X } } });

  // The tombstone was cleared by network.js:362 and `!cur` at :363 re-inserted X.
  assert.equal(
    state.elements.X, undefined,
    'REGRESSION (network.js:362 `tombstones.delete(id)`): deleted element X was ' +
      'resurrected by a fullSync. actual elements.X=' + JSON.stringify(state.elements.X) +
      ', expected undefined'
  );
});
