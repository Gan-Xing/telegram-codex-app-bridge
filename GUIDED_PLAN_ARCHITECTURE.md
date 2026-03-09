# Telegram Guided Plan Architecture

## 背景

当前 bridge 已经具备以下基础能力：

- `plan` 协作模式已经可以通过 `turn/start` 传给 `codex app-server`
- `turn/plan/updated` 已经能渲染到 Telegram
- `item/tool/requestUserInput` 已经能在 Telegram 中回答
- `pending_user_inputs` 已经能持久化
- `/mode`、`/models`、`/permissions` 已经分别可用

这些能力已经让 bridge 进入了“能用”的阶段，但距离 Codex App 想要的体验仍然有明显差距。问题不在某一个按钮，而在于整个交互链还没有被桥接层统一建模。

当前代码里的事实基础：

- `src/controller/controller.ts`
  - 已有 `ActiveTurn.planMessageId` / `planText`
  - 已有 `pendingUserInputId`
  - 已有 `turn/plan/updated` 渲染
  - 在 turn 运行时仍会阻止新的普通消息进入
- `src/store/database.ts`
  - 已有 `chat_settings`
  - 已有 `pending_user_inputs`
  - 已有 `active_turn_previews`
  - 还没有“计划会话”“计划历史”“消息队列”“问题消息历史”
- `src/controller/presentation.ts`
  - 已有模型、模式、权限三个独立设置面板
  - 还没有统一设置首页
- `src/controller/controller.ts`
  - 当前审批卡只有 thread/turn/command/cwd/reason 的轻量展示

这意味着你提到的 7 个功能，本质上并不是 7 个分散的 feature，而是一条完整的“引导式计划执行链”还没有在桥接层被定义出来。

## 核心结论

推荐把下一阶段实现统一抽象成一个新实体：

- `GuidedPlanSession`

它不是替代 `turn`，而是桥接层在 `thread/turn` 之上维护的一层“产品态状态机”。这层状态机统一解决：

- 计划先确认再执行
- 计划实时更新
- 针对性提问
- 用户回退、改答、取消
- 运行中消息排队
- 审批卡增强
- 历史记录与启动恢复

如果继续把这些功能分别塞进 `ActiveTurn`、`pending_user_inputs`、`chat_settings` 和零散 callback 里，后续很容易出现：

- 一个功能修了，另一个功能被打断
- 按钮状态失真
- 重启后无法恢复真实上下文
- plan、approval、queue、prompt 互相覆盖

## 目标交互

目标不是复刻桌面 Codex App 的多面板外观，而是在 Telegram 的线性聊天界面里实现等价的控制节奏。

理想链路应是：

1. 用户发出任务。
2. bridge 进入“计划起草”阶段，只允许生成计划，不允许直接进入执行。
3. Telegram 持续显示计划更新。
4. 计划稳定后，bridge 给出确认门：
   - `继续执行（推荐）`
   - `修改计划`
   - `取消`
5. 用户确认后，bridge 再进入“按计划执行”阶段。
6. 执行中如需额外方向输入，bridge 逐题提问，并允许：
   - 返回上一题
   - 改答
   - 取消本轮提问
7. 若 turn 运行中又来了新消息，bridge 不直接拒绝，而是加入队列。
8. 若出现审批请求，bridge 显示更完整的风险与上下文。
9. 若 bridge 重启，未完成的计划、问题、审批、队列仍可恢复。

## 为什么必须引入会话状态机

### 1. “计划总确认门”不是简单加按钮

当前 `turn/plan/updated` 只是展示层能力。它不会天然阻止 agent 在生成计划后继续执行。单靠 UI 上显示计划，不能保证“先确认，再执行”。

要稳定实现这个效果，推荐采用桥接层的“两阶段 turn”方案：

- 第一阶段：`draft-only plan turn`
  - 只允许产出计划
  - 禁止进入真正执行
  - 允许读取上下文，但不允许推进到命令/文件修改阶段
- 第二阶段：`execution turn`
  - 用户确认计划后，在同一 thread 上发起后续执行 turn
  - 输入中带上“计划已确认”的上下文

这是当前协议下最稳妥的硬门方案。原因是协议并没有给 bridge 一个“在同一个 turn 中强制暂停 agent，等用户确认后再继续”的可靠硬暂停点。

### 2. “回退/改答/取消”要求 prompt 不再是一次性线性流程

当前 `pending_user_inputs` 只记录：

- `questions`
- `answers`
- `currentQuestionIndex`
- `awaitingFreeText`
- `messageId`

这个结构足够支持“逐题前进”，但不够支持：

