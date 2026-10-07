package main

import (
	"encoding/json"
	"sync"
)

// store 是房间侧的白板快照：一份按 rev 合并的元素副本。
//
// 它存在的意义是让房间"独立于浏览器存活"：所有成员离线时画布内容不丢，
// 下一个成员加入就能立刻看到完整内容，而不必等某个在线的老成员在线同步。
// 写入端（浏览器）仍然是权威的，store 只是被动镜像。
type store struct {
	mu       sync.RWMutex
	elements map[string]map[string]interface{}
}

func newStore() *store {
	return &store{elements: make(map[string]map[string]interface{})}
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

// applyUpsert 按 rev 更新单个元素。
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
	if cur, ok := s.elements[id]; !ok || revOf(el) > revOf(cur) {
		s.elements[id] = el
	}
}

// applyDelete 删除单个元素。
func (s *store) applyDelete(id string) {
	if id == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.elements, id)
}

// mergeAll 合并一份快照（来自某成员的 state/fullSync），同样按 rev 取新。
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
		if cur, ok := s.elements[id]; !ok || revOf(el) > revOf(cur) {
			s.elements[id] = el
		}
	}
}

// snapshot 返回快照副本，可直接塞进 {t:"state", elements:...} 发出去。
//
// 元素做深拷贝：调用方拿到快照后不应该能反过来改到 store 里的内容
// （快照会先被 JSON 序列化发出去，但接口本身不应隐含"只读"约定）。
// 入站方向不做深拷贝——入站元素由本 store 独占持有，序列化完即弃。
func (s *store) snapshot() map[string]interface{} {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]interface{}, len(s.elements))
	for id, el := range s.elements {
		out[id] = deepCopyMap(el)
	}
	return out
}

// deepCopyMap 通过 JSON 往返深拷贝。元素本身来自 JSON 反序列化，
// 因此一定可序列化；万一失败退化为浅拷贝（仍能保证 map 本身不被外部替换）。
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

// toJSON 输出快照的 JSON 文本，供 /dump 使用。
func (s *store) toJSON() []byte {
	return mustJSON(s.snapshot())
}
