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
	_ = mustJSON(snap)
}

func TestStoreRevConflict(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","text":"NEW","rev":5}}`))
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","text":"OLD","rev":3}}`))
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","text":"SAME","rev":5}}`))

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

// TestStoreDelete 删除后快照不再含该元素；旧版本快照 mergeAll 不会复活，更高 rev 的显式 upsert 可恢复。
func TestStoreDelete(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","rev":1}}`))
	s.applyDelete("n1")
	if s.size() != 0 {
		t.Fatalf("删除后 size=%d，期望 0", s.size())
	}
	s.applyDelete("not-exists") // 幂等，不应 panic

	// 旧快照（rev=1 <= 墓碑 rev=1）不能把已删除元素复活
	s.mergeAll(map[string]map[string]interface{}{
		"n1": {"id": "n1", "rev": float64(1)},
	})
	if s.size() != 0 {
		t.Fatalf("旧快照不应复活已删除元素")
	}

	// 更高 rev（rev=2 > 1）显式 upsert 可恢复（例如协同撤销删除）
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","rev":2}}`))
	if s.size() != 1 {
		t.Fatalf("复活失败")
	}
}

func TestStoreMergeAll(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"a","text":"local-new","rev":9}}`))
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"b","text":"old","rev":1}}`))

	all := map[string]map[string]interface{}{
		"a": {"id": "a", "text": "incoming-old", "rev": float64(2)},
		"b": {"id": "b", "text": "incoming-new", "rev": float64(7)},
		"c": {"id": "c", "text": "incoming-new", "rev": float64(1)},
		"":  {"id": "", "rev": float64(1)},
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

func TestStoreRevOf(t *testing.T) {
	cases := []struct {
		val  interface{}
		want int
	}{
		{float64(42), 42},
		{int(7), 7},
		{int64(9), 9},
		{json.Number("3"), 3},
		{"3", 0},
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

func TestStoreRevTieCID(t *testing.T) {
	fromA := parseJSON(t, `{"id":"n1","text":"from-A","rev":5,"cid":"A"}`)
	fromB := parseJSON(t, `{"id":"n1","text":"from-B","rev":5,"cid":"B"}`)

	s := newStore()
	s.applyUpsert(fromA)
	s.applyUpsert(fromB)
	if got := s.snapshot()["n1"].(map[string]interface{})["text"]; got != "from-B" {
		t.Fatalf("先 A 后 B 保留 %v，期望 from-B", got)
	}

	s2 := newStore()
	s2.applyUpsert(fromB)
	s2.applyUpsert(fromA)
	if got := s2.snapshot()["n1"].(map[string]interface{})["text"]; got != "from-B" {
		t.Fatalf("先 B 后 A 保留 %v，期望 from-B", got)
	}

	s3 := newStore()
	s3.applyUpsert(parseJSON(t, `{"id":"n1","text":"high-rev","rev":6,"cid":"A"}`))
	s3.applyUpsert(parseJSON(t, `{"id":"n1","text":"low-rev","rev":5,"cid":"Z"}`))
	if got := s3.snapshot()["n1"].(map[string]interface{})["text"]; got != "high-rev" {
		t.Fatalf("rev 优先被破坏：%v", got)
	}

	s4 := newStore()
	s4.applyUpsert(parseJSON(t, `{"id":"n1","text":"same","rev":5,"cid":"B"}`))
	s4.applyUpsert(parseJSON(t, `{"id":"n1","text":"same","rev":5,"cid":"B"}`))
	if got := s4.snapshot()["n1"].(map[string]interface{})["text"]; got != "same" {
		t.Fatalf("完全相同元素被无谓覆盖：%v", got)
	}
}

func TestStoreMergeAllTieCID(t *testing.T) {
	s := newStore()
	s.applyUpsert(parseJSON(t, `{"id":"a","text":"old","rev":3,"cid":"A"}`))
	all := map[string]map[string]interface{}{
		"a": parseJSON(t, `{"id":"a","text":"new-tie","rev":3,"cid":"B"}`),
	}
	s.mergeAll(all)
	if got := s.snapshot()["a"].(map[string]interface{})["text"]; got != "new-tie" {
		t.Fatalf("mergeAll rev 平局 cid 决胜失败：%v", got)
	}
}

func TestStoreSnapshotIsCopy(t *testing.T) {
	s := newStore()
	s.applyUpsert(mustRevOf(t, `{"el":{"id":"n1","rev":1}}`))
	out := s.snapshot()
	if reflect.ValueOf(out["n1"]).Pointer() == reflect.ValueOf(s.snapshot()["n1"]).Pointer() {
		t.Fatal("snapshot 元素级未拷贝，外部可篡改 store")
	}
	delete(out, "n1")
	if s.size() != 1 {
		t.Fatal("外部删除快照条目影响了 store")
	}
}
