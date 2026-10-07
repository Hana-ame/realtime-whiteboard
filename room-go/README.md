# Room Server (Golang)

Headless PeerJS room creator. Creates a room that browsers can connect to.

## Build

Built automatically by GitHub Actions on push. Download from [Actions artifacts](https://github.com/Hana-ame/realtime-whiteboard/actions).

Or build locally:
```bash
cd room-go
go mod tidy
go build -ldflags="-s -w" -o room .
```

## Usage

```bash
# Default room name
./room

# Custom room name
./room my-room-123
```

Output:
```
[room] Creating room: my-room-123
[room] Connected to signaling server
[room] Sent registration
[room] Received: OPEN

========================================
  Room ID: my-room-123
  Status:  Active & Connectable
========================================

Open the whiteboard in a browser and enter this room ID to join.
This process must stay running to keep the room alive.
```

## VPS Deployment

```bash
# Download binary from GitHub Actions artifacts
wget https://github.com/Hana-ame/realtime-whiteboard/actions/download/artifact/room-linux-amd64

# Run in background
nohup ./room-linux-amd64 wb-room-123 &
```