- 退回上一题
- 改掉之前的答案
- 给最终答案一个 review/submit 环节
- 保留多张问题卡片的 message id

所以 prompt 也必须被纳入 `GuidedPlanSession` 的子状态。

### 3. “消息排队”会影响 turn 生命周期

当前 `handleText()` 的逻辑是：

- 如果有 pending input，则把消息当答案
- 否则如果有 active turn，则直接拒绝

这和“引导式计划体验”是冲突的。因为一旦你把计划确认门、追问、审批卡都做得更强，用户就更可能在 turn 运行中继续输入。

如果不加队列，用户会频繁遇到：

- 明明刚给出下一个需求，却被桥拦下
- 无法建立连续任务流

因此消息队列不是附属功能，而是整个 guided flow 的必要组成。

## 推荐的新抽象

### `GuidedPlanSession`

建议每次用户发起的新任务，在 plan 模式下都对应一条 `GuidedPlanSession`。

建议状态：

- `drafting_plan`
- `awaiting_plan_confirmation`
- `executing_confirmed_plan`
- `awaiting_followup_input`
- `awaiting_approval`
- `queued_follow_up_present`
- `completed`
- `cancelled`
- `interrupted`
- `recovery_required`

建议关键字段：

- `sessionId`
- `chatId`
- `threadId`
- `sourceTurnId`
- `executionTurnId`
- `state`
- `confirmationRequired`
- `confirmedPlanVersion`
- `latestPlanVersion`
- `currentPromptId`
- `currentApprovalId`
- `queueDepth`
- `lastPlanMessageId`
- `lastPromptMessageId`
- `lastApprovalMessageId`
- `createdAt`
- `updatedAt`

### `GuidedPlanSession` 与 `ActiveTurn` 的关系

- `ActiveTurn` 保持“一个真实 turn 的实时渲染状态”
- `GuidedPlanSession` 负责“用户看见的整段交互生命周期”

这两个对象不能混成一个：

- `ActiveTurn` 是临时实时态
- `GuidedPlanSession` 是可恢复的产品态

## 功能设计

## 1. 计划总确认门

### 当前问题

- 计划卡只有展示，没有强制确认
- 即使上游已经生成计划，也可能继续推进执行
- 普通用户无法明确区分“计划阶段”和“执行阶段”

### 推荐方案

采用桥接层硬门：

1. 用户在 `plan` 模式下发消息。
2. bridge 发起“计划起草 turn”。
3. 起草 turn 的 developer instructions 明确要求：
   - 先产出计划
   - 不要执行命令或修改文件
   - 把是否执行交给用户确认
4. plan 更新通过 Telegram 流式展示。
5. 一旦计划稳定，bridge 显示确认门：
   - `继续执行（推荐）`
   - `修改计划`
   - `取消`
6. 只有用户点击继续，bridge 才发起执行 turn。

### 为什么不推荐只靠上游 `requestUserInput`

只靠上游自行决定何时问用户，体验会不稳定：

- 有时会问
- 有时不会问
- 有时已经读文件或开始行动了才问

对于 Telegram bridge，这种不稳定性会直接变成“用户无法理解当前阶段”。

### 需要的实现点

- `src/codex_app/client.ts`
  - 为 draft-only plan turn 加更强的 developer instructions
- `src/controller/controller.ts`
  - 新增 `plan:<sessionId>:confirm|revise|cancel` callback
  - 区分起草 turn 和执行 turn
- `src/types.ts`
  - 新增 `GuidedPlanSession` 相关类型

### 边界条件

- 如果 draft turn 在确认前就发起 approval：
  - bridge 应阻断并中断该 turn
  - 告知用户“计划尚未确认，执行已被拦下”
- 如果用户点 `修改计划`：
  - 在同一 thread 上发起新的 draft turn
  - 附带“请基于上一个计划和用户反馈修订”
- 如果用户点 `取消`：
  - 标记 session cancelled
  - 清理按钮

## 2. 计划流式更新

### 当前问题

- 只处理了 `turn/plan/updated`
- 还没有接 `item/plan/delta`
- 渲染层是“整块更新”，没有版本化历史

### 推荐方案

- 接入 `item/plan/delta`
- 用 delta 做更细的流式感知
- 用 `turn/plan/updated` 作为规范化快照
- 对计划渲染单独做节流，避免和正文状态刷新互相干扰

### 推荐渲染策略

- 当前计划卡始终只有一张“最新状态卡”
- 只有在语义变化时才更新：
  - step 数量变化
  - step 状态变化
  - explanation 变化
- 对高频 delta 做 300-500ms debounce

