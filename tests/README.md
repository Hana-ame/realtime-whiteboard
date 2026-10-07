# tests/

Regression harness for the collaboration layer. Every test imports the **real**
`src/js/network.js` and `src/js/state.js` — no copies of the merge logic.

```sh
npm test
# == node --import ./tests/setup.mjs --test tests/*.test.mjs
```

No dependencies are added: `node:test` + `node:assert/strict` only (Node 22).
`node --test` runs each `*.test.mjs` in its own process, which is why
`network.js`'s module-private singletons (`peer`, `conns`, `tombstones`, `seen`)
do not leak between test files.

## Why `tests/setup.mjs` exists

Two import-time hazards in `src/` that plain Node cannot survive:

1. `src/js/renderer.js:10` — `export const DPR = Math.max(1, window.devicePixelRatio || 1)`
   reads a browser global while the module is being evaluated. `setup.mjs`
   installs `window` / `document` / `localStorage` / `requestAnimationFrame` on
   `globalThis` **before** any `src/` module is loaded, because `--import` runs
   ahead of the test files.
2. `src/js/network.js:1` — `import { Peer } from 'peerjs'`. peerjs is CommonJS and
   fails Node's named-export interop ("Named export 'Peer' not found"); even if it
   linked it would try to open WebRTC. `setup.mjs` calls `module.register()` on
   `tests/hooks.mjs`, whose `resolve()` hook rewrites the bare `peerjs` specifier
   to `tests/mock-peer.mjs`.

`requestAnimationFrame` is a no-op so `requestRender()` never calls `render()`, and
`setInterval` is neutralised because `initNetwork()` registers a 4 s presence
broadcast and a 5 s `pruneStaleConns()` sweep that would pin the event loop open.

`document.getElementById()` always returns a recording stub rather than `null`, so
the few `getElementById(...).addEventListener(...)` calls in `initNetwork()` that
have no null-guard cannot throw, and assertions can read what the UI code painted,
e.g. `shim.dom.getElementById('net-count').textContent`.

## Mock fidelity

`MockDataConnection.close()` fires **no** `'close'` event on a never-opened
connection. That is peerjs 1.5.5's actual behaviour and it is what makes the stale
`conns` entry possible, so the mock deliberately does not paper over it.
`emit('open')` / `emit('close')` do move the `open` flag, matching peerjs —
`sendLocal()` and `relay()` gate on `conn.open`.

## Results

| test | guards | vs `HEAD` (`b49d5dc`) | vs working tree |
|---|---|---|---|
| `tombstone.test.mjs` | fullSync must not resurrect a deleted element | **RED** — X comes back | GREEN |
| `rev-tie.test.mjs` | rev ties resolve deterministically | **RED** — `A="from A", B="from B", C="from A"` | GREEN — all `"from B"` |
| `dropconn.test.mjs` | EXPIRE frees the room id | GREEN | GREEN |

`rev-tie.test.mjs` drives three peers, one per node process (`tests/rev-tie-peer.mjs`),
because `state.elements` is a process-level singleton with no exported reset. Each
process still executes the real `handleMsg()`.

Each guard was proven to bite by reverting its fix in a throwaway copy and
re-running: the suite fails on exactly the one test whose fix was removed.
