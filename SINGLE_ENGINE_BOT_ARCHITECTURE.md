# Single-Engine Bot Architecture

## 目标

在当前 `telegram-codex-app-bridge` 基础上增加 Gemini，但最终产品形态明确固定为：

- 一个 bot 对应一台设备上的一个 engine
- 一个群里可以有多个 bot
- 一个 topic 只能归属于一个 bot
- topic 内不能切换 engine
- topic 内不能切换 bot
- engine 选择是部署时决定，不是聊天时决定

## 当前状态

截至 `2026-03-15`，这套架构已经有这些实现结果：

- 多实例运行基础设施已完成，`codex` / `gemini` 可走独立 `BRIDGE_HOME`
- Telegram 控制层已经抽到统一 `EngineProvider`
- Codex 已经通过 provider 适配层运行
- Gemini CLI provider 已经接入主链路，支持基础 headless `stream-json`
- slash 菜单、`/help`、`/status`、`/settings` 已经开始按 engine 能力区分

当前还没完成的是：

- Gemini 的真实 Telegram smoke
- `where` / README 的最终能力差异说明和收尾文案

这意味着 bridge 的下一阶段目标不是“单 bot 多 engine 动态切换”，而是：

- 让同一套 Telegram bridge 代码支持多个 engine
- 每个运行实例在启动时只选择一个 engine
- 通过多个 bot / 多个服务实例实现 Codex 与 Gemini 并存

## 非目标

以下能力明确不做：

- 不做 `/engine` 运行时切换
- 不做“同一个 topic 切 Codex / Gemini”
- 不做“同一个 bot 绑定多个 engine”
- 不做 provider 级别的 per-chat 动态 slash command 切换
- 不做在同一个 topic 中从一个 bot 迁移到另一个 bot 的自动化流程

如果未来真的需要迁移，应该通过“新建 topic + 绑定新 bot”解决，而不是在旧 topic 中切 engine。

## 为什么这是最佳实践

### 1. 当前 bridge 的状态模型本来就是 scope 驱动

`src/telegram/scope.ts` 已经把会话作用域定义为：

- `chat_id::topic_id`
- 或 `chat_id::root`

这天然适合“一个 topic 就是一条长期上下文线”，也适合一个 bot 只服务自己的 topic。

### 2. Telegram 命令菜单不适合 topic 级动态切换

Telegram 官方 `BotCommandScope` 支持 default / chat / member 等层级，但没有 forum topic 级命令作用域。对于一个会跑在多个 topic 的 bot 来说，slash 菜单很难做到 topic 级同步切换。

本方案直接绕开这个限制：

- 每个 bot 固定一个 engine
- 每个 bot 的命令菜单在启动时一次性注册
- 不依赖 topic 级命令切换

### 3. 能力差异由 bot 身份隔离，比运行时切换更稳定

Codex 与 Gemini 在以下能力上并不等价：

- 线程/会话模型
- 计划模式深度
- 审批交互
- 结构化追问
- 本地 app reveal
- 额度/状态可观测性

如果放在同一个 bot 里做动态切换，几乎所有设置页、帮助页、状态页、线程绑定、排队、恢复逻辑都要跟着一起切。工程成本和误用风险都显著上升。

## 目标拓扑

推荐部署拓扑：

- `Linux144-CodexBot`
  - engine: `codex`
  - token: `TG_BOT_TOKEN=<codex bot token>`
  - topic: `TG_ALLOWED_TOPIC_ID=<codex topic>`
- `Linux144-GeminiBot`
  - engine: `gemini`
  - token: `TG_BOT_TOKEN=<gemini bot token>`
  - topic: `TG_ALLOWED_TOPIC_ID=<gemini topic>`

同一台机器可以同时跑多个 bridge 实例，但每个实例必须有：

- 自己的 bot token
- 自己的 topic 绑定
- 自己的 store/status/log/lock 路径
- 自己的 service unit 名称
- 自己的 engine 配置

## 配置原则

下一阶段推荐引入以下统一配置：

- `BRIDGE_ENGINE=codex|gemini`
- `BRIDGE_INSTANCE_ID=<host-engine>`
- `BRIDGE_HOME=<instance specific home>`
- `STORE_PATH`
- `STATUS_PATH`
- `LOG_PATH`
- `LOCK_PATH`
- `TG_BOT_TOKEN`
- `TG_ALLOWED_USER_ID`
- `TG_ALLOWED_CHAT_ID`
- `TG_ALLOWED_TOPIC_ID`

engine 专属配置：

- Codex
  - `CODEX_CLI_BIN`
  - `CODEX_APP_AUTOLAUNCH`
  - `CODEX_APP_LAUNCH_CMD`
  - `CODEX_APP_SYNC_ON_OPEN`
  - `CODEX_APP_SYNC_ON_TURN_COMPLETE`
