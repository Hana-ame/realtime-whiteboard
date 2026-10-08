# GEMINI.md — 外包给 Gemini Agent 的任务交接工作流

> 本文件是**任务交接协议**：把一段单目标、可验证的工作写成一段文字，交给 Gemini 独立执行，产出收回落档。
> 当前状态（2026-10-08）：**通道存在但不可用**（详见「通道探测结论」）。文件仍按「通道可用时的玩法」+「启用路径」双轨建立，通道一通即可复用。

## 一、环境上下文（Gemini 该知道什么）

- 你运行在用户本机（WSL，CN IP 出网），宿主是 **DSH（DeepSeek Harness）** 会话系统，工作区在 `/mnt/e/knowledge-base`。
- 主库结构：`INDEX.md`（总索引）→ `indexes/*.md`（二级索引）→ `notes/*.md`（知识节点）→ `README.md`（维护规约）。**读库先读 INDEX.md / README.md**。
- 检索纪律：本库 26000+ 文件，**不允许 grep 全库**。语义检索走 `~/code-rag/rag-search.sh "<问题>"`；已知位置核对才用窄范围 `grep <pattern> <单个文件>`。
- 建知识默认**新建节点**，仅四类必要（登记类 / 同一概念 / 权威唯一处 / 订正既有事实）才改旧文件。详见 [agent-prefer-new-file-discipline](notes/agent-prefer-new-file-discipline.md)。
- 汇报纪律：必须指名到 commit hash / 文件路径+行号 / 命令+读数；禁止用「基本一致」「处理了 N 个」这类形容词或聚合数字。

## 二、任务格式（发给 Gemini 的载荷）

- **单目标**：一条任务只解决一个可判定的问题，写完能用一句话回答「做完了吗」。
- **≤ 400 字**：上下文 + 输入 + 期望产出，超出就拆。
- **只读优先**：默认「只读 / 不写盘」，明确要写盘才写；写盘必须指明落点。
- **产出可验证**：期望产出要能被第三方核对（文件路径+行号 / 命令输出 / 具体数据）。
- **不编造**：拿不到就写「未取到：因为 X」，不要用次优值填空。

### 任务模板

```
# 任务：<一句话目标>
# 范围：只读 / 只读+落盘到 <path>
# 输入：<文件路径 / 命令 / URL，指明起止>
# 期望产出：<数据表 / 判断 / diff / PR 描述，指明落点>
# 红线：<不许做什么，例如「不修改仓库」「不打印 key 本体」>
```

## 三、常见纪律（Gemini 必读）

1. **资料来源必须可指认**：每个结论后面能挂上「读自 `<path>:<line>`」或「跑 `<cmd>` 得到 `<读数>`」。
2. **不编造、不脑补**：缺信息 → 用「未取到」+ 原因，不要拿常识填空。
3. **不越界**：不装新包、不改配置、不申请新 key、不打印凭据本体；碰到就写「此处需用户操作：Y」。
4. **不整条停**：一批任务有个别做不到 → 做完能做的，列剩余项 + 需要什么才能继续。
5. **汇报指名**：commit hash / 文件:行号 / 命令+输出读数，三选其一；禁止形容词与聚合数字下结论。

## 四、通道探测结论（2026-10-08 实测）

| 通道 | 证据 | 结论 |
|------|------|------|
| `GEMINI_API_KEY` 凭据 | 存在于 `~/.dsh/.credentials.yaml`，53 字符（未打印值） | ✅ 有 |
| `gemini` / `gemini-cli` / `claude` / `codex` CLI | `command -v` 全部 `(none)` | ❌ 无 |
| 直连 `generativelanguage.googleapis.com` | `curl: (56) CONNECT tunnel failed, response 502` | ❌ CN 出网不可达 |
| 代理 `aistudio.moonchan.xyz/v1beta/openai/chat/completions` | HTTP 400 `User location is not supported for the API use`（IP 183.193.26.22 / CN） | ❌ 地域封锁 |
| 原生 `aistudio.moonchan.xyz/.../generateContent` | HTTP 401 `API_KEY_SERVICE_BLOCKED`（`method: google.ai.generativeLanguage.v1beta...`） | ❌ Key 服务侧被封 |
| `dsh-our-free-model` 插件（本地网关 `127.0.0.1:8326/18326`） | 52 个模型清单里**无一 gemini**；`availability.json` 里 14 条探测**无 gemini 条目** | ❌ 未激活 |
| `settings.yaml.imported` 模板 | 有 `aistudio` provider 定义（指向 moonchan 代理） | 🟡 模板在，未启用 |

