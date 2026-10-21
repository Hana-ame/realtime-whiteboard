package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
)

const (
	peerjsVersion = "1.5.5"

	defaultPeerHost = "0.peerjs.com"
	defaultPeerKey  = "peerjs"

	writeTimeout = 15 * time.Second
	reconnectGap = 3 * time.Second
	maxRelayed   = 4096
)

var errNotConnected = errors.New("未连接到 PeerJS 信令服务器")
var errIDTaken = errors.New("房间号已被占用")

type Options struct {
	RoomName  string
	Host      string
	Key       string
	Heartbeat time.Duration
}

type RoomServer struct {
	RoomName  string
	Host      string
	Key       string
	Heartbeat time.Duration

	wsURL string

	mu      sync.Mutex
	ws      *websocket.Conn
	idTaken bool

	connMu  sync.RWMutex
	conns   map[string]*roomConn
	pending map[string]string

	seenMu   sync.Mutex
	seen     map[string]struct{}
	seenRing []string
	seenIdx  int

	store   *store
	started time.Time
}

type joinChannel interface {
	OnMessage(func(webrtc.DataChannelMessage))
	OnClose(func())
	OnOpen(func())
	SendText(string) error
}

type roomConn struct {
	connID string
	peerID string
	pc     *webrtc.PeerConnection
	dc     joinChannel
}

type sigMsg struct {
	Type    string                 `json:"type"`
	Payload map[string]interface{} `json:"payload"`
	Src     string                 `json:"src"`
	Dst     string                 `json:"dst"`
}

func NewRoomServer(o Options) *RoomServer {
	if o.RoomName == "" {
		o.RoomName = "wb-room"
	}
	if o.Host == "" {
		o.Host = defaultPeerHost
	}
	if o.Key == "" {
		o.Key = defaultPeerKey
	}
	if o.Heartbeat <= 0 {
		o.Heartbeat = 10 * time.Second
	}

	host, secure := normalizeHost(o.Host)
	scheme := "wss"
	if !secure {
		scheme = "ws"
	}

	u, err := url.Parse(scheme + "://" + host + "/peerjs")
	if err != nil {
		log.Fatalf("信令地址解析失败：%v", err)
	}
	q := u.Query()
	q.Set("key", o.Key)
	q.Set("id", o.RoomName)
	q.Set("token", randomToken(16))
	q.Set("version", peerjsVersion)
	u.RawQuery = q.Encode()

	return &RoomServer{
		RoomName:  o.RoomName,
		Host:      host,
		Key:       o.Key,
		Heartbeat: o.Heartbeat,
		wsURL:     u.String(),
		conns:     map[string]*roomConn{},
		pending:   map[string]string{},
		seen:      make(map[string]struct{}, maxRelayed),
		seenRing:  make([]string, 0, maxRelayed),
		store:     newStore(),
		started:   time.Now(),
	}
}

func (s *RoomServer) Run(ctx context.Context) error {
	attempt := 0
	for {
		if ctx.Err() != nil {
			return nil
		}
		err := s.runOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if s.isIDTaken() {
			log.Printf("房间号 %q 已被另一个实例占用，停止重试（换个名字，或停掉那个实例）", s.RoomName)
			return errIDTaken
		}
		if attempt > 0 {
			log.Printf("信令连接已断开（%v），%s 后重连…", err, reconnectGap)
		}
		attempt++
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(reconnectGap):
		}
	}
}

func (s *RoomServer) runOnce(ctx context.Context) error {
	if err := s.connect(ctx); err != nil {
		return err
	}
	log.Printf("已连接信令服务器 %s（房间 %q）", s.Host, s.RoomName)
	s.startHeartbeat(ctx)
	return s.readLoop(ctx)
}

