# Guided Plan Session TODO

## 范围

本 TODO 对应以下 7 个目标：

- 计划总确认门
- 计划流式更新
- 问答回退 / 改答 / 取消
- 运行中消息排队
- 审批卡增强
- 统一设置首页
- 计划历史与启动恢复

## 当前已完成的基础能力

- [x] `plan` 协作模式已接入 `turn/start`
- [x] `turn/plan/updated` 已能渲染到 Telegram
- [x] `requestUserInput` 已支持按钮优先回答
- [x] `pending_user_inputs` 已持久化
- [x] `/mode`、`/models`、`/permissions` 已分别可用

## 实施状态快照（2026-03-09）

- [x] Phase 1 到 Phase 8 已完成并已有自动化测试覆盖
- [x] README、`/help`、状态文案已与当前实现同步
- [ ] 真实 Telegram 环境的手工 smoke checklist 仍需逐项走完

## Phase 1: 引入 Guided Plan Session 基础模型

- [ ] 在 `src/types.ts` 定义 `GuidedPlanSession`、`GuidedPlanSessionState`、`QueuedTurnInputRecord`
- [ ] 在 `src/store/database.ts` 新增表：
  - `plan_sessions`
  - `plan_snapshots`
  - `queued_turn_inputs`
  - `pending_user_input_messages`
- [ ] 扩展 `chat_settings`：
  - `confirm_plan_before_execute`
  - `auto_queue_messages`
  - `persist_plan_history`
- [ ] 扩展 `pending_approvals`：
  - `details_json`
  - `risk_level`
  - `summary`
- [ ] 为所有 migration 补充 `src/store/database.test.ts` 覆盖

Acceptance criteria:

- [ ] bridge 可以加载、保存、查询 guided session
- [ ] 现有数据库能平滑迁移，不破坏旧数据
- [ ] `/status` 能读取新增 chat setting 的默认值

## Phase 2: 计划总确认门

- [ ] 为 plan 模式新增 draft-only plan turn 策略
- [ ] 在 `src/codex_app/client.ts` 中区分“起草计划 turn”与“执行计划 turn”注入的 developer instructions
- [ ] 在 `src/controller/controller.ts` 中引入 `plan:<sessionId>:confirm|revise|cancel` callback
- [ ] 计划稳定后显示确认卡，而不是直接进入执行
- [ ] 点击 `继续执行` 后，在同一 thread 上发起 execution turn
- [ ] 点击 `修改计划` 后，在同一 thread 上发起新的 draft turn
- [ ] 点击 `取消` 后，清理 session 并失效旧按钮
- [ ] 若 draft turn 在确认前越权触发 approval / execution，bridge 要中断并提示用户
- [ ] 为确认门补测试：
  - 初次计划
  - revise
  - cancel
  - draft turn 越权

Acceptance criteria:

- [ ] 用户在 `plan` 模式下永远先看到计划确认门
- [ ] 不确认计划时不会进入执行阶段
- [ ] revise 会保留 thread 上下文而不是丢历史

## Phase 3: 计划流式更新与历史快照

- [ ] 处理 `item/plan/delta`
- [ ] 将 `turn/plan/updated` 作为规范化快照写入 `plan_snapshots`
- [ ] 为计划卡渲染加入 debounce，避免高频刷屏
- [ ] 仅在 explanation / steps / step status 发生变化时才编辑消息
- [ ] 在 session 中记录 `latestPlanVersion` 与 `confirmedPlanVersion`
- [ ] 为计划卡增加“当前版本 / 已确认版本”展示
- [ ] 为历史快照补 store 与 controller 测试

Acceptance criteria:

- [ ] 用户可以明显感知计划在生成和修订
- [ ] 计划卡不会因高频 delta 产生明显闪烁
- [ ] 最近计划快照能被持久化

## Phase 4: 问答回退 / 改答 / 取消

- [ ] 将 `pending_user_inputs` 扩展为 `answering / reviewing / awaiting_custom_text` 三阶段
- [ ] 为问题卡新增按钮：
  - `返回上一题`
  - `取消`
  - `提交答案`
- [ ] 最后一题结束后不立即提交，先展示 review 卡
- [ ] review 卡允许：
  - 提交
  - 修改上一题
  - 取消
- [ ] `Other` 只在点过按钮后才开放自由文本
- [ ] 使用 `pending_user_input_messages` 跟踪多张问题卡
- [ ] `cancel` 使用 `respondError()` 明确中止 server request
- [ ] 为以下情况补测试：
  - 退回上一题
  - 更改最后一题答案
  - 取消 prompt
  - 重启后继续 prompt

Acceptance criteria:

- [ ] 用户可以在提交前改掉答案
- [ ] 用户取消问题流时，上游能收到明确取消语义
- [ ] 旧问题卡按钮不会继续误触发

## Phase 5: 运行中消息排队

