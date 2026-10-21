# Realtime Whiteboard

A real-time collaborative whiteboard application built with HTML5 Canvas, WebRTC (PeerJS), and an optional headless Go room daemon.

## Features
- **Infinite Canvas**: Smooth panning, cursor-anchored zooming, viewport culling, and interactive minimap
- **Rich Elements**: Sticky notes (customizable font size, background/text opacity, rotation), freehand strokes (with RDP point simplification), rotation-aware directional connections, and images/animated GIFs (pure-JS frame decoder)
- **Context-Aware Property Bar**: Automatically surfaces style controls when selecting any existing note, stroke, or connection
- **Collaborative Undo / Redo & Duplication**: Incremental CRDT delta propagation on `Ctrl+Z` / `Ctrl+Y` and one-click element duplication (`Ctrl+D`)
- **Resilient P2P & Room Sync**:
  - Deterministic `(rev, cid)` LWW-Element-Set conflict resolution and tombstone sync
  - Sliding-window FIFO message deduplication (`BoundedSet`)
  - Connection glare protection and transparent 48 KB WebRTC DataChannel chunking/reassembly
  - One-click room leave (`离开房间`) restoring personal persisted whiteboard while keeping foreign room canvases strictly in-memory

## Architecture Overview
- `src/js/app.js`: Application bootstrap and storage migration
- `src/js/events.js`: Synchronous `EventBus` decoupling state, renderer, toolbar, and network layers
- `src/js/crdt.js`: Deterministic `(rev, cid)` conflict resolution, live-drag property merging, and undo/redo state diffing
- `src/js/geometry.js`: Pure 2D spatial math, rotation-aware hit testing, handle layout, and stroke simplification
- `src/js/state.js`: Central state store, room-scoped persistence, and collaborative undo/redo stack
- `src/js/network.js`: PeerJS mesh & room connection lifecycle, chunking, and tombstone sync
- `src/js/renderer.js`: Viewport-culled HTML5 Canvas renderer, lazy image queue, and GIF frame animator
- `src/js/interaction.js`: Pointer, touch (pinch-to-zoom), and keyboard interaction state machine
- `src/js/toolbar.js`: Tool switcher, context-sensitive property bar, and zoom/history controls
- `src/js/editor.js`: Transparent in-place note text editor overlay
- `src/js/gif.js`: Pure-JS GIF89a LZW frame decoder
- `src/js/utils.js`: Coordinate transforms, `BoundedSet`, and utilities
- `room-go/`: Headless Go PeerJS/WebRTC room server with versioned tombstones and ring-buffer relay deduplication

## Setup & Testing

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run regression & unit test suite:
   ```bash
   npm test
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Build for production:
   ```bash
   npm run build
   ```