func (s *RoomServer) connect(ctx context.Context) error {
	dialer := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, resp, err := dialer.DialContext(ctx, s.wsURL, nil)
	if err != nil {
		if resp != nil {
			return fmt.Errorf("连接 %s 失败 (HTTP %d): %w", s.Host, resp.StatusCode, err)
		}
		return fmt.Errorf("连接 %s 失败: %w", s.Host, err)
	}
	s.mu.Lock()
	s.ws = conn
	s.mu.Unlock()
	return nil
}

type readResult struct {
	opcode int
	data   []byte
	err    error
}

func (s *RoomServer) readLoop(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			s.teardown()
			return err
		}
		ch := make(chan readResult, 1)
		go func() {
			opcode, data, err := s.readOnce()
			ch <- readResult{opcode: opcode, data: data, err: err}
		}()
		select {
		case <-ctx.Done():
			s.teardown()
			return ctx.Err()
		case r := <-ch:
			if r.err != nil {
				s.teardown()
				return r.err
			}
			if r.opcode != websocket.TextMessage {
				continue
			}
			var msg sigMsg
			if err := json.Unmarshal(r.data, &msg); err != nil || msg.Type == "" {
				continue
			}
			s.handleMessage(msg)
		}
	}
}

func (s *RoomServer) readOnce() (int, []byte, error) {
	s.mu.Lock()
	ws := s.ws
	s.mu.Unlock()
	if ws == nil {
		return 0, nil, errNotConnected
	}
	return ws.ReadMessage()
}

func (s *RoomServer) sendJSON(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	ws := s.ws
	if ws == nil {
		return errNotConnected
	}
	if err := ws.SetWriteDeadline(time.Now().Add(writeTimeout)); err != nil {
		return err
	}
	return ws.WriteMessage(websocket.TextMessage, data)
}

func (s *RoomServer) teardown() {
	s.mu.Lock()
	ws := s.ws
	s.ws = nil
	s.mu.Unlock()
	if ws != nil {
		_ = ws.Close()
	}

	s.connMu.Lock()
	for id, rc := range s.conns {
		if rc.pc != nil {
			_ = rc.pc.Close()
		}
		delete(s.conns, id)
	}
	for id := range s.pending {
		delete(s.pending, id)
	}
	s.connMu.Unlock()
}

func (s *RoomServer) startHeartbeat(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(s.Heartbeat)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := s.sendJSON(sigMsg{Type: "HEARTBEAT"}); err != nil {
					return
				}
			}
		}
	}()
}

func (s *RoomServer) markIDTaken() {
	s.mu.Lock()
	s.idTaken = true
	s.mu.Unlock()
}

func (s *RoomServer) isIDTaken() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.idTaken
}

func (s *RoomServer) handleMessage(msg sigMsg) {
	switch msg.Type {
	case "OPEN":
		log.Printf("房间 %q 已上线，浏览器可用该房间号加入", s.RoomName)
	case "HEARTBEAT":
	case "ERROR":
		log.Printf("信令服务器返回错误：%v", msg.Payload)
	case "ID-TAKEN":
		s.markIDTaken()
		log.Printf("房间号 %q 已被占用（可能是上一个实例还没退出），换一个名字或稍后再试", s.RoomName)
	case "INVALID-KEY":
		log.Printf("PeerJS key %q 无效", s.Key)
	case "OFFER":
		s.handleOffer(msg)
	case "ANSWER":
		log.Printf("收到意外的 ANSWER（src=%s）", s.srcOf(msg))
	case "CANDIDATE":
		s.handleCandidate(msg)
	case "CLOSE":
		if id, _ := msg.Payload["connectionId"].(string); id != "" {
			s.closeConn(id, "对端关闭连接")
		}
	case "LEAVE", "EXPIRE":
		if src := s.srcOf(msg); src != "" {
			log.Printf("成员 %s 离线", src)
			s.closeAllForPeer(src, "成员离线")
		}
	default:
		log.Printf("未处理的消息类型 %s（src=%s）", msg.Type, s.srcOf(msg))
	}
}

