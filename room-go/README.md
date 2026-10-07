# room server（Go）

无头房间服务器。浏览器打开白板页面后 PeerJS 会给它随机分配一个短 id，别人要
加入必须知道这个 id，而且那个浏览器不能关。本程序反过来：它用一个**固定房间号**
注册到同一套 PeerJS 信令网络上，房间于是常驻在线——只要进程在跑，任何人用该
房间号都能加入。

## 它做三件事

1. **占住房间号**：以一个固定 room id 挂在 PeerJS 信令网络上，收到 `OPEN` 即上线。
2. **持有白板内容**：白板元素随 `upsert`/`delete` 增量到达，本程序按 `rev` 合并成
   一份完整快照。新成员加入即推送整份快照，也响应 `request` 回快照。
   于是房间内容不依赖任何单个浏览器存活，浏览器关掉重开内容还在。
3. **成员登记与中继**：记录当前在线成员，新成员加入广播 `peer_list`、离开时刷新；
   收到的白板消息原样转发给其他成员，并按 `mid` 去重（前端自己也按 `mid` 去重，
   两侧叠加不会重复渲染）。

代码：`main.go`（命令行入口）、`room.go`（PeerJS 信令 + WebRTC）、`store.go`
（白板快照）。

## 构建

```sh
cd room-go
go build -ldflags="-X main.version=v1.0.0" -o room .
```

检查：

```sh
gofmt -l *.go        # 应为空
go vet ./...
go test ./...
```

## 运行

```sh
room                                  # 房间号 wb-room
room my-room                          # 指定房间号
room -host 0.peerjs.com -key peerjs   # 自建信令服务器
room -http 0                          # 关闭状态 HTTP 接口
room -version                         # 打印版本
```

环境变量等价写法：`ROOM_NAME` / `PEER_HOST` / `PEER_KEY` / `HEARTBEAT_MS` / `HTTP_ADDR`。

```sh
ROOM_NAME=my-room room
```

- 房间号即 PeerJS peer id，需匹配 `^[A-Za-z0-9]+([ _-][A-Za-z0-9]+)*$`。
- 房间号在信令服务器上是**全局唯一**的：重复注册会收到 `ID-TAKEN`，本程序随即退出并返回非零退出码，不会与另一个实例挤在同一房间里。云端 `0.peerjs.com` 同样强制拒绝——实测 5/5：
  A 保持在线时再起一个同名 B，B 每次都拿到 `ID-TAKEN`，A 不受影响。自建信令服务器行为一致。
- 需要崩溃自愈就在外面套进程守护：systemd `Restart=always` 或 docker `restart: unless-stopped`。
  重试该由守护层负责；本进程收到 `ID-TAKEN` 就退出，因为它撞的是别人的名字，再试也不会成功。
- 本进程必须保持运行，房间才会在线。

### 浏览器加入

打开白板页面 → 【连接/加入】里填房间号（或访问 `页面地址#room=房间号`）。

## 状态接口

默认监听 `:8787`：

| 路径 | 说明 |
| --- | --- |
| `GET /health` | 房间号、在线成员数、快照元素数、信令是否在线、uptime、版本 |
| `GET /dump` | 房间当前持有的白板元素快照 JSON |

## 发布

`.github/workflows/release-room.yml`：

- 推送 `v*` tag → 构建全平台产物并发布 GitHub Release（linux/darwin 的
  `tar.gz`、windows 的 `zip`，另附 `SHA256SUMS.txt`）
- Actions → Run workflow 手动指定版本号 → 同上
- 推送 master → 只跑 vet/test 并上传 artifact，不建 Release

版本号注入方式：`go build -ldflags="-X main.version=v1.0.0"`。
