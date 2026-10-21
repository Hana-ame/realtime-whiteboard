/**
 * Room-persistence tests for src/js/network.js.
 *
 * Compatible with both Node 18 (`timers.enable(['setTimeout'])`) and
 * Node 20.12+ (`timers.enable({ apis: ['setTimeout'] })`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shim } from './setup.mjs';
import { MockPeer } from './mock-peer.mjs';
import { initNetwork } from '../src/js/network.js';

const unavailableIdError = { type: 'unavailable-id', message: 'ID taken' };

function enableMockTimers(t, apis) {
  try {
    t.mock.timers.enable({ apis });
  } catch (_) {
    t.mock.timers.enable(apis);
  }
}

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
  enableMockTimers(t, ['setTimeout']);
  try {
    localStorage.setItem('wb-peer-id', 'taken-room');
    initNetwork();

    const p1 = MockPeer.instances.at(-1);
    assert.equal(p1.id, 'taken-room', 'first peer used the stored id');

    p1.emit('error', unavailableIdError);
    t.mock.timers.tick(1200);
    const p2 = MockPeer.instances.at(-1);
    assert.notEqual(p2, p1, 'retry 1 created a new Peer instance');
    assert.equal(p2.id, 'taken-room', 'retry 1 reused the stored id');

    p2.emit('error', unavailableIdError);
    t.mock.timers.tick(1200);
    const p3 = MockPeer.instances.at(-1);
    assert.notEqual(p3, p2, 'retry 2 created a new Peer instance');
    assert.equal(p3.id, 'taken-room', 'retry 2 reused the stored id');

    p3.emit('error', unavailableIdError);
    t.mock.timers.tick(1200);
    const p4 = MockPeer.instances.at(-1);
    assert.notEqual(p4, p3, 'retry 3 created a new Peer instance');
    assert.equal(p4.id, 'taken-room', 'retry 3 (retries=0) still uses the stored id');

    p4.emit('error', unavailableIdError);

    const body = shim.dom.getElementById('body');
    assert.equal(body.children.length, 1, 'modal overlay was appended to body');
    const overlay = body.children[0];
    assert.equal(overlay.id, 'room-conflict-modal', 'modal overlay has the expected id');

    assert.equal(
      localStorage.getItem('wb-peer-id'), 'taken-room',
      'localStorage is NOT overwritten while the modal is shown'
    );

    const buttons = findAllClickable(overlay);
    assert.equal(buttons.length, 2, 'modal has two clickable elements (buttons)');
    assert.equal(buttons[0].textContent, '重试原房间', 'first button is "Retry Original Room"');
    assert.equal(buttons[1].textContent, '使用新房间号', 'second button is "Use New Room"');
  } finally {
    t.mock.timers.reset();
  }
});

test('modal "Retry Original Room" button creates a new peer with the original ID', (t) => {
  enableMockTimers(t, ['setTimeout']);
  try {
    shim.dom.getElementById('body').children.length = 0;
    localStorage.setItem('wb-peer-id', 'taken-room');
    initNetwork();

    for (let i = 0; i < 4; i++) {
      MockPeer.instances.at(-1).emit('error', unavailableIdError);
      if (i < 3) t.mock.timers.tick(1200);
    }

    const body = shim.dom.getElementById('body');
    const overlay = body.children[0];
    const buttons = findAllClickable(overlay);
    const before = MockPeer.instances.length;

    getClickHandler(buttons[0])();

    assert.equal(body.children.length, 0, 'modal was removed from body after retry click');
    assert.equal(MockPeer.instances.length, before + 1, 'retry click created a new Peer');
    const newPeer = MockPeer.instances.at(-1);
    assert.equal(newPeer.id, 'taken-room', 'retry click reused the original room id');

    assert.equal(
      localStorage.getItem('wb-peer-id'), 'taken-room',
      'localStorage is unchanged after retry click'
    );
  } finally {
    t.mock.timers.reset();
  }
});

test('modal "Use New Room" button writes new random ID to localStorage', (t) => {
  enableMockTimers(t, ['setTimeout']);
  try {
    shim.dom.getElementById('body').children.length = 0;
    localStorage.setItem('wb-peer-id', 'taken-room');
    initNetwork();

    for (let i = 0; i < 4; i++) {
      MockPeer.instances.at(-1).emit('error', unavailableIdError);
      if (i < 3) t.mock.timers.tick(1200);
    }

    const body = shim.dom.getElementById('body');
    const overlay = body.children[0];
    const buttons = findAllClickable(overlay);
    const before = MockPeer.instances.length;

    getClickHandler(buttons[1])();

    assert.equal(body.children.length, 0, 'modal was removed from body after fallback click');
    assert.equal(MockPeer.instances.length, before + 1, 'fallback click created a new Peer');
    const newPeer = MockPeer.instances.at(-1);
    assert.equal(newPeer.id, undefined, 'fallback click created a peer with random (undefined) id');

    assert.equal(
      localStorage.getItem('wb-peer-id'), 'taken-room',
      'localStorage is unchanged before the new peer opens'
    );

    newPeer.emit('open', 'new-random-456');

    assert.equal(
      localStorage.getItem('wb-peer-id'), 'new-random-456',
      'localStorage is updated with the new random ID (via _forceSaveId)'
    );
  } finally {
    t.mock.timers.reset();
  }
});

test.skip('modal interactive behaviour (BROWSER-ONLY)', () => {});