func (s *RoomServer) srcOf(msg sigMsg) string {
	if msg.Src != "" {
		return msg.Src
	}
	if p := msg.Payload; p != nil {
		if v, ok := p["srcPeer"].(string); ok {
			return v
		}
	}
	return ""
}

func (s *RoomServer) handleOffer(msg sigMsg) {
	p := msg.Payload
	if p == nil {
		return
	}
	connID, _ := p["connectionId"].(string)
	if connID == "" {
		log.Println("OFFER 缺少 connectionId，已忽略")
		return
	}
	srcPeer := s.srcOf(msg)
	if srcPeer == "" {
		log.Println("OFFER 缺少发起方 peer id，已忽略")
		return
	}
	sdpType, sdp := sdpFromPayload(p)
	if sdpType != webrtc.SDPTypeOffer || sdp == "" {
		log.Printf("OFFER 的 SDP 不合法（type=%s, len=%d），已忽略", sdpType, len(sdp))
		return
	}

	log.Printf("成员 %s 请求连接（conn=%s）", srcPeer, connID)

	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{
		ICEServers: iceServers(),
	})
	if err != nil {
		log.Printf("创建 PeerConnection 失败：%v", err)
		return
	}

	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		s.onDataChannel(connID, dc)
	})
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		_ = s.sendJSON(sigMsg{
			Type: "CANDIDATE",
			Dst:  srcPeer,
			Payload: map[string]interface{}{
				"candidate": map[string]interface{}{
					"candidate":     c.String(),
					"sdpMid":        "",
					"sdpMLineIndex": 0,
				},
				"type":         "data",
				"connectionId": connID,
			},
		})
	})
	pc.OnICEConnectionStateChange(func(st webrtc.ICEConnectionState) {
		switch st {
		case webrtc.ICEConnectionStateConnected, webrtc.ICEConnectionStateCompleted:
			log.Printf("conn %s：ICE 已连通", connID)
		case webrtc.ICEConnectionStateFailed, webrtc.ICEConnectionStateClosed:
			log.Printf("conn %s：ICE %s", connID, st)
			s.closeConn(connID, "ICE "+st.String())
		}
	})

	rc := &roomConn{connID: connID, peerID: srcPeer, pc: pc}

	s.connMu.Lock()
	if old, ok := s.conns[connID]; ok {
		if old.pc != nil {
			_ = old.pc.Close()
		}
		delete(s.conns, connID)
	}
	s.pending[connID] = srcPeer
	s.conns[connID] = rc
	s.connMu.Unlock()

	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: sdpType, SDP: sdp}); err != nil {
		log.Printf("SetRemoteDescription 失败：%v", err)
		s.closeConn(connID, "SetRemoteDescription 失败")
		return
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		log.Printf("CreateAnswer 失败：%v", err)
		s.closeConn(connID, "CreateAnswer 失败")
		return
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		log.Printf("SetLocalDescription 失败：%v", err)
		s.closeConn(connID, "SetLocalDescription 失败")
		return
	}

	err = s.sendJSON(sigMsg{
		Type: "ANSWER",
		Dst:  srcPeer,
		Payload: map[string]interface{}{
			"connectionId": connID,
			"type":         "data",
			"sdp": map[string]interface{}{
				"type": answer.Type.String(),
				"sdp":  answer.SDP,
			},
		},
	})
	if err != nil {
		log.Printf("发送 ANSWER 失败：%v", err)
	}
}

func (s *RoomServer) handleCandidate(msg sigMsg) {
	p := msg.Payload
	if p == nil {
		return
	}
	connID, _ := p["connectionId"].(string)
	if connID == "" {
		return
	}
	s.connMu.RLock()
	rc, ok := s.conns[connID]
	s.connMu.RUnlock()
	if !ok || rc.pc == nil {
		return
	}
	cand, mid, mline := candidateFromPayload(p)
	if cand == "" {
		return
	}
	if err := rc.pc.AddICECandidate(webrtc.ICECandidateInit{
		Candidate:     cand,
		SDPMid:        mid,
		SDPMLineIndex: mline,
	}); err != nil {
		log.Printf("AddICECandidate 失败（conn=%s）：%v", connID, err)
	}
}

