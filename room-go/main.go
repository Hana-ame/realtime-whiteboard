package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

const (
	signalingURL = "wss://0.peerjs.com:443/peerjs?key=peerjs"
	heartbeatInt = 5000
)

func main() {
	roomName := "wb-room"
	if len(os.Args) > 1 {
		roomName = os.Args[1]
	}

	fmt.Printf("[room] Creating room: %s\n", roomName)

	// Connect to PeerJS signaling server
	conn, _, err := websocket.DefaultDialer.Dial(signalingURL, nil)
	if err != nil {
		log.Fatalf("WebSocket connect failed: %v", err)
	}
	defer conn.Close()
	fmt.Println("[room] Connected to signaling server")

	// Register peer
	regMsg := map[string]interface{}{
		"type":  "REGISTER",
		"payload": map[string]interface{}{
			"id": roomName,
		},
	}
	jsonMsg, _ := json.Marshal(regMsg)
	conn.WriteMessage(websocket.TextMessage, jsonMsg)
	fmt.Println("[room] Sent registration")

	// Initialize WebRTC
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		log.Fatalf("WebRTC init failed: %v", err)
	}

	// Handle incoming data channels
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		fmt.Printf("[room] Data channel opened: %s\n", dc.Label())
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			fmt.Printf("[room] Message received: %s\n", string(msg.Data))
		})
	})

	// Heartbeat
	go func() {
		ticker := time.NewTicker(time.Duration(heartbeatInt) * time.Millisecond)
		defer ticker.Stop()
		for range ticker.C {
			msg, _ := json.Marshal(map[string]string{"type": "HEARTBEAT"})
			conn.WriteMessage(websocket.TextMessage, msg)
		}
	}()

	// Handle messages from signaling server
	go func() {
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				log.Printf("[room] WebSocket closed: %v", err)
				return
			}

			var data map[string]interface{}
			if err := json.Unmarshal(msg, &data); err != nil {
				continue
			}

			msgType, _ := data["type"].(string)
			fmt.Printf("[room] Received: %s\n", msgType)

			switch msgType {
			case "OPEN":
				payload, _ := data["payload"].(map[string]interface{})
				id, _ := payload["id"].(string)
				fmt.Println("\n========================================")
				fmt.Printf("  Room ID: %s\n", id)
				fmt.Println("  Status:  Active & Connectable")
				fmt.Println("========================================\n")
				fmt.Println("Open the whiteboard in a browser and enter this room ID to join.")
				fmt.Println("This process must stay running to keep the room alive.")

			case "OFFER":
				payload, _ := data["payload"].(map[string]interface{})
				sdp, _ := payload["sdp"].(map[string]interface{})
				sdpType, _ := sdp["type"].(string)
				sdpDesc, _ := sdp["sdp"].(string)
				connID, _ := payload["connectionId"].(string)
				srcPeer, _ := payload["srcPeer"].(string)

				fmt.Printf("[room] OFFER from %s (conn: %s)\n", srcPeer, connID)

				if err := pc.SetRemoteDescription(webrtc.SessionDescription{
					Type: webrtc.SDPType(sdpType),
					SDP:  sdpDesc,
				}); err != nil {
					log.Printf("[room] SetRemoteDescription failed: %v", err)
					continue
				}

				// Create data channel
				dc, err := pc.CreateDataChannel(fmt.Sprintf("conn-%s", connID), &webrtc.DataChannelInit{})
				if err != nil {
					log.Printf("[room] CreateDataChannel failed: %v", err)
					continue
				}
				dc.OnOpen(func() {
					fmt.Printf("[room] Connection open with %s\n", srcPeer)
				})

				// Create answer
				answer, err := pc.CreateAnswer(nil)
				if err != nil {
					log.Printf("[room] CreateAnswer failed: %v", err)
					continue
				}

				// Send answer via signaling
				answerMsg := map[string]interface{}{
					"type": "ANSWER",
					"payload": map[string]interface{}{
						"dstPeer":      srcPeer,
						"connectionId": connID,
						"peerId":       id,
						"sdp": map[string]interface{}{
							"type": answer.Type.String(),
							"sdp":  answer.SDP,
						},
					},
				}
				jsonMsg, _ := json.Marshal(answerMsg)
				conn.WriteMessage(websocket.TextMessage, jsonMsg)
				fmt.Println("[room] Sent ANSWER")

			case "CANDIDATE":
				payload, _ := data["payload"].(map[string]interface{})
				candidate, _ := payload["candidate"].(string)
				connID, _ := payload["connectionId"].(string)
				srcPeer, _ := payload["srcPeer"].(string)

				fmt.Printf("[room] CANDIDATE from %s (conn: %s)\n", srcPeer, connID)

				if err := pc.AddICECandidate(webrtc.ICECandidateInit{Candidate: candidate}); err != nil {
					log.Printf("[room] AddICECandidate failed: %v", err)
				}
			}
		}
	}()

	// Handle ICE candidates from WebRTC
	pc.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate == nil {
			return
		}
		candidateMsg := map[string]interface{}{
			"type": "CANDIDATE",
			"payload": map[string]interface{}{
				"candidate": candidate.Candidate,
			},
		}
		jsonMsg, _ := json.Marshal(candidateMsg)
		conn.WriteMessage(websocket.TextMessage, jsonMsg)
	})

	// Wait for interrupt
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	<-sigChan

	fmt.Println("\n[room] Closing...")
	conn.Close()
	pc.Close()
}
