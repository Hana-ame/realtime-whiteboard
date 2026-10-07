// Command room 是 realtime-whiteboard 的无头房间服务器。
//
// 浏览器打开白板页面后，PeerJS 会给它随机分配一个短 id，别人要加入就得知道
// 这个 id。本程序反过来：它用一个固定房间号注册到同一套 PeerJS 信令网络上，
// 房间于是常驻在线——只要这个进程在跑，任何人用该房间号都能加入，不必再有
// "某台电脑必须一直开着白板页面" 的前提。
//
// 光"占住房间号"并不足够有用，所以本程序额外做三件事：
//
//  1. 白板内容快照。白板元素（note/stroke/connection/image）会随 upsert/delete
//     增量同步，房间服务器把它们按 rev 合并成一份完整快照。新成员加入即推送
//     整份快照，也响应 request 消息回快照。于是房间里的白板内容不依赖任何单个
//     浏览器存活，浏览器关掉重开内容还在。
//  2. 成员登记与广播。房间知道当前有哪些成员在线，新成员加入时广播 peer_list，
//     离开时刷新，前端据此自动建立全网状连接。
//  3. 消息中继。收到的白板消息（除 request 外）按原样转发给房间内其他成员，
//     并做 mid 去重；前端本身也按 mid 去重，两侧叠加不会重复渲染。
//
// 用法：
//
//	room                          # 房间号 wb-room
//	room my-room                  # 指定房间号
//	room -host 0.peerjs.com -key peerjs -heartbeat 10000
//	ROOM_NAME=my-room room        # 环境变量等价写法
//	room -http 0                  # 关闭状态 HTTP 接口
//
// 房间号即 PeerJS peer id，需匹配 ^[A-Za-z0-9]+([ _-][A-Za-z0-9]+)*$。
// 收到 ID-TAKEN 说明房间号已被占用，程序退出；云端信令是负载均衡集群，
// 唯一性需要使用者自己保证只跑一个实例。
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"
)

// version 由 -ldflags "-X main.version=v1.0.0" 注入，未注入时保持 dev。
var version = "dev"

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func main() {
	room := flag.String("room", envStr("ROOM_NAME", "wb-room"), "房间号，作为 PeerJS peer id；浏览器用它加入")
	host := flag.String("host", envStr("PEER_HOST", "0.peerjs.com"), "PeerJS 信令服务器，如 0.peerjs.com 或自建的 localhost:9000")
	key := flag.String("key", envStr("PEER_KEY", "peerjs"), "PeerJS API key（云端免费 key 为 peerjs）")
	heartbeat := flag.Int("heartbeat", envInt("HEARTBEAT_MS", 10000), "心跳间隔（毫秒）")
	httpAddr := flag.String("http", envStr("HTTP_ADDR", ":8787"), "状态 HTTP 监听地址，传 0 或空字符串关闭")
	showVersion := flag.Bool("version", false, "打印版本后退出")
	flag.Parse()

	if *showVersion {
		fmt.Printf("room-server %s\n", version)
		return
	}

	log.SetPrefix("[room] ")
	log.SetFlags(log.Ltime)

	srv := NewRoomServer(Options{
		RoomName:  *room,
		Host:      *host,
		Key:       *key,
		Heartbeat: time.Duration(*heartbeat) * time.Millisecond,
	})

	banner(srv, *httpAddr)

	// 收到 SIGINT/SIGTERM 即取消 ctx，Run 退出并清理资源。
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if *httpAddr != "" && *httpAddr != "0" {
		go srv.ServeHTTP(ctx, *httpAddr)
	}

	if err := srv.Run(ctx); err != nil {
		log.Printf("运行结束：%v", err)
	}
}

func banner(s *RoomServer, httpAddr string) {
	fmt.Printf("realtime-whiteboard room server %s\n", version)
	fmt.Printf("  房间号       : %s\n", s.RoomName)
	fmt.Printf("  信令服务器   : %s\n", s.Host)
	fmt.Printf("  浏览器加入   : 打开白板页面，在【连接/加入】里填 %q\n", s.RoomName)
	if httpAddr != "" && httpAddr != "0" {
		fmt.Printf("  状态接口     : http://localhost%s/health\n", httpAddr)
	}
	fmt.Println("  注意         : 本进程必须保持运行，房间才会在线。")
}