func (s *RoomServer) onDataChannel(connID string, dc joinChannel) {
	if dc == nil {
		return
	}

	s.connMu.Lock()
	rc := s.conns[connID]
	srcPeer := s.pending[connID]
	s.connMu.Unlock()

	if rc == nil || srcPeer == "" {
		log.Printf("conn %s 的 data channel 已打开，但找不到发起方，已忽略", connID)
		return
	}
	if rc.dc != nil {
		return
	}
	rc.dc = dc

	log.Printf("成员 %s 已加入房间（conn=%s，房间现 %d 人）", srcPeer, connID, s.peerCount())

	dc.OnMessage(func(m webrtc.DataChannelMessage) { s.onMessage(rc, m) })
	dc.OnClose(func() { s.closeConn(connID, "data channel 关闭") })
	dc.OnOpen(func() { s.pushJoinPackets(rc) })
}

func (s *RoomServer) pushJoinPackets(rc *roomConn) {
	if sn := s.store.snapshot(); len(sn) > 0 {
		if err := rc.dc.SendText(string(mustJSON(map[string]interface{}{
			"t": "state", "fullSync": true, "elements": sn,
		}))); err != nil {
			log.Printf("向 %s 推送快照失败：%v", rc.peerID, err)
		}
	}
	s.tellNewcomer(rc)
	s.announceNewcomer(rc)
}

func (s *RoomServer) onMessage(rc *roomConn, m webrtc.DataChannelMessage) {
	var msg struct {
		T        string                 `json:"t"`
		Mid      string                 `json:"mid"`
		El       map[string]interface{} `json:"el"`
		ID       string                 `json:"id"`
		Elements map[string]interface{} `json:"elements"`
	}
	if err := json.Unmarshal(m.Data, &msg); err != nil {
		return
	}

	switch msg.T {
	case "upsert":
		if msg.El != nil {
			s.store.applyUpsert(msg.El)
		}
	case "delete":
		if msg.ID != "" {
			s.store.applyDelete(msg.ID)
		}
	case "state":
		if msg.Elements != nil {
			s.store.mergeAll(asMapOfMaps(msg.Elements))
		}
	case "request":
		if sn := s.store.snapshot(); len(sn) > 0 {
			if err := rc.dc.SendText(string(mustJSON(map[string]interface{}{
				"t": "state", "fullSync": true, "elements": sn,
			}))); err != nil {
				log.Printf("request 回包失败 peer=%s conn=%s: %v", rc.peerID, rc.connID, err)
			}
		}
		return
	}

	if !s.isNewMid(msg.Mid) {
		return
	}
	s.relay(rc, string(m.Data))
}

func (s *RoomServer) removeConn(connID string) *roomConn {
	s.connMu.Lock()
	rc := s.conns[connID]
	delete(s.conns, connID)
	delete(s.pending, connID)
	s.connMu.Unlock()
	if rc == nil {
		return nil
	}
	if rc.pc != nil {
		_ = rc.pc.Close()
	}
	return rc
}

func (s *RoomServer) closeConn(connID, why string) {
	rc := s.removeConn(connID)
	if rc == nil {
		return
	}
	log.Printf("成员 %s 断开（conn=%s，%s；房间剩 %d 人）", rc.peerID, connID, why, s.peerCount())
	s.broadcastPeerList()
}

func (s *RoomServer) closeAllForPeer(peerID, why string) {
	s.connMu.RLock()
	ids := make([]string, 0, 1)
	for id, rc := range s.conns {
		if rc.peerID == peerID {
			ids = append(ids, id)
		}
	}
	s.connMu.RUnlock()
	for _, id := range ids {
		s.closeConn(id, why)
	}
}