**结论：当前无可用 Gemini 通道。** 三条路都不通（直连被封、代理地锁、插件未激活）。

## 五、如何调用（通道可用时的形态，占位符示意）

```bash
# 形态 A：OpenAI 兼容代理（推荐，最贴近 DSH 生态）
curl -sS -m 30 \
  -X POST 'https://<your-aistudio-proxy>/v1beta/openai/chat/completions' \
  -H "Authorization: Bearer $GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "gemini-3.8-flash",
    "messages": [{"role":"user","content":"<任务模板填这里>"}],
    "max_tokens": 4096
  }'

# 形态 B：原生 Gemini API（直连，需出网可达 googleapis）
curl -sS -m 30 \
  -X POST 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent' \
  -H "x-goog-api-key: $GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"contents":[{"parts":[{"text":"<任务模板填这里>"}]}]}'

# 形态 C：DSH headless（把 Gemini 挂进 DSH profile 之后）
dsh --profile <gemini-profile> headless "<任务模板填这里>"
```

> 三个形态 key 都用占位符，不写死；`gemini-3.8-flash` 是 2026-10 的默认型号，`gemini-2.5-flash` 已退役（API 返回 `This model models/gemini-2.5-flash is no longer available to new users`）。

## 六、外包玩法（怎么发任务、怎么收产出）

1. **写任务**：按「任务模板」写，落盘到 `_research/gemini-tasks/<slug>.md`（或直接在对话里贴）。
2. **投递**：选形态 A/B/C 之一，把任务文本作为 user content 发出。
3. **收产出**：Gemini 回复直接是文本 → 落档到 `_research/gemini-outputs/<slug>.md`；若任务写了「只读+落盘到 X」，产出会自带落点。
4. **登记**：在 `_research/gemini-tasks/<slug>.md` 顶部加一行状态：`status: pending | done | blocked-<reason>`；`done` 时填产出路径。
5. **回报知识库**：产出中若有可复用的事实/结论，按「新建优先」写新节点进 `notes/`，本文件只作流程登记。

## 七、启用路径（当前不可用 → 最小可行步骤）

按成本从低到高，选一条即可：

1. **插件 OAuth 登录（零 key，改网络不改配置）**
   - 前置：能在浏览器完成 Google 账号登录
   - 步骤：打开 DSH Web GUI → `dsh-our-free-model` 插件面板 → Gemini 通道 → 登录 → 每日领积分
   - 局限：受 Google Code Assist 白嫖额度限制，且需 CN 出网可达 Google OAuth（当前 CN 直连 502）

2. **换出网代理（改网络，key 已有）**
   - 前置：把 `GEMINI_API_KEY` 走一个海外出口（mihomo/clash 之类）
   - 步骤：设置代理 → 直连 `generativelanguage.googleapis.com` → 用形态 A/B 调用
   - 局限：现有 `aistudio.moonchan.xyz` 代理明确拒绝 CN IP，需换一个不锁地域的代理

3. **改 DSH profile 挂 Gemini provider（改配置，需代理）**
   - 前置：形态 A/B 已能通
   - 步骤：在 `~/.dsh/profiles/<profile>/settings.yaml` 加 `provider: aistudio` + `models: [gemini-3.8-flash]`，`apiKeyEnv: GEMINI_API_KEY`，然后 `dsh --profile <name> web`
   - 局限：会动现有 profile 配置，本任务不做

## 八、第一次外包实测记录

**任务**：审查 `Hana-ame/realtime-whiteboard` 仓库 `room-go/` 目录的 relay 修复（PR#7 已合）是否完整覆盖静默错误点，列出剩余 `_ = dc.SendText` 遗漏处。**只读。**

**状态**：`blocked-no-channel` — 三条 Gemini 通道均不通（见「通道探测结论」），无法投递。

**下次通道可用后重试**：直接把「任务」段作为 user content 发给形态 A，产出落到 `_research/gemini-outputs/realtime-whiteboard-relay-audit.md`，然后回来更新本段 `status`。

---

- `updated`: 2026-10-08
- `source`: 通道探测基于 `~/.dsh/.credentials.yaml`（key 存在性）、`command -v` 4 个 CLI、3 个 curl 直连实测（含 HTTP 状态码与错误消息）、`~/.dsh/our-free-model/{availability,settings}.json` 读取、`~/.dsh/plugins/dsh-our-free-model/README.md` 阅读；未安装新包、未申请新 key、未改配置
