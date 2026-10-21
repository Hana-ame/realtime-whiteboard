package main

import (
	"encoding/json"
	"sync"
)

// store 是房间侧的白板快照：一份按 (rev, cid) 合并的元素副本，并带有版本化删除墓碑（tombstones）。
//
// 它存在的意义是让房间"独立于浏览器存活"：所有成员离线时画布内容不丢，
// 下一个成员加入就能立刻看到完整内容，而不必等某个在线的老成员同步。
// 墓碑记录删除时的已知最高 rev（至少为 1）：旧快照（mergeAll）或滞后消息若携带 <= 墓碑版本的
// 元素不会使已删元素复活；而更高 rev 的显式 upsert 则可正常更新/恢复。
type store struct {
	mu         sync.RWMutex
	elements   map[string]map[string]interface{}
	tombstones map[string]int
}

func newStore() *store {
	return &store{
		elements:   make(map[string]map[string]interface{}),
		tombstones: make(map[string]int),
	}
}

// revOf 取元素的版本号，缺失时按 0 处理。JSON 反序列化出的数字是 float64。
func revOf(el map[string]interface{}) int {
	if el == nil {
		return 0
	}
	switch v := el["rev"].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case int64:
		return int(v)
	case json.Number:
		if n, err := v.Int64(); err == nil {
			return int(n)
		}
	}
	return 0
}

// beatsRevCid 与前端 src/js/crdt.js 的 beats() 完全一致：rev 大者赢；rev
// 相同则 cid（最后一次改动的客户端 PeerJS id）字典序大者赢。
func beatsRevCid(a, b map[string]interface{}) bool {
	ar, br := revOf(a), revOf(b)
	if ar != br {
		return ar > br
	}
	return cidOf(a) > cidOf(b)
}

// cidOf 取元素的 cid（写入者 PeerJS id），缺失时按空串处理。
func cidOf(el map[string]interface{}) string {
	if el == nil {
		return ""
	}
	v, _ := el["cid"].(string)
	return v
}

// applyUpsert 按 (rev, cid) 更新单个元素，拦截版本不高于墓碑的过期重放。
func (s *store) applyUpsert(el map[string]interface{}) {
	if el == nil {
		return
	}
	id, _ := el["id"].(string)
	if id == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if delRev, deleted := s.tombstones[id]; deleted {
		if revOf(el) <= delRev {
			return
		}
		delete(s.tombstones, id)
	}
	if cur, ok := s.elements[id]; !ok || beatsRevCid(el, cur) {
		s.elements[id] = el
	}
}

// applyDelete 删除单个元素并记录版本墓碑。
func (s *store) applyDelete(id string) {
	if id == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	curRev := 1
	if cur, ok := s.elements[id]; ok {
		if r := revOf(cur); r > curRev {
			curRev = r
		}
	}
	if prevDel, ok := s.tombstones[id]; ok && prevDel > curRev {
		curRev = prevDel
	}
	s.tombstones[id] = curRev
	delete(s.elements, id)
}

// mergeAll 合并一份快照（来自某成员的 state/fullSync），按 (rev, cid) 取新并过滤已删墓碑。
func (s *store) mergeAll(all map[string]map[string]interface{}) {
	if len(all) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for id, el := range all {
		if id == "" {
			continue
		}
		if delRev, deleted := s.tombstones[id]; deleted && revOf(el) <= delRev {
			continue
		}
		delete(s.tombstones, id)
		if cur, ok := s.elements[id]; !ok || beatsRevCid(el, cur) {
			s.elements[id] = el
		}
	}
}

// snapshot 返回快照副本，可直接塞进 {t:"state", elements:...} 发出去。
func (s *store) snapshot() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]interface{}, len(s.elements))
	for id, el := range s.elements {
		out[id] = deepCopyMap(el)
	}
	return out
}

func deepCopyMap(m map[string]interface{}) map[string]interface{} {
	b, err := json.Marshal(m)
	if err != nil {
		return shallowCopyMap(m)
	}
	var out map[string]interface{}
	if json.Unmarshal(b, &out) != nil {
		return shallowCopyMap(m)
	}
	return out
}

func shallowCopyMap(m map[string]interface{}) map[string]interface{} {
	out := make(map[string]interface{}, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (s *store) size() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return len(s.elements)
}

func (s *store) toJSON() []byte {
	return mustJSON(s.snapshot())
}
