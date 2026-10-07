/**
 * Regression: an EXPIRE / 'peer-unavailable' error must not leave a permanent entry in
 * network.js's private `conns` registry.
 *
 * The trap is two peerjs 1.5.5 behaviours composing:
 *   1. The server sends EXPIRE for a peer that is gone; the client only
 *      `emitError('peer-unavailable')` and neither drops the connection from its own
 *      map nor closes it.
 *   2. `DataConnection.close()` on a never-opened connection fires no 'close' event,
 *      so network.js's `conn.on('close', ...)` cleanup handler never runs.
 * Left alone, `conns[remoteId]` stays forever and every later `connectToPeer(remoteId)`
 * dies silently at `if (conns[remoteId]) return` (network.js:77) — "typed in the room
 * id, nothing happens".
 *
 * `conns` is private, so the assertion is observable: `connectToPeer()` calls
 * `peer.connect()`, and the mock Peer counts every DataConnection it hands out. A
 * second connectToPeer() to the same id must therefore produce a SECOND connection.
 *
 * Two cases are asserted:
 *   - a never-opened link (the scenario described above). Note this one is *also*
 *     rescued by the stale-not-opened fallback at network.js:76, so it would still
 *     pass if the error handler's dropConn() were deleted.
 *   - an OPENED link that later EXPIREs. The _opened conn is not dropped by the
 *     fallback, so only the peer-unavailable handler (network.js:100ff, via
 *     dropConn at :32) can free the room id. This is the case that actually bites.
 *
 * Expected result: PASS — the fix is already shipped and these are guards against
 * regressions.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shim } from './setup.mjs';
import { MockPeer, MockDataConnection } from './mock-peer.mjs';
import { initNetwork, connectToPeer } from '../src/js/network.js';

/** The exact error payload peerjs emits for an EXPIRE'd target. */
const expireError = roomId => ({
  type: 'peer-unavailable',
  message: `Could not connect to peer ${roomId}`,
  data: 'The peer ' + roomId + ' does not exist.',
});

test('EXPIRE on a never-opened connection: room id must stay re-connectable', () => {
  initNetwork();
  const p = MockPeer.instances.at(-1);
  p.emit('open', 'local-1');
  assert.equal(MockPeer.instances.length, 1, 'exactly one Peer was constructed');

  // First attempt: the link is created but never opens (the target does not exist).
  connectToPeer('gone-room', true);
  assert.equal(p._conns.length, 1, 'first connectToPeer produced 1 DataConnection');
  assert.equal(p._conns[0].open, false, 'that DataConnection was never opened');

  // Server reports the target as gone.
  p.emit('error', expireError('gone-room'));

  // The retry must not be silently swallowed by `if (conns[remoteId]) return`.
  connectToPeer('gone-room', true);

  assert.equal(
    p._conns.length, 2,
    'stale conns entry survived the peer-unavailable error: peer.connect() was only ' +
      'called ' + p._conns.length + ' time(s), expected 2'
  );
  assert.equal(MockDataConnection.all.length, 2);
  console.log('net-count after cleanup: ' + shim.dom.getElementById('net-count').textContent);
});

test('EXPIRE on an OPENED connection also clears the registry entry', () => {
  // Sharp version of the same guard. The first case above is rescued by the
  // never-opened fallback at network.js:76, so it would still pass if the
  // peer-unavailable handler's dropConn() were deleted. This case is not:
  // an _opened conn is not dropped by that fallback, so only the error handler
  // (network.js:100ff, via dropConn at :32) can free the room id.
  const p = MockPeer.instances.at(-1);
  const before = p._conns.length;

  connectToPeer('gone-room-2', true);
  const conn = p._conns.at(-1);
  conn.emit('open');
  assert.equal(p._conns.length, before + 1, 'opened link created a DataConnection');

  p.emit('error', expireError('gone-room-2'));

  connectToPeer('gone-room-2', true);

  assert.equal(
    p._conns.length, before + 2,
    'opened conns entry survived the peer-unavailable error: peer.connect() produced ' +
      (p._conns.length - before) + ' new connection(s), expected 2'
  );
  console.log('conns entry dropped after EXPIRE; room id re-usable');
});