func (s *RoomServer) peerIDs(excludeConnID string) []string {
	s.connMu.RLock()
	defer s.connMu.RUnlock()
	seen := map[string]bool{}
	out := []string{}
	for id, rc := range s.conns {
		if id == excludeConnID || rc.peerID == "" || seen[rc.peerID] {
			continue
		}
		seen[rc.peerID] = true
		out = append(out, rc.peerID)
	}
	return out
}

func (s *RoomServer) tellNewcomer(rc *roomConn) {
	list := s.peerIDs(rc.connID)
	if len(list) == 0 {
		return
	}
	if err := rc.dc.SendText(string(mustJSON(map[string]interface{}{"t": "peer_list", "list": list}))); err != nil {
		log.Printf("tellNewcomer 发送失败 peer=%s conn=%s: %v", rc.peerID, rc.connID, err)
	}
}

func (s *RoomServer) announceNewcomer(rc *roomConn) {
	if rc.peerID == "" {
		return
	}
	payload := string(mustJSON(map[string]interface{}{
		"t": "peer_list", "list": []string{rc.peerID},
	}))
	s.connMu.RLock()
	targets := make([]*roomConn, 0, len(s.conns))
	for _, other := range s.conns {
		if other == rc || other.dc == nil {
			continue
		}
		targets = append(targets, other)
	}
	s.connMu.RUnlock()
	for _, t := range targets {
		if err := t.dc.SendText(payload); err != nil {
			log.Printf("announceNewcomer 发送失败 peer=%s conn=%s: %v", t.peerID, t.connID, err)
			s.closeConn(t.connID, "announceNewcomer 发送失败")
		}
	}
}

func (s *RoomServer) broadcastPeerList() {
	list := s.peerIDs("")
	if len(list) == 0 {
		return
	}
	payload := string(mustJSON(map[string]interface{}{"t": "peer_list", "list": list}))
	s.connMu.RLock()
	targets := make([]*roomConn, 0, len(s.conns))
	for _, rc := range s.conns {
		if rc.dc != nil {
			targets = append(targets, rc)
		}
	}
	s.connMu.RUnlock()
	for _, t := range targets {
		if err := t.dc.SendText(payload); err != nil {
			log.Printf("broadcastPeerList 发送失败 peer=%s conn=%s: %v", t.peerID, t.connID, err)
			s.closeConn(t.connID, "broadcastPeerList 发送失败")
		}
	}
}

func (s *RoomServer) relay(src *roomConn, body string) {
	s.connMu.RLock()
	targets := make([]*roomConn, 0, len(s.conns))
	for _, rc := range s.conns {
		if rc == src || rc.dc == nil {
			continue
		}
		targets = append(targets, rc)
	}
	s.connMu.RUnlock()
	for _, t := range targets {
		if err := t.dc.SendText(body); err != nil {
			log.Printf("转发失败 peer=%s conn=%s: %v", t.peerID, t.connID, err)
			s.closeConn(t.connID, "relay SendText 失败")
		}
	}
}

// isNewMid 使用环形滑动窗口淘汰最旧的 mid，避免原版满载清空导致瞬间去重失效。
func (s *RoomServer) isNewMid(mid string) bool {
	if mid == "" {
		return true
	}
	s.seenMu.Lock()
	defer s.seenMu.Unlock()
	if _, ok := s.seen[mid]; ok {
		return false
	}
	if len(s.seenRing) < maxRelayed {
		s.seenRing = append(s.seenRing, mid)
	} else {
		oldest := s.seenRing[s.seenIdx]
		delete(s.seen, oldest)
		s.seenRing[s.seenIdx] = mid
		s.seenIdx = (s.seenIdx + 1) % maxRelayed
	}
	s.seen[mid] = struct{}{}
	return true
}

