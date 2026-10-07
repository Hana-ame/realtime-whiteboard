/**
 * Worker for rev-tie.test.mjs: simulates ONE peer of the three, then prints its
 * resulting canvas state as JSON on stdout.
 *
 * It imports the REAL src/js/network.js + src/js/state.js, so the rev comparison at
 * network.js:363 is what actually decides the outcome — this file only feeds it a
 * deterministic, pre-scripted inbox.
 *
 * Usage: node --import ./tests/setup.mjs tests/rev-tie-peer.mjs '<json spec>'
 * Spec: { role, initial: {id: el}, inbox: [message, ...] }
 */

import { state } from '../src/js/state.js';
import { initNetwork, connectToPeer } from '../src/js/network.js';
import { MockPeer } from './mock-peer.mjs';

const spec = JSON.parse(process.argv[2] ?? '{}');
if (!spec.role) {
  console.error('rev-tie-peer: missing spec.role');
  process.exit(2);
}

initNetwork();
const peer = MockPeer.instances.at(-1);
peer.emit('open', spec.role);

// What this peer already holds before the concurrent edits arrive.
state.elements = { ...(spec.initial || {}) };

// Open one link so messages can be delivered through the real setupConn('data') path.
connectToPeer('remote-of-' + spec.role, false);
const conn = peer._conns.at(-1);
conn.emit('open');

for (const msg of spec.inbox || []) conn.emit('data', msg);

process.stdout.write(JSON.stringify({
  role: spec.role,
  elements: state.elements,
}));