- Gemini
  - `GEMINI_CLI_BIN`
  - `GEMINI_DEFAULT_MODEL`
  - `GEMINI_MODEL_ALLOWLIST`
  - `GEMINI_INCLUDE_DIRECTORIES`
  - `GEMINI_HEADLESS_TIMEOUT_MS`

## 核心架构结论

### 1. engine 是进程级配置，不是 chat 级配置

这一点是整个方案最重要的边界。

因此：

- 不需要给 `chat_settings` 新增 `provider`
- 不需要给 `chat_bindings` 做 per-provider 绑定
- 不需要做 `/engine` 设置页
- 不需要做 engine 切换迁移

真正需要做的是：

- 在启动时根据 `BRIDGE_ENGINE` 创建不同的 provider
- 让 Telegram 层与控制层面向“统一 provider 接口”编程

### 2. 保留现有 scope/chat 数据模型

当前持久化层按 `chat_id` 存：

- thread binding
- settings
- queue
- plan session
- approvals
- pending input

在本方案下，这些表大多可以保留原结构，因为一个 bot 进程只会服务一个 engine。

换句话说，单实例内没有 provider 维度，engine 已由进程保证。

### 3. 需要抽的是 provider 接口，而不是 provider 状态多路复用

推荐新增统一 provider 抽象：

```ts
type EngineId = 'codex' | 'gemini';

interface EngineCapabilities {
  threads: boolean;
  reveal: boolean;
  guidedPlan: 'full' | 'basic' | 'none';
  approvals: 'full' | 'limited' | 'none';
  steerActiveTurn: boolean;
  rateLimits: boolean;
  reasoningEffort: boolean;
  serviceTier: boolean;
  reconnect: boolean;
}

interface EngineProvider {
  readonly id: EngineId;
  readonly capabilities: EngineCapabilities;
  start(): Promise<void>;
  stop(): Promise<void>;
  isConnected(): boolean;
  getUserAgent(): string | null;
  listModels(): Promise<ModelInfo[]>;
  startSession(...): Promise<ThreadSessionState>;
  resumeSession(...): Promise<ThreadSessionState>;
  startTurn(...): Promise<{ id: string; status: string }>;
  interruptTurn(...): Promise<void>;
}
```

Codex provider 用现有 `CodexAppClient` 封装即可。

Gemini provider 则新增 `GeminiCliProvider`。

## Gemini 的产品定位

Gemini 在本项目中建议先做成：

- 同样支持普通文本对话
- 支持附件暂存后在下一条消息中使用
- 支持中断
- 支持消息队列
- 支持基础 session 续跑
- 支持模型选择

但不强求在 v1 达到 Codex 的全部交互深度。

推荐能力等级：

- threads: `false` in v1
- reveal: `false`
- guidedPlan: `basic`
- approvals: `none`
- steerActiveTurn: `false`
- rateLimits: `false`
- reasoningEffort: `false`
- serviceTier: `false`
- reconnect: `false`

### 关于 Gemini 的计划模式

Gemini headless CLI 更适合 `prompt -> stream-json -> result` 这类非交互流程。它不适合照搬 Codex 的“原生 plan mode + requestUserInput + approval”体验。

因此 Gemini 在 bridge 中的计划模式应定位为：

- bridge 自己做“先出计划、再确认、再执行”的外层门控
- 不承诺结构化追问、审批、深度 plan 交互与 Codex 等价

也就是说：

- Codex: `guidedPlan = full`
- Gemini: `guidedPlan = basic`

## 命令设计

### 统一保留的跨 engine 命令

- `/help`
- `/status`
- `/new`
- `/models`
- `/settings`
- `/queue`
- `/interrupt`
- `/restart`
- `/where`

这些命令应该继续存在，但文案必须 provider-aware。

### Codex 专属命令

- `/threads`
- `/open`
- `/guide`
- `/permissions`
- `/mode`
- `/plan`
- `/reveal`
- `/reconnect`
- `/tier`
- `/fast`
- `/effort`

### Gemini v1 建议隐藏的命令

- `/threads`
- `/open`
- `/guide`
- `/permissions`
- `/reveal`
- `/reconnect`
- `/tier`
- `/fast`
- `/effort`

`/mode` 是否在 Gemini 中保留，取决于是否接受 “basic guided plan only” 的产品语义。

推荐做法：

- Gemini v1 不在 slash 菜单展示 `/mode`
- `/settings` 中也不展示 plan 切换
- 等 Gemini 的 bridge-level basic plan 流程稳定后，再决定是否放出

### 命令注册策略

由于一个 bot 固定一个 engine，所以命令注册可以按进程级 engine 一次性生成：

- `getTelegramCommands(locale, engine, capabilities)`

不需要运行时切换。

## 状态页与帮助页设计

