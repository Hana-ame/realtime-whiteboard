# Realtime Whiteboard

A formal, well-structured real-time collaborative whiteboard application.

## Features
- Infinite canvas with panning and zooming
- Sticky notes, freehand drawing, and connecting lines
- Paste images (<kbd>Ctrl+V</kbd>) with peer-to-peer distribution & local storage
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

3. Build for production:
   ```bash
   npm run build
   ```

## GitHub Pages Deployment

The repository is configured for automated GitHub Pages deployment:
1. Push this project to your GitHub repository.
2. In your repository on GitHub, navigate to **Settings** > **Pages**.
3. Under **Build and deployment** > **Source**, select **GitHub Actions**.
4. Pushes to `main` or `master` will trigger the workflow (`.github/workflows/deploy.yml`) and deploy the site automatically.

## Architecture Overview
- `src/js/app.js`: Main entry point
- `src/js/state.js`: Global state management and synchronization
- `src/js/renderer.js`: Canvas drawing routines
- `src/js/interaction.js`: Pointer/keyboard event handling
- `src/js/network.js`: PeerJS setup and P2P communication
- `src/css/*`: Modularized CSS stylesheets