### 为什么还要做历史快照

后面要支持：

- 计划确认前回看
- plan 修改后的对比
- 重启恢复

所以不能只保留 `ActiveTurn.planText` 这一份内存字符串。

## 3. 问答回退 / 改答 / 取消

### 当前问题

- 只能一路往前答
- 没有回到上一题的入口
- 没有最终 review/submit 阶段
- 取消只能靠放弃，不是显式动作

### 推荐方案

把 prompt 流程拆成三个子阶段：

- `answering`
- `reviewing`
- `awaiting_custom_text`

推荐按钮：

- 选项题：
  - `推荐选项`
  - 其他选项
  - `其他`
  - `返回上一题`
  - `取消`
- 最后一题后：
  - `提交答案（推荐）`
  - `修改上一题`
  - `取消`

### 关键交互

- 用户选完最后一题，不立刻 `respond()`
- 先展示答案汇总卡
- 用户点 `提交答案` 后，bridge 再向上游返回结果

这一步很重要，因为有了 review，用户才真的拥有“改答”的能力。

### 数据结构建议

当前 `pending_user_inputs.message_id` 不够用。建议新增：

- `pending_user_input_messages`
  - `input_local_id`
  - `question_index`
  - `message_id`
  - `message_kind`
  - `created_at`

这样可以：

- 定位当前问题卡
- 标记旧卡已完成
- 重启后识别哪些按钮需要失效

### 取消的语义

推荐直接对 server request 返回 error，而不是返回空答案。这样语义更明确：

- 空答案像是“我回答了，但答案为空”
- error 才是“我取消了这次交互”

## 4. 运行中消息排队

### 当前问题

- active turn 存在时，普通消息会被拒绝
- 这会打断用户的连续思考
- 在计划/审批/追问模式下尤其明显

### 推荐方案

新增持久化队列表 `queued_turn_inputs`。

每条入队记录应保存：

- `scope_id`
- `chat_id`
- `thread_id`
- `normalized_turn_input_json`
- `source_summary`
- `telegram_message_id`
- `status`
- `created_at`

### 为什么要保存 normalized turn input

因为消息可能包含：

- 文本
- 图片
- 文件

如果只保存原始 Telegram event，重启后很难可靠重建输入。更稳妥的方式是：

- 收到消息时就完成附件下载与标准化
- 将可直接送给 `turn/start` 的输入持久化

### 推荐行为

- 当前 turn 活跃时：
  - 新消息进入队列
  - Telegram 回一条简短确认：“已加入队列，前方还有 1 条”
- 当前 turn 完成后：
  - 自动消费下一条队列项
- `/status` 和状态卡应显示 queue depth

### 初版不建议做的复杂项

- 不要一上来做消息合并
- 不要做优先级插队
- 初版直接 FIFO

## 5. 审批卡增强

### 当前问题

`renderApprovalMessage()` 目前只展示：

- kind
- thread
- turn
- command
- cwd
- reason

这对熟悉命令行的人尚可，对普通 Telegram 用户不够。

### 推荐方案

审批卡分两层：

- 一级卡：
  - 操作类型
  - 风险级别
  - 命令摘要或文件改动摘要
  - 工作目录
  - 原因
  - 主按钮
- 二级卡：
  - `查看详情`
  - 展开完整命令
  - 展开文件列表
  - 展示风险说明

### 建议新增的风险分类

- `low`
  - 仅读取或明显局部的安全写入
- `medium`
  - 会修改工作区，但作用域明确
- `high`
  - 跨目录写入、删除、网络发布、可执行脚本、可疑 shell 组合

### 数据结构建议

给 `pending_approvals` 增加：

- `details_json`
- `risk_level`
- `summary`

不要只在渲染时临时推断。持久化后：

- 重启能恢复
- `/status` 能汇总
- 后续可以做审批历史

## 6. 统一设置首页

### 当前问题

现在设置入口分散在：

- `/models`
- `/mode`
- `/permissions`
- `/where`

对高级用户没问题，但对普通 Telegram 用户不够直观。

### 推荐方案

新增 `/settings` 作为总面板，保留原命令作为快捷入口。

首页建议展示：

- 当前 thread
- 当前 mode
- 当前 model / effort
- 当前 access preset
- 是否开启“计划确认门”
- 是否开启“运行中消息排队”
- 是否开启“计划历史恢复”

建议按钮分区：

- `模型`
- `模式`
- `权限`
- `计划策略`
- `队列策略`
- `恢复与历史`
- `线程`

### 配置存储建议

对核心布尔开关，推荐继续用显式列，而不是一个大 JSON blob：