### `/status`

必须把以下信息提升到顶部：

- `Engine: Codex | Gemini`
- `Instance: Linux144-CodexBot`
- `Bot username`
- `Scope policy`

Codex status 继续显示：

- 连接状态
- rate limits
- 当前 thread
- model / effort / tier / mode

Gemini status 应改为：

- CLI 是否可执行
- 当前 bot engine = Gemini
- 当前 session id
- 当前 model
- 最后错误
- 队列/附件/未完成 turn

### `/help`

帮助页必须分成：

- 通用命令
- 当前 bot 独有命令
- 当前 bot 的能力说明

用户在 Gemini bot 上不应该看到大量 Codex 命令。

## 会话与线程策略

### Codex

保持现状：

- 远程 thread id 作为长期会话 id
- `/threads`、`/open`、`/reveal` 继续工作

### Gemini

v1 推荐不要强行模拟完整 thread 面板。

推荐策略：

- 继续复用现有 `threadId` 字段存 Gemini session id
- `/new` 启动新的 Gemini session
- `resume` 基于当前 binding 自动继续
- `/threads` 与 `/open` 在 Gemini bot 中不开放

后续如果需要 Gemini session 面板，再新增“本地 session 缓存”而不是直接依赖 CLI 输出格式。

## 持久化层影响

本方案下，数据库层不做 provider 维度扩展，但需要以下调整：

### 必做

- `chat_settings` 保持现有结构
- `chat_bindings` 保持现有结构
- `queued_turn_inputs` 保持现有结构，但 input 结构要从 Codex-only 转向 provider-neutral 或 provider-owned
- `active_turn` 运行态需要记录 engine id

### 建议新增

- runtime status 中记录 `engine`
- runtime status 中记录 `instanceId`
- 审计日志中补 `engine`

## 服务与脚本层改造

这是本方案里最容易被忽略、但必须优先做的部分。

当前实现存在几个硬编码：

- `APP_HOME` 固定为 `~/.telegram-codex-app-bridge`
- service unit 名称固定
- restart/status/logs/install 脚本默认只服务单实例

如果不先改这里，多 bot 多实例在同一台机器上会冲突：

- store 覆盖
- status.json 覆盖
- lock 冲突
- service unit 冲突
- 重启脚本误杀其他实例

### 推荐改法

- 引入 `BRIDGE_INSTANCE_ID`
- 引入 `BRIDGE_HOME` 覆盖默认目录
- 所有 service 脚本按 instance 计算：
  - unit 名称
  - status file
  - log file
  - store path
  - lock path
- systemd 改成实例化单元，或用显式不同单元名

推荐命名：

- `com.ganxing.telegram-bridge@linux144-codex.service`
- `com.ganxing.telegram-bridge@linux144-gemini.service`

## i18n 与文案原则

当前仓库里很多用户可见文案直接写死了 `Codex`。

引入 Gemini 后必须拆成三类：

- 通用 bridge 文案
- Codex 专属文案
- Gemini 专属文案

例如：

- `Reconnect Codex session` 不再适合当全局 key
- `Open in local Codex` 只能在 Codex bot 出现
- `Saved attachments will be used with Codex` 需要改成 provider-aware

推荐做法：

- 新增 provider-aware label helper
- 将 `Codex` 出现在通用路径中的 key 全部替换为占位
- 把 provider-specific 的帮助与按钮集中到 engine-aware presentation 层

## 最终实施顺序

推荐分为 4 大阶段：

### Phase A. 多实例基础设施

- 让一台机器能稳定跑多个 bot 实例
- 每个实例拥有独立路径、独立 service、独立 token、独立 topic

### Phase B. provider 抽象与 Codex 迁移

- 把现有代码从 `CodexAppClient` 直接依赖，改为依赖 `EngineProvider`
- 确保 Codex 行为不变

### Phase C. Gemini MVP

- 新增 `GeminiCliProvider`
- 跑通 `new / reply / interrupt / queue / attachments / status`
- 保持 feature set 小而稳

### Phase D. provider-aware UI 与文案收尾

- provider-aware slash commands
- provider-aware `/help`
- provider-aware `/status`
- provider-aware `/settings`
- 文档、测试、部署脚本全部收尾

## 最终结论

这套需求的最佳实践不是“在一个 bot 里同时支持 Codex 和 Gemini 并允许运行时切换”，而是：

- 在一套代码里支持多个 engine
- 在一个运行实例里只启用一个 engine
- 通过多个 bot / 多个 topic / 多个 service 实例来完成群组协作

这会显著减少以下复杂度：

- provider 切换迁移
- 命令菜单切换
- 线程绑定污染
- 状态页歧义
- 重连/重启语义歧义
- 用户误操作

这是当前项目最稳、最清晰、最容易长期维护的演进路线。
