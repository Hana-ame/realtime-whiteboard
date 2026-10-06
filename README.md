# Realtime Whiteboard

A formal, well-structured real-time collaborative whiteboard application.

## Features
- Infinite canvas with panning and zooming
- Sticky notes, freehand drawing, and connecting lines
- Realtime collaboration via WebRTC (PeerJS)
- Minimap for easy navigation
- Undo/redo stack
- Interactive toolbars and palettes

## Setup Instructions

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the development server:
   ```bash
   npm run dev
   ```

## Architecture Overview
- `src/js/app.js`: Main entry point
- `src/js/state.js`: Global state management and synchronization
- `src/js/renderer.js`: Canvas drawing routines
- `src/js/interaction.js`: Pointer/keyboard event handling
- `src/js/network.js`: PeerJS setup and P2P communication
- `src/css/*`: Modularized CSS stylesheets
