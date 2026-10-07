/**
 * In-memory stand-ins for peerjs's `Peer` and `DataConnection`.
 *
 * Fidelity notes that matter for the regression cases under test:
 *  - `MockPeer.emit('open', id)` flips `open = true` (as the real lib does), so the
 *    guards in connectToPeer() (`!peer || !myId || !peer.open`) behave for real.
 *  - `MockDataConnection.close()` on a connection that was never opened fires NO
 *    'close' event. That is peerjs 1.5.5's actual (buggy) behaviour, and it is the
 *    reason a stale `conns` entry survives: network.js can only drop the entry either
 *    explicitly via dropConn() or through the conn's own 'close' handler.
 *    Replaying the bug faithfully means we must NOT be helpful here.
 *
 * Tests drive the mocks by pulling instances off the static registries
 * (`MockPeer.instances`, `MockDataConnection.all`) and calling `.emit()`.
 */

class MockDataConnection {
  static all = [];

  /** @param {MockPeer} owner @param {string} targetId @param {object} opts */
  constructor(owner, targetId, opts) {
    // `peer` is the *remote* peer id, matching peerjs's DataConnection.peer
    this.peer = targetId;
    this.open = false;
    this.destroyed = false;
    this._owner = owner;
    this._opts = opts || {};
    this._handlers = { open: [], data: [], close: [], error: [] };
    this._sent = [];
    MockDataConnection.all.push(this);
    if (owner && Array.isArray(owner._conns)) owner._conns.push(this);
  }

  on(event, fn) {
    (this._handlers[event] ||= []).push(fn);
    return this;
  }

  off(event, fn) {
    const list = this._handlers[event];
    if (!list) return this;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }

  /** Fire an event at the captured handlers, like EventEmitter.emit().
   *  'open' / 'close' also move the `open` flag, mirroring peerjs, which flips
   *  DataConnection.open and *then* fires the event. network.js reads conn.open in
   *  sendLocal() / relay(), so the flag must track the event. */
  emit(event, ...args) {
    if (event === 'open') this.open = true;
    else if (event === 'close') this.open = false;
    for (const fn of (this._handlers[event] || []).slice()) fn(...args);
    return this;
  }

  send(msg) {
    this._sent.push(msg);
    return true;
  }

  close() {
    const wasOpen = this.open;
    this.open = false;
    this.destroyed = true;
    if (wasOpen) this.emit('close'); // never-opened conn: no 'close', by design
  }
}

class MockPeer {
  static instances = [];

  /** @param {string|undefined} id */
  constructor(id, opts) {
    this.id = id;
    this.open = false;
    this.destroyed = false;
    this._opts = opts || {};
    this._conns = [];
    this._handlers = { open: [], connection: [], error: [], disconnected: [] };
    MockPeer.instances.push(this);
  }

  on(event, fn) {
    (this._handlers[event] ||= []).push(fn);
    return this;
  }

  off(event, fn) {
    const list = this._handlers[event];
    if (!list) return this;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
    return this;
  }

  /** Fire an event; 'open' / 'disconnected' move the `open` flag like the real lib. */
  emit(event, ...args) {
    if (event === 'open') this.open = true;
    else if (event === 'disconnected') this.open = false;
    for (const fn of (this._handlers[event] || []).slice()) fn(...args);
    return this;
  }

  connect(targetId, opts) {
    return new MockDataConnection(this, targetId, opts);
  }

  destroy() {
    this.destroyed = true;
    this.open = false;
  }

  reconnect() {
    this.open = true;
  }
}

// network.js does `import { Peer } from 'peerjs'` — expose the mock under that name
// as well as under the alias the tests import.
export { MockPeer, MockPeer as Peer, MockDataConnection };
