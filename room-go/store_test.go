package main

import (
	"encoding/json"
	"reflect"
	"testing"
)

// parseJSON 模拟浏览器发来的消息经 JSON 反序列化后的形态：
// 数字一律是 float64，这和真实运行时的 rev 类型一致。
func parseJSON(t *testing.T, s string) map[string]interface{} {
	t.Helper()
	var m map[string]interface{}
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		t.Fatalf("JSON 解析失败：%v", err)
	}
	return m
}

func mustRevOf(t *testing.T, s string) map[string]interface{} {
	t.Helper()
	m := parseJSON(t, s)
	return m["el"].(map[string]interface{})
}

func TestStoreUpsertAndSnapshot(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"t":"upsert","el":{"id":"n1","type":"note","text":"hello","rev":1}}`))
	s.applyUpsert(mustRevOf(t, `{"t":"upsert","el":{"id":"n2","type":"stroke","points":[1,2,3],"rev":1}}`))

	if s.size() != 2 {
		t.Fatalf("size=%d，期望 2", s.size())
	}
	snap := s.snapshot()
	if _, ok := snap["n1"]; !ok {
		t.Fatalf("快照缺少 n1：%v", snap)
	}
	// 快照必须能直接塞进 state 消息发出去
	_ = mustJSON(snap)
}

// TestStoreRevConflict 核心语义：低 rev 不得覆盖高 rev，这是快照能容忍
// 乱序/重复/过期消息的前提。
func TestStoreRevConflict(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","text":"NEW","rev":5}}`))
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","text":"OLD","rev":3}}`))  // 过期，应被丢弃
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","text":"SAME","rev":5}}`)) // 同 rev，应被丢弃

	// 直接读回元素（走快照路径）
	snap := s.snapshot()
	n1 := snap["n1"].(map[string]interface{})
	if n1["text"] != "NEW" {
		t.Fatalf("rev 冲突处理错误：text=%v，期望 NEW", n1["text"])
	}

	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","text":"NEWER","rev":6}}`))
	snap = s.snapshot()
	if snap["n1"].(map[string]interface{})["text"] != "NEWER" {
		t.Fatalf("更高 rev 未生效")
	}
}

// TestStoreDelete 删除后快照不再含该元素；重新 upsert 可复活。
func TestStoreDelete(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","rev":1}}`))
	s.applyDelete("n1")
	if s.size() != 0 {
		t.Fatalf("删除后 size=%d，期望 0", s.size())
	}
	s.applyDelete("not-exists") // 幂等，不应 panic
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","rev":2}}`))
	if s.size() != 1 {
		t.Fatalf("复活失败")
	}
}

// TestStoreMergeAll 成员推送的完整快照按 rev 合并，而不是整表覆盖。
func TestStoreMergeAll(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"a","text":"local-new","rev":9}}`))
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"b","text":"old","rev":1}}`))

	all := map[string]map[string]interface{}{
		"a": map[string]interface{}{"id": "a", "text": "incoming-old", "rev": float64(2)},
		"b": map[string]interface{}{"id": "b", "text": "incoming-new", "rev": float64(7)},
		"c": map[string]interface{}{"id": "c", "text": "incoming-new", "rev": float64(1)},
		"":  map[string]interface{}{"id": "", "rev": float64(1)}, // 空 id 应被跳过
	}
	s.mergeAll(all)

	if s.size() != 3 {
		t.Fatalf("size=%d，期望 3（空 id 跳过）", s.size())
	}
	snap := s.snapshot()
	if snap["a"].(map[string]interface{})["text"] != "local-new" {
		t.Fatalf("低 rev 的 incoming 覆盖了高 rev 的本地元素：%v", snap["a"])
	}
	if snap["b"].(map[string]interface{})["text"] != "incoming-new" {
		t.Fatalf("高 rev 的 incoming 未生效：%v", snap["b"])
	}
}

// TestStoreRevOf 覆盖 rev 的各种输入类型，尤其是 JSON 反序列化产生的 float64。
func TestStoreRevOf(t *testing.T) {
	cases := []struct {
		val  interface{}
		want int
	}{
		{float64(42), 42},
		{int(7), 7},
		{int64(9), 9},
		{json.Number("3"), 3},
		{"3", 0}, // 字符串不被当数字，按 0 处理
		{nil, 0},
		{"", 0},
	}
	for _, c := range cases {
		got := revOf(map[string]interface{}{"rev": c.val})
		if got != c.want {
			t.Errorf("revOf(%#v)=%d，期望 %d", c.val, got, c.want)
		}
	}
	if revOf(nil) != 0 {
		t.Error("revOf(nil) 应为 0")
	}
}

// TestStoreSnapshotIsCopy 快照是副本：拿到快照后改它不能污染 store。
func TestStoreSnapshotIsCopy(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","rev":1}}`))
	out := s.snapshot()
	// map 不能用 == 比较（编译期不允许），用底层指针判断是否同一份元素。
	if reflect.ValueOf(out["n1"]).Pointer() == reflect.ValueOf(s.snapshot()["n1"]).Pointer() {
		t.Fatal("snapshot 元素级未拷贝，外部可篡改 store")
	}
	delete(out, "n1")
	if s.size() != 1 {
		t.Fatal("外部删除快照条目影响了 store")
	}
}