- `confirm_plan_before_execute`
- `auto_queue_messages`
- `persist_plan_history`

原因：

- 状态输出简单
- SQL 查询简单
- 后续 migration 简单

## 7. 计划历史与启动恢复

### 当前问题

- plan 内容只在当前 turn 内存中
- bridge 重启后，活跃计划无法恢复
- `pending_user_inputs` 能恢复，但 plan 上下文恢复不完整

### 推荐方案

新增两张表：

- `plan_sessions`
- `plan_snapshots`

`plan_sessions` 负责存产品态：

- 当前 session 状态
- 是否已确认
- 当前 prompt / approval / queue 关联
- 最近可见 message id

`plan_snapshots` 负责存计划版本：

- `session_id`
- `version`
- `source_event`
- `explanation`
- `steps_json`
- `created_at`

### 启动恢复流程

bridge 启动时：

1. 读出未完成的 `plan_sessions`
2. 读出未完成的 `pending_user_inputs`
3. 读出未完成的 `pending_approvals`
4. 读出 `queued_turn_inputs`
5. 对每个 `recovery_required` session 发恢复卡：
   - `继续上次计划`
   - `查看上次计划`
   - `取消并清理`

### 要明确的边界

bridge 重启后不应尝试“恢复 in-flight delta 流”。

正确做法是：

- 恢复产品态
- 明确告诉用户上一轮实时流已中断
- 提供继续操作的入口

## 推荐的数据模型改造

建议新增：

- `chat_settings`
  - `confirm_plan_before_execute INTEGER NOT NULL DEFAULT 1`
  - `auto_queue_messages INTEGER NOT NULL DEFAULT 1`
  - `persist_plan_history INTEGER NOT NULL DEFAULT 1`
- `plan_sessions`
- `plan_snapshots`
- `queued_turn_inputs`
- `pending_user_input_messages`

建议扩展：

- `pending_approvals`
  - `details_json TEXT`
  - `risk_level TEXT`
  - `summary TEXT`

## 推荐的 callback namespace

- `plan:<sessionId>:confirm`
- `plan:<sessionId>:revise`
- `plan:<sessionId>:cancel`
- `plan:<sessionId>:view`
- `input:<localId>:option:<n>`
- `input:<localId>:other`
- `input:<localId>:back`
- `input:<localId>:submit`
- `input:<localId>:cancel`
- `approval:<localId>:details`
- `settings:home`
- `settings:plan-gate:on|off`
- `settings:queue:on|off`
- `settings:history:on|off`

## 文件改造重点

- `src/controller/controller.ts`
  - 最大改造点
  - 新增 guided session 状态迁移、queue 消费、plan gate、prompt review、approval details
- `src/store/database.ts`
  - schema migration
  - 查询接口
  - recovery load
- `src/types.ts`
  - guided session / queue / settings 扩展类型
- `src/controller/presentation.ts`
  - `/settings` 首页
  - 审批详情卡
  - plan gate 卡
- `src/controller/status.ts`
  - queue / gate / recovery 的状态优先级
- `src/i18n.ts`
  - 新按钮、新状态、新错误文案
- `src/controller/*.test.ts`
  - prompt 回退
  - queue
  - recovery
  - settings
- `src/store/database.test.ts`
  - migration 与持久化覆盖

## 实施顺序建议

推荐按依赖关系落地，而不是按用户表面感知的顺序：

1. 先引入 `GuidedPlanSession`、新表和设置开关
2. 再做“计划总确认门”
3. 再做计划流式更新与历史快照
4. 再做 prompt 的回退 / 改答 / 取消
5. 再做运行中消息排队
6. 再做审批卡增强
7. 最后收口统一设置首页与启动恢复

原因：

- 没有 session 和 persistence，后面的能力都只是表面 UI
- 没有 plan gate，queue 和审批增强也无法形成完整的产品节奏

## 验收标准

- 用户在 `plan` 模式下首次看到的一定是计划，而不是直接执行
- 用户不确认计划，bridge 不进入执行阶段
- 用户在问题流中可以明确地返回、改答、取消
- 运行中的普通消息不会丢失，而是可见地进入队列
- 审批卡能让非工程背景用户理解风险和范围
- `/settings` 能在一个页面内概览关键配置
- bridge 重启后，未完成计划可以继续，而不是上下文断裂

## 明确不做的方案

- 不把所有产品状态都塞进 `ActiveTurn`
- 不继续靠单个 `messageId` 管理整个提问生命周期
- 不只靠上游“也许会问你一下”来实现计划确认门
- 不用一个巨大的 JSON 配置列掩盖核心交互状态
