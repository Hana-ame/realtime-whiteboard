package main

import (
	"encoding/json"
	"io"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/pion/webrtc/v3"
)

// fakeDC 模拟 pion DataChannel 的时序契约：OnDataChannel 回调期间 channel 仍是
// connecting，SendText 返回 io.ErrClosedPipe（消息静默丢失、不缓冲）；直到
// handleOpen 之后才真正 open。测试用它验证"推送必须等 channel open 之后再做"。
type fakeDC struct {
	mu     sync.Mutex
	state  string // "connecting" | "open"
	openFn func()
	out    []string
}

func (f *fakeDC) OnMessage(func(webrtc.DataChannelMessage)) {}
func (f *fakeDC) OnClose(func())                            {}
func (f *fakeDC) OnOpen(fn func())                          { f.openFn = fn }

func (f *fakeDC) SendText(s string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.state != "open" {
		return io.ErrClosedPipe
	}
	f.out = append(f.out, s)
	return nil
}

// open 模拟 pion handleOpen：先置 open 再同步触发 OnOpen。
func (f *fakeDC) open() {
	f.mu.Lock()
	f.state = "open"
	fn := f.openFn
	f.mu.Unlock()
	if fn != nil {
		fn()
	}
}

func (f *fakeDC) sent() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.out))
	copy(out, f.out)
	return out
}

// mustMsg 把发送缓冲区里的 JSON 文本解析成 {t, ...}。
type testMsg struct {
	T        string                 `json:"t"`
	FullSync bool                   `json:"fullSync"`
	List     []string               `json:"list"`
	Elements map[string]interface{} `json:"elements"`
}

func decodeMsgs(t *testing.T, raw []string) []testMsg {
	t.Helper()
	out := make([]testMsg, 0, len(raw))
	for _, s := range raw {
		var m testMsg
		if err := json.Unmarshal([]byte(s), &m); err != nil {
			t.Fatalf("发送内容不是合法 JSON：%v\n%s", err, s)
		}
		out = append(out, m)
	}
	return out
}

func findPeerList(msgs []testMsg) []string {
	for _, m := range msgs {
		if m.T == "peer_list" {
			return m.List
		}
	}
	return nil
}

func TestJoinPushesWaitForOpen(t *testing.T) {
	s := NewRoomServer(Options{RoomName: "wb-room", Host: "localhost:9000", Key: "peerjs", Heartbeat: time.Second})
	// 房间里已有内容 + 一个老成员。
	s.store.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","type":"note","text":"hi","rev":1,"cid":"A"}}`))
	oldDC := &fakeDC{state: "open"}
	s.conns["conn-old"] = &roomConn{connID: "conn-old", peerID: "oldpeer", dc: oldDC}

	// 新成员连接到达：channel 此刻仍 connecting。
	newDC := &fakeDC{state: "connecting"}
	s.pending["conn-new"] = "newpeer"
	s.conns["conn-new"] = &roomConn{connID: "conn-new", peerID: "newpeer"} // dc 由 onDataChannel 挂载，与真实 handleOffer 流程一致

	s.onDataChannel("conn-new", newDC)

	// 注册阶段（channel connecting）绝不能发送：修复前这三封消息在这里发出，
	// SendText 全部返回 io.ErrClosedPipe 静默丢失——新成员拿不到快照和成员名单，
	// 老成员也收不到新成员通知，两个浏览器永远互相不知道对方存在。
	if got := newDC.sent(); len(got) != 0 {
		t.Fatalf("channel 未 open 就发送了 %d 条消息（这些必然丢失）：%v", len(got), got)
	}
	if got := oldDC.sent(); len(got) != 0 {
		t.Fatalf("channel 未 open 就向老成员发送了：%v", got)
	}

	// channel open 之后才允许推送。
	newDC.open()

	// 新成员应收到：整份快照 + 已有成员名单。
	msgs := decodeMsgs(t, newDC.sent())
	var gotFullSync *testMsg
	for i := range msgs {
		if msgs[i].T == "state" && msgs[i].FullSync {
			gotFullSync = &msgs[i]
		}
	}
	if gotFullSync == nil {
		t.Fatalf("新成员没收到 fullSync 快照，只收到：%v", msgs)
	}
	if _, ok := gotFullSync.Elements["n1"]; !ok {
		t.Fatalf("快照缺少 n1：%v", gotFullSync.Elements)
	}
	if list := findPeerList(msgs); !reflect.DeepEqual(list, []string{"oldpeer"}) {
		t.Fatalf("新成员收到的成员名单 = %v，期望 [oldpeer]", list)
	}

	// 老成员应收到新成员通知，从而直连新成员凑全网络状。
	if list := findPeerList(decodeMsgs(t, oldDC.sent())); !reflect.DeepEqual(list, []string{"newpeer"}) {
		t.Fatalf("老成员收到的通知 = %v，期望 [newpeer]", list)
	}
}

// TestJoinNoPushWhenAlone 房间里只有自己时，打开后也不应有任何推送
// （快照为空、无人可通知），SendText 不该被调用。
func TestJoinNoPushWhenAlone(t *testing.T) {
	s := NewRoomServer(Options{RoomName: "wb-room", Host: "localhost:9000", Key: "peerjs", Heartbeat: time.Second})
	newDC := &fakeDC{state: "connecting"}
	s.pending["conn-new"] = "newpeer"
	s.conns["conn-new"] = &roomConn{connID: "conn-new", peerID: "newpeer"} // dc 由 onDataChannel 挂载，与真实 handleOffer 流程一致
	s.onDataChannel("conn-new", newDC)
	newDC.open()
	if got := newDC.sent(); len(got) != 0 {
		t.Fatalf("空房间不该有任何推送：%v", got)
	}
}

// TestJoinPushesReentrant 重复触发 open（真实 pion 只触发一次，此处模拟异常
// 路径）不得 panic，推送必须正常送达；重复消息由前端 mid/seen 与 beats() 去重，
// 房间服务器无需额外幂等。
func TestJoinPushesReentrant(t *testing.T) {
	s := NewRoomServer(Options{RoomName: "wb-room", Host: "localhost:9000", Key: "peerjs", Heartbeat: time.Second})
	s.store.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","rev":1}}`))
	newDC := &fakeDC{state: "connecting"}
	s.pending["conn-new"] = "newpeer"
	s.conns["conn-new"] = &roomConn{connID: "conn-new", peerID: "newpeer"} // dc 由 onDataChannel 挂载，与真实 handleOffer 流程一致
	s.onDataChannel("conn-new", newDC)
	newDC.open()
	newDC.open() // 异常路径：重复 open 不应 panic，快照必须照常送达
	msgs := decodeMsgs(t, newDC.sent())
	fullSyncs := 0
	for _, m := range msgs {
		if m.T == "state" && m.FullSync {
			fullSyncs++
		}
	}
	if fullSyncs < 1 {
		t.Fatalf("open 后未收到 fullSync，实际消息：%v", newDC.sent())
	}
}
