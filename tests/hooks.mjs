/**
 * ESM loader hooks (run on a dedicated loader thread, registered from setup.mjs).
 *
 * src/js/network.js does `import { Peer } from 'peerjs'` at module top level.
 * peerjs is a CommonJS package whose named-export interop fails under raw Node ESM
 * ("Named export 'Peer' not found"), and even if it linked, it would try to spin up
 * WebRTC. So we redirect the bare specifier 'peerjs' to our local mock.
 *
 * This module must stay free of any dependency on the main thread's globals:
 * loader hooks are executed in their own worker.
 */

const MOCK_URL = new URL('./mock-peer.mjs', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'peerjs' || specifier === 'peerjs-core' || specifier.startsWith('peerjs/')) {
    return { url: MOCK_URL, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
