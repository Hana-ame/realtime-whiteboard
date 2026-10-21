/**
 * Deterministic CRDT conflict resolution, state merging, and diff calculation.
 * Shared total-order rules with Go room server (room-go/store.go).
 * @module crdt
 */

/**
 * Total order comparison on (rev, cid):
 * 1. Higher `rev` strictly wins.
 * 2. On equal `rev` (concurrent edits from same base rev), lexicographically
 *    greater `cid` (PeerJS client ID) wins deterministically across all nodes.
 * @param {Object} incoming
 * @param {Object} current
 * @returns {boolean} True if `incoming` beats `current`
 */
export function beats(incoming, current) {
  if (!incoming) return false;
  if (!current) return true;
  const ar = Number(incoming.rev) || 0;
  const cr = Number(current.rev) || 0;
  if (ar !== cr) return ar > cr;
  return String(incoming.cid || '') > String(current.cid || '');
}

/**
 * Validate and normalize an incoming whiteboard element so malformed payloads
 * from peers cannot corrupt state or crash the canvas renderer.
 * @param {Object} el
 * @param {string} [fallbackCid]
 * @returns {Object|null}
 */
export function sanitizeElement(el, fallbackCid = '') {
  if (!el || typeof el !== 'object' || typeof el.id !== 'string' || !el.id) {
    return null;
  }
  const validTypes = new Set(['note', 'image', 'stroke', 'connection']);
  if (el.type && !validTypes.has(el.type)) {
    return null;
  }
  el.cid = el.cid || fallbackCid || '';
  el.rev = Number(el.rev) || 0;
  if (el.type === 'stroke' && !Array.isArray(el.points)) {
    el.points = [];
  }
  return el;
}

/**
 * Merge non-geometric style/content fields when the local user is actively
 * dragging an element while a remote peer concurrently modifies its text/style.
 * Bumps `current.rev` so the local drag's final pointerup upsert wins cleanly.
 * @param {Object} current
 * @param {Object} incoming
 * @returns {boolean} True if any non-geometric property changed
 */
export function mergeConcurrentDragProps(current, incoming) {
  if (!current || !incoming || incoming._isLiveMove) return false;
  let changed = false;
  const styleKeys = ['text', 'color', 'fontSize', 'bgOpacity', 'textOpacity', 'width'];
  for (const k of styleKeys) {
    if (k in incoming && incoming[k] !== current[k]) {
      current[k] = incoming[k];
      changed = true;
    }
  }
  if (changed && (incoming.rev || 0) > (current.rev || 0)) {
    current.rev = incoming.rev;
  }
  return changed;
}

/**
 * Apply live-drag geometry fields onto an existing element in-place without
 * clobbering its non-geometric fields (text, color, dataUrl, etc.).
 * @param {Object} current
 * @param {Object} incoming
 */
export function applyLiveMoveGeometry(current, incoming) {
  if (!current || !incoming) return;
  if ((current.rev || 0) > (incoming.rev || 0)) {
    incoming.rev = current.rev;
  }
  if (incoming.x !== undefined) current.x = incoming.x;
  if (incoming.y !== undefined) current.y = incoming.y;
  if (incoming.w !== undefined) current.w = incoming.w;
  if (incoming.h !== undefined) current.h = incoming.h;
  if (incoming.rotation !== undefined) current.rotation = incoming.rotation;
  if (incoming.points !== undefined) current.points = incoming.points;
}

/**
 * Compute per-element delta between `before` and `after` snapshots for
 * collaborative Undo/Redo propagation.
 * @param {Record<string, Object>} before
 * @param {Record<string, Object>} after
 * @param {string} selfCid
 * @returns {{ upserts: Object[], deletes: string[] }}
 */
export function computeStateDiff(before, after, selfCid = '') {
  const upserts = [];
  const deletes = [];

  for (const id in before) {
    if (!Object.prototype.hasOwnProperty.call(after, id)) {
      deletes.push(id);
    }
  }

  for (const id in after) {
    const nextEl = after[id];
    const prevEl = before[id];
    if (!prevEl || JSON.stringify(prevEl) !== JSON.stringify(nextEl)) {
      const nextRev = Math.max(Number(prevEl?.rev) || 0, Number(nextEl?.rev) || 0) + 1;
      nextEl.rev = nextRev;
      nextEl.updatedAt = Date.now();
      if (selfCid) nextEl.cid = selfCid;
      upserts.push(nextEl);
    }
  }

  return { upserts, deletes };
}