- [ ] 在 `handleText()` 中把运行中消息从“拒绝”改为“标准化后入队”
- [ ] 收到附件消息时立即下载并标准化，再写入 `queued_turn_inputs`
- [ ] 当前 turn 完成后自动消费下一条队列项
- [ ] 队列回执显示当前位置，例如“已加入队列，前方还有 2 条”
- [ ] `/status` 与底部状态卡显示 `queue depth`
- [ ] 增加队列控制：
  - `取消下一条`
  - `清空队列`
- [ ] 为以下情况补测试：
  - 文本入队
  - 附件入队
  - turn 完成后自动消费
  - 重启后恢复未消费队列

Acceptance criteria:

- [ ] 用户在 turn 运行中发的新消息不会丢失
- [ ] 队列按 FIFO 执行
- [ ] 附件消息在重启后仍可执行

## Phase 6: 审批卡增强

- [ ] 在创建审批记录时提取更多详情到 `details_json`
- [ ] 新增 `risk_level` 推断：
  - `low`
  - `medium`
  - `high`
- [ ] 改写 `renderApprovalMessage()`，让一级卡展示：
  - 类型
  - 风险
  - 命令/改动摘要
  - cwd
  - reason
- [ ] 增加 `approval:<localId>:details` callback
- [ ] 为详情卡展示：
  - 完整命令
  - 相关路径
  - 风险说明
- [ ] 优化按钮文案，让普通用户能理解 `allow once / allow session / deny`
- [ ] 为 command approval 与 file change approval 补不同展示测试

Acceptance criteria:

- [ ] 审批卡不再只是技术字段堆叠
- [ ] 普通用户能理解“为什么系统在问我”
- [ ] 重启后审批详情仍可查看

## Phase 7: 统一设置首页

- [ ] 新增 `/settings` 命令
- [ ] 在 `src/controller/presentation.ts` 增加设置首页消息与键盘
- [ ] 统一设置首页展示：
  - 当前 thread
  - mode
  - model / effort
  - access preset
  - 计划确认门开关
  - 消息排队开关
  - 历史恢复开关
- [ ] 增加 callback：
  - `settings:home`
  - `settings:plan-gate:on|off`
  - `settings:queue:on|off`
  - `settings:history:on|off`
- [ ] 保留 `/models`、`/mode`、`/permissions` 作为兼容快捷入口
- [ ] 为 `/settings` 面板与返回导航补测试

Acceptance criteria:

- [ ] 用户只需一个入口就能理解当前会话配置
- [ ] 原有命令仍然可用，不破坏兼容性
- [ ] 关键策略开关都可见、可切换

## Phase 8: 计划历史与启动恢复

- [ ] 启动时扫描未完成的：
  - `plan_sessions`
  - `pending_user_inputs`
  - `pending_approvals`
  - `queued_turn_inputs`
- [ ] 为 `recovery_required` session 发恢复卡
- [ ] 恢复卡支持：
  - `继续上次计划`
  - `查看上次计划`
  - `取消并清理`
- [ ] 让旧 callback 在重启后仍能通过 local id 找回记录
- [ ] 在 turn 丢失时标记实时卡为 stale，但保留 session 历史
- [ ] 增加历史清理策略：
  - 按保留天数
  - 按每 chat 最大 session 数
- [ ] 为重启恢复补测试：
  - 待确认计划
  - 待回答 prompt
  - 待审批
  - 待消费队列

Acceptance criteria:

- [ ] bridge 重启后不会把用户留在“无上下文”的状态
- [ ] 历史可恢复，但不会伪装成实时流还在继续
- [ ] 数据能定期清理，不无限膨胀

## Phase 9: 文档、状态文案与验收

- [ ] 更新 `README.md`
  - 增加 `/settings`
  - 增加 guided plan session 说明
  - 明确哪些体验是 Codex App 等价，哪些仍是 Telegram 近似
- [ ] 更新 `src/i18n.ts`
  - 新状态
  - 新按钮
  - 新恢复文案
- [ ] 更新 `/help`
- [ ] 增加完整的端到端 smoke checklist
- [ ] 在真实 Telegram 环境做手工验证：
  - 计划确认
  - revise
  - cancel
  - prompt review
  - queue
  - approval details
  - restart recovery

Acceptance criteria:

- [ ] README、交互文案、实际行为一致
- [ ] 用户能通过帮助和设置页自行理解新能力
- [ ] 手工 smoke 覆盖 7 个核心目标

## 推荐实施顺序

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7
8. Phase 8
9. Phase 9

## 不建议并行推进的组合

- [ ] 不要在没有 `plan_sessions` 的前提下先做恢复
- [ ] 不要在没有 prompt review 的前提下先做“改答”
- [ ] 不要在没有持久化队列的前提下先做“自动续跑”
- [ ] 不要在没有审批详情数据模型的前提下只改 UI