func (s *RoomServer) peerCount() int {
	s.connMu.RLock()
	defer s.connMu.RUnlock()
	seen := map[string]bool{}
	for _, rc := range s.conns {
		if rc.peerID != "" {
			seen[rc.peerID] = true
		}
	}
	return len(seen)
}

func (s *RoomServer) signalingUp() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ws != nil
}

func (s *RoomServer) Stats() map[string]interface{} {
	return map[string]interface{}{
		"status":    "ok",
		"room":      s.RoomName,
		"host":      s.Host,
		"version":   version,
		"signaling": s.signalingUp(),
		"peers":     s.peerCount(),
		"elements":  s.store.size(),
		"uptime":    int(time.Since(s.started).Seconds()),
	}
}

func (s *RoomServer) ServeHTTP(ctx context.Context, addr string) {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(s.Stats())
	})
	mux.HandleFunc("/dump", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(s.store.toJSON())
	})
	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		_ = srv.Shutdown(context.Background())
	}()
	go func() {
		log.Printf("状态接口监听 %s（/health /dump）", addr)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Printf("HTTP 服务退出：%v", err)
		}
	}()
}

func normalizeHost(host string) (string, bool) {
	h := strings.TrimSpace(host)
	secure := true
	switch {
	case strings.HasPrefix(h, "ws://"), strings.HasPrefix(h, "http://"):
		secure = false
		h = strings.TrimPrefix(strings.TrimPrefix(h, "ws://"), "http://")
	case strings.HasPrefix(h, "wss://"), strings.HasPrefix(h, "https://"):
		h = strings.TrimPrefix(strings.TrimPrefix(h, "wss://"), "https://")
	}
	h = strings.TrimSuffix(h, "/")
	if h == "" {
		return defaultPeerHost + ":443", true
	}
	if !strings.Contains(h, ":") {
		if secure {
			h += ":443"
		} else {
			h += ":80"
		}
	}
	return h, secure
}

func sdpFromPayload(p map[string]interface{}) (webrtc.SDPType, string) {
	switch v := p["sdp"].(type) {
	case map[string]interface{}:
		t, _ := v["type"].(string)
		d, _ := v["sdp"].(string)
		return parseSDPType(t), d
	case string:
		return webrtc.SDPTypeOffer, v
	default:
		return 0, ""
	}
}

func parseSDPType(t string) webrtc.SDPType {
	switch strings.ToLower(t) {
	case "offer":
		return webrtc.SDPTypeOffer
	case "answer":
		return webrtc.SDPTypeAnswer
	case "pranswer", "pr-answer":
		return webrtc.SDPTypePranswer
	case "rollback":
		return webrtc.SDPTypeRollback
	default:
		return 0
	}
}

func candidateFromPayload(p map[string]interface{}) (string, *string, *uint16) {
	switch v := p["candidate"].(type) {
	case map[string]interface{}:
		c, _ := v["candidate"].(string)
		var mid *string
		if m, ok := v["sdpMid"].(string); ok {
			mid = &m
		}
		var mline *uint16
		if n, ok := v["sdpMLineIndex"].(float64); ok && n >= 0 {
			u := uint16(n)
			mline = &u
		}
		return c, mid, mline
	case string:
		return v, nil, nil
	default:
		return "", nil, nil
	}
}

func asMapOfMaps(in map[string]interface{}) map[string]map[string]interface{} {
	if in == nil {
		return nil
	}
	out := make(map[string]map[string]interface{}, len(in))
	for k, v := range in {
		if m, ok := v.(map[string]interface{}); ok {
			out[k] = m
		}
	}
	return out
}

func iceServers() []webrtc.ICEServer {
	return []webrtc.ICEServer{
		{URLs: []string{"stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"}},
		{
			URLs:       []string{"turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"},
			Username:   "peerjs",
			Credential: "peerjsp",
		},
	}
}

func mustJSON(v interface{}) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		log.Printf("序列化失败：%v", err)
		return []byte("{}")
	}
	return b
}

func randomToken(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return hex.EncodeToString(b)
}
