/**
 * Tests for the refactored architecture, CRDT conflict engine, EventBus,
 * BoundedSet deduplication, connection glare protection, large-payload chunking,
 * collaborative undo/redo delta sync, and leaveRoom lifecycle.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shim } from './setup.mjs';
import { MockPeer } from './mock-peer.mjs';
import { EventBus } from '../src/js/events.js';
import { BoundedSet } from '../src/js/utils.js';
import { beats, sanitizeElement, computeStateDiff } from '../src/js/crdt.js';
import { simplifyStrokePoints, rectEdgePoint } from '../src/js/geometry.js';
import {
  state, pushUndo, upsert, undo, redo, duplicateSelected, resetState, setDeps,
} from '../src/js/state.js';
import {
  initNetwork, connectToPeer, leaveRoom, broadcast, getNetworkState,
} from '../src/js/network.js';

test('EventBus supports subscribe, once, unsubscribe, and fault isolation', () => {
  const eb = new EventBus();
  const log = [];
  const off = eb.on('evt', x => log.push('a:' + x));
  eb.once('evt', x => log.push('once:' + x));
  eb.on('evt', () => { throw new Error('isolated error'); });
  eb.on('evt', x => log.push('b:' + x));

  eb.emit('evt', 1);
  assert.deepEqual(log, ['a:1', 'once:1', 'b:1']);

  off();
  eb.emit('evt', 2);
  assert.deepEqual(log, ['a:1', 'once:1', 'b:1', 'b:2']);
});

test('BoundedSet evicts oldest entries in FIFO order without full clear', () => {
  const bs = new BoundedSet(3);
  bs.add('m1').add('m2').add('m3');
  assert.equal(bs.size, 3);
  assert.ok(bs.has('m1') && bs.has('m2') && bs.has('m3'));

  // Adding m4 evicts only m1 (not m2 or m3!)
  bs.add('m4');
  assert.equal(bs.size, 3);
  assert.ok(!bs.has('m1'), 'oldest entry m1 evicted');
  assert.ok(bs.has('m2') && bs.has('m3') && bs.has('m4'), 'recent entries preserved');
});

test('CRDT beats() and computeStateDiff() produce deterministic deltas', () => {
  assert.ok(beats({ rev: 2, cid: 'A' }, { rev: 1, cid: 'Z' }));
  assert.ok(beats({ rev: 2, cid: 'B' }, { rev: 2, cid: 'A' }));
  assert.ok(!beats({ rev: 2, cid: 'A' }, { rev: 2, cid: 'B' }));

  assert.equal(sanitizeElement(null), null);
  assert.equal(sanitizeElement({ id: 'x', type: 'unknown' }), null);
  assert.ok(sanitizeElement({ id: 'n1', type: 'note' }, 'peer-1').cid === 'peer-1');

  const before = {
    A: { id: 'A', type: 'note', text: 'v1', rev: 1 },
    B: { id: 'B', type: 'note', text: 'delete-me', rev: 2 },
  };
  const after = {
    A: { id: 'A', type: 'note', text: 'v2', rev: 1 },
    C: { id: 'C', type: 'note', text: 'added', rev: 0 },
  };
  const diff = computeStateDiff(before, after, 'peer-self');
  assert.deepEqual(diff.deletes, ['B']);
  assert.equal(diff.upserts.length, 2);
  const upA = diff.upserts.find(e => e.id === 'A');
  assert.equal(upA.rev, 2, 'modified element A has bumped rev so peers accept the undo/redo');
});

test('Connection glare guard: closing a replaced stale connection does NOT evict the active connection', () => {
  initNetwork();
  const p = MockPeer.instances.at(-1);
  p.emit('open', 'me-glare');

  // Outgoing connection 1 (never opened)
  connectToPeer('peer-X', true);
  const conn1 = p._conns.at(-1);

  // Incoming connection 2 from peer-X arrives and opens
  const conn2 = p.connect('peer-X');
  p._conns.pop(); // remove from outgoing list, emit as incoming
  p.emit('connection', conn2);
  conn2.emit('open');

  // Now stale conn1 fires 'close' or 'error' late
  conn1.emit('close');
  conn1.emit('error');

  // Active conn2 must still be registered in `conns`!
  const netState = getNetworkState();
  assert.ok(
    netState.connectedPeers.includes('peer-X'),
    'active connection conn2 survived late close/error of superseded conn1'
  );
});

test('Large image payload (>48KB) is automatically chunked and reassembled across peers', () => {
  initNetwork();
  const p = MockPeer.instances.at(-1);
  p.emit('open', 'peer-receiver');

  connectToPeer('peer-sender', true);
  const conn = p._conns.at(-1);
  conn.emit('open');

  setDeps(broadcast, null, null, null);
  resetState();

  const hugeDataUrl = 'data:image/png;base64,' + 'A'.repeat(70000);
  const imgEl = {
    id: 'BIG_IMG',
    type: 'image',
    x: 10,
    y: 20,
    w: 300,
    h: 200,
    dataUrl: hugeDataUrl,
    rev: 1,
  };

  // Clear initial handshake messages
  conn._sent.length = 0;

  // Broadcast large image
  upsert(imgEl, true);

  // Verify it was split into multiple 'chunk' packets on the wire
  assert.ok(conn._sent.length >= 2, `expected >=2 chunks, got ${conn._sent.length}`);
  assert.ok(conn._sent.every(m => m.t === 'chunk'), 'every packet is a chunk frame');

  // Simulate another peer sending those chunks with a fresh message ID (`mid`)
  const rawRejoined = JSON.parse(conn._sent.map(c => c.data).join(''));
  rawRejoined.mid = 'remote-mid-999';
  const rawStr = JSON.stringify(rawRejoined);
  const remoteChunks = conn._sent.map((c, i, arr) => {
    const step = Math.ceil(rawStr.length / arr.length);
    return {
      t: 'chunk',
      chunkId: 'remote-chunk-1',
      idx: i,
      total: arr.length,
      data: rawStr.slice(i * step, (i + 1) * step),
    };
  });

  delete state.elements.BIG_IMG;
  for (const chunkMsg of remoteChunks) {
    conn.emit('data', chunkMsg);
  }

  assert.ok(state.elements.BIG_IMG, 'chunked image reassembled and inserted into state');
  assert.equal(state.elements.BIG_IMG.dataUrl.length, hugeDataUrl.length, 'dataUrl preserved intact');
});

test('Collaborative undo/redo broadcasts incremental upsert/delete deltas to peers', () => {
  initNetwork();
  const p = MockPeer.instances.at(-1);
  p.emit('open', 'peer-undo');
  connectToPeer('peer-friend', true);
  const conn = p._conns.at(-1);
  conn.emit('open');

  setDeps(broadcast, null, null, null);
  resetState();

  pushUndo();
  upsert({ id: 'N1', type: 'note', x: 0, y: 0, w: 100, h: 80, text: 'hello', rev: 0 });
  conn._sent.length = 0;

  // Undo the creation of N1 -> should broadcast a delete for N1
  undo();
  assert.equal(state.elements.N1, undefined);
  assert.ok(conn._sent.some(m => m.t === 'delete' && m.id === 'N1'), 'undo broadcasted delete for N1');

  conn._sent.length = 0;
  // Redo the creation of N1 -> should broadcast an upsert for N1
  redo();
  assert.ok(state.elements.N1);
  assert.ok(conn._sent.some(m => m.t === 'upsert' && m.el && m.el.id === 'N1'), 'redo broadcasted upsert for N1');
});

test('leaveRoom() disconnects from foreign room and restores personal board', () => {
  localStorage.clear();
  localStorage.setItem('wb-peer-id', 'my-own-id');
  localStorage.setItem(
    'wb-elements-v2:my-own-id',
    JSON.stringify({ OWN: { id: 'OWN', type: 'note', x: 5, y: 5, w: 100, h: 80, text: 'mine' } })
  );

  initNetwork();
  const p = MockPeer.instances.at(-1);
  p.emit('open', 'my-own-id');

  // Join foreign room
  state.persistable = false;
  state.elements = { FOREIGN: { id: 'FOREIGN', type: 'note', x: 0, y: 0, w: 50, h: 50 } };
  connectToPeer('foreign-room', true);
  p._conns.at(-1).emit('open');

  // Now leave room
  leaveRoom();

  assert.equal(state.persistable, true, 'persistable restored to true');
  assert.ok(state.elements.OWN, 'personal board element restored from localStorage');
  assert.equal(state.elements.FOREIGN, undefined, 'foreign element cleared');
  assert.equal(getNetworkState().connectedPeers.length, 0, 'all foreign connections closed');
});

test('duplicateSelected() clones the selected element with an offset', () => {
  resetState();
  upsert({ id: 'ORIG', type: 'note', x: 100, y: 200, w: 170, h: 120, text: 'dup me', color: '#FFE08A' }, false);
  state.selectedId = 'ORIG';
  const copy = duplicateSelected();
  assert.ok(copy && copy.id !== 'ORIG');
  assert.equal(copy.x, 124);
  assert.equal(copy.y, 224);
  assert.equal(state.selectedId, copy.id);
});

test('simplifyStrokePoints reduces collinear points while preserving endpoints', () => {
  const pts = [
    { x: 0, y: 0 },
    { x: 10, y: 0.05 },
    { x: 20, y: -0.05 },
    { x: 30, y: 0 },
    { x: 30, y: 40 },
  ];
  const simplified = simplifyStrokePoints(pts, 0.5);
  assert.equal(simplified.length, 3);
  assert.deepEqual(simplified[0], { x: 0, y: 0 });
  assert.deepEqual(simplified[simplified.length - 1], { x: 30, y: 40 });
});

test('rectEdgePoint accounts for element rotation', () => {
  const n = { x: 0, y: 0, w: 100, h: 40, rotation: Math.PI / 2 };
  // Center is (50, 20). After 90° rotation, width along X is 40 (x in [30, 70]).
  const edge = rectEdgePoint(n, { x: 200, y: 20 });
  assert.ok(Math.abs(edge.x - 70) < 1e-6, `expected edge.x=70, got ${edge.x}`);
  assert.ok(Math.abs(edge.y - 20) < 1e-6, `expected edge.y=20, got ${edge.y}`);
});
