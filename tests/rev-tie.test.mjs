/**
 * Regression: a rev tie between two concurrent edits must resolve deterministically.
 *
 * Bug site at HEAD (b49d5dc), src/js/network.js:363 — `if (!cur || (el.rev || 0) > (cur.rev || 0))`.
 * Strict `>` drops the second of two equal-rev upserts, so which peer's text survives
 * is decided purely by message arrival order. A and B can then sit on different texts
 * forever and there is no deterministic rule to break the tie.
 *
 * The fix (working tree) introduces `beats(a, cur)` at network.js:58, a total order on
 * (rev, cid) where cid is the writing peer's id. A deterministic rule means every peer
 * computes the same winner regardless of the order its copies arrive in.
 *
 * Three peers are needed, and network.js + state.js are process-level singletons with
 * no exported reset (state.elements / conns / tombstones are module-private), so each
 * peer runs in its own node process via tests/rev-tie-peer.mjs. Every process still
 * imports and executes the REAL src/js/network.js and src/js/state.js — only the
 * "wire" between them is scripted, which is exactly what makes the outcome
 * reproducible instead of dependent on async arrival order.
 *
 * Status: RED against HEAD, GREEN against the fix. Observed divergence at HEAD is
 * A="from A", B="from B", C="from A"; with the fix all three converge on "from B"
 * (the lexicographically greatest cid wins the tie).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run one peer with a scripted inbox; returns its final state.elements. */
function runPeer(spec) {
  const r = spawnSync(
    process.execPath,
    ['--import', resolve(HERE, 'setup.mjs'), resolve(HERE, 'rev-tie-peer.mjs'), JSON.stringify(spec)],
    { encoding: 'utf8', cwd: resolve(HERE, '..') }
  );
  assert.equal(r.status, 0,
    `worker ${spec.role} crashed:\nSTDOUT ${r.stdout}\nSTDERR ${r.stderr}`);
  return JSON.parse(r.stdout).elements;
}

test('concurrent rev-1 edits of X converge to one text', () => {
  const base = { id: 'X', type: 'note', x: 10, y: 20, w: 170, h: 120 };

  // Every upsert must carry both the element-level `cid` and the message-level `pid`
  // (network.js does `el.cid = el.cid || m.pid || ''`). A revision-tie fix has no
  // other information to work with — with cids missing on both sides there is no
  // deterministic winner and the test would be a false negative against fixed code.
  const upsert = (text, rev, cid) => ({ t: 'upsert', pid: cid, el: { ...base, text, rev, cid } });

  // X started at rev 0 for everyone. A and B edit it concurrently -> both rev 1.
  // Each element's cid records who last wrote it, exactly as state.js upsert() does.
  const resA = runPeer({
    role: 'peer-A',
    initial: { X: { ...base, rev: 1, text: 'from A', cid: 'peer-A' } },
    inbox: [upsert('from B', 1, 'peer-B')],   // B's concurrent edit arrives at A
  });
  const resB = runPeer({
    role: 'peer-B',
    initial: { X: { ...base, rev: 1, text: 'from B', cid: 'peer-B' } },
    inbox: [upsert('from A', 1, 'peer-A')],   // A's concurrent edit arrives at B
  });
  // C never edited X (still at rev 0) and receives both, A's first.
  const resC = runPeer({
    role: 'peer-C',
    initial: { X: { ...base, rev: 0, text: 'base' } },
    inbox: [upsert('from A', 1, 'peer-A'), upsert('from B', 1, 'peer-B')],
  });

  const texts = {
    A: resA.X && resA.X.text,
    B: resB.X && resB.X.text,
    C: resC.X && resC.X.text,
  };
  console.log('final text of X per peer: ' + JSON.stringify(texts) +
    ' (C receives A\'s upsert before B\'s)');

  assert.equal(
    new Set(Object.values(texts)).size, 1,
    'REGRESSION (network.js:363, strict `(el.rev||0) > (cur.rev||0)`): rev ties are ' +
      'resolved by arrival order, so peers diverge. actual=' + JSON.stringify(texts) +
      ', expected all three identical'
  );
});
