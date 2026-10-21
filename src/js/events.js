/**
 * Lightweight synchronous EventBus for decoupled cross-module communication.
 * Eliminates circular dependencies between state, renderer, toolbar, editor, and network.
 * @module events
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} Unsubscribe function
   */
  on(event, handler) {
    if (typeof handler !== 'function') return () => {};
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /**
   * Subscribe to an event once
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void}
   */
  once(event, handler) {
    const wrapper = (...args) => {
      this.off(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  /**
   * Unsubscribe from an event
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = this._listeners.get(event);
    if (!set) return;
    set.delete(handler);
    if (set.size === 0) this._listeners.delete(event);
  }

  /**
   * Emit an event synchronously to all subscribers
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      try {
        fn(...args);
      } catch (err) {
        // Prevent a failing subscriber from breaking the dispatch chain
      }
    }
  }

  /**
   * Clear all listeners (or listeners for a specific event)
   * @param {string} [event]
   */
  clear(event) {
    if (event) this._listeners.delete(event);
    else this._listeners.clear();
  }
}

export const bus = new EventBus();

export const EVENTS = Object.freeze({
  RENDER_REQUEST: 'render:request',
  SELECTION_CHANGED: 'selection:changed',
  TOOL_CHANGED: 'tool:changed',
  VIEW_CHANGED: 'view:changed',
  HISTORY_CHANGED: 'history:changed',
  ELEMENT_UPSERTED: 'element:upserted',
  ELEMENT_REMOVED: 'element:removed',
  IMAGE_CACHE_CLEAR: 'cache:clear-image',
  NET_BROADCAST: 'net:broadcast',
  NET_STATUS: 'net:status',
  PRESENCE_CHANGED: 'presence:changed',
});
