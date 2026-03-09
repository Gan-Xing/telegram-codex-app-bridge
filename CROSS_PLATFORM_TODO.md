# macOS + Linux 统一适配 TODO

## 需求理解

- 目标不是维护两套 bridge，而是在不破坏现有 macOS 体验的前提下，让仓库同样稳定支持 Linux。
- 能统一的统一成一套代码路径、配置模型、命令入口和运维接口。
- 不能统一的部分按平台识别后走原生实现，尤其是服务管理和桌面集成。
- 不采用“为了统一而在 macOS 上强行引入 systemctl/systemd”的方案。对用户统一暴露命令入口即可，底层仍应使用各平台原生机制。

## 当前代码现状

### 已经基本跨平台的部分

- `src/main.ts`
  - 主入口本身没有绑定 macOS。
- `src/config.ts`
  - 路径基于 `os.homedir()` 生成，不依赖 `/Users/...` 这类硬编码目录。
- `src/codex_app/client.ts`
  - 核心桥接实际依赖的是 `codex app-server`，这是当前最适合跨平台统一的公共层。
- `src/codex_app/deeplink.ts`
  - 已经区分了 `darwin` 和 Linux 默认 `xdg-open`。

### 当前仍保留原生平台分叉的部分

- `scripts/launchd/install.sh`
  - 作为 macOS 原生 `launchd` 安装实现保留。
- `scripts/service/install-systemd.sh`
  - 作为 Linux 原生 `systemd --user` 安装实现保留。
- `skills/chat-to-codex/scripts/bootstrap_host.py`
  - 已改成 host-aware，但仍会按不同平台选择 Node 下载目标和服务安装路径。
- `src/platform/capabilities.ts`
  - 统一收口平台能力判断，但底层仍按 OS 走不同原生实现。

### 当前剩余的风险点

- `/open` 和 `/reveal`
  - 现在已经改成 capability-based，但 Linux 上 deeplink handler 仍然属于 best effort，后续还需要进一步验证真实桌面联动体验。
- macOS 回归验证
  - 当前改动已经通过 Linux 上的构建、测试和 `doctor`，但还没有在 macOS 上做最终 smoke test。

## 最佳实践结论

### 1. 继续保持“一套核心运行时”

- 核心 TypeScript bridge 不应拆成 macOS 版和 Linux 版。
- 跨平台统一层应建立在：
  - `codex app-server`
  - 一套 `.env` 配置模型
  - 一套 Telegram 交互逻辑
  - 一套状态文件 / 锁文件 / SQLite 存储路径策略

### 2. 服务管理统一“接口”，不要统一“内核”

- Linux 用 `systemd --user`。
- macOS 用 `launchd`。
- 不建议在 macOS 上为了追求表面统一去安装 systemd/systemctl。
- 真正应该统一的是运维入口，例如：
  - `./scripts/service/install.sh`
  - `./scripts/service/uninstall.sh`
  - `./scripts/service/start.sh`
  - `./scripts/service/stop.sh`
  - `./scripts/service/status.sh`
  - `./scripts/service/logs.sh`

### 3. 桌面能力改成 capability gate

- bridge 运行本身和“打开桌面 app”不是一回事。
- macOS 可以继续保留桌面联动体验。
- Linux 需要允许以下模式独立成立：
  - bridge 可运行
  - `codex app-server` 可连接
  - `/open` `/reveal` 可能不可用或仅 best effort
- 用户看到的行为应该是：
  - 支持时执行打开动作
  - 不支持时明确提示当前主机不支持桌面打开，并返回 thread id / 后续操作建议

### 4. 统一配置，最小化平台分叉

- 现有 `.env` 字段尽量保留。
- 新增平台差异时优先做“可推导能力”，不要一开始就加很多 Linux/Mac 专属环境变量。
- 只有在自动推断不可靠时，才增加显式配置，例如：
  - `CODEX_DESKTOP_ENABLED=auto|true|false`
  - `SERVICE_MANAGER=auto|launchd|systemd|manual`

### 5. 优先做 user-scoped service

- Linux 先支持 `systemd --user`，避免默认要求 root。
- macOS 继续用用户级 `LaunchAgents`。
- 两边都维持“用户态安装、用户态日志、用户态状态文件”这一原则。

## 执行 TODO

### Phase 1: 平台能力模型

- [x] 新增统一的平台能力模块，例如 `src/platform/capabilities.ts`
- [x] 输出标准能力对象：
  - `os`
  - `serviceManager`
  - `supportsDesktopOpen`
  - `supportsDeepLink`
  - `supportsAutolaunch`
- [x] 把 `process.platform` 相关判断从零散位置收拢到统一模块
- [x] 为平台能力检测补测试

### Phase 2: 统一服务入口

- [x] 新增 `scripts/service/` 目录，提供统一入口脚本
- [x] 在 macOS 下由统一入口调用 launchd 安装/重载
- [x] 在 Linux 下生成并安装 `systemd --user` unit
- [x] 保证两边都使用同一套工作目录、日志目录、状态文件目录
- [x] 增加 `logs` 和 `restart` 入口，不再只提供单个平台脚本
- [x] 保留 `scripts/launchd/install.sh` 作为内部实现或兼容入口，不再让 README 直接暴露它

### Phase 3: 运行时降级与桌面能力解耦

- [x] 把 `/open` `/reveal` 相关逻辑改成先检查 capability 再执行
- [x] Linux 上当 deeplink/desktop 不可用时，返回明确的降级提示
- [x] `doctor` 增加平台能力检查项：
  - `codex` CLI 是否存在
  - `app-server` 是否可用
  - 桌面打开是否可用
  - 当前 service manager 是什么
- [x] 重新审视 `CODEX_APP_LAUNCH_CMD` 的默认值与实际可用性
- [x] 如果 launch command 无法自动可靠判断，则改成“可选能力”而不是默认假设

### Phase 4: Bootstrap 与 Skill 跨平台化

- [x] 将 `bootstrap_host.py` 从 Darwin-only 改成 host-aware
- [x] 为 Node 下载逻辑补 Linux 架构映射
- [x] 将 service 安装从“直接装 launchd”改成“调用统一 service 入口”
- [x] 更新 `bootstrap_remote.py` 的描述和流程，使其不再默认远端一定是 Mac
- [x] 更新 `skills/chat-to-codex/SKILL.md`
  - 从 Mac-first 改成 macOS/Linux aware
  - 验证步骤按平台分支
  - 文案不再把 launchd 当成唯一服务方式

### Phase 5: 文档与文案修正

- [x] 改写 `README.md` 的 Requirements，区分：
  - bridge 运行要求
  - 桌面联动要求
  - 平台差异说明
- [x] 在 Setup 中提供两条主路径：
  - macOS + launchd
  - Linux + systemd user service
- [x] `Operations` 统一改成 `scripts/service/*`
- [x] 更新 `.env.example`，去掉误导性的 macOS 示例路径
- [x] 更新 `src/i18n.ts` 中直接写死 `Codex.app` 的文案，使其更中性或按平台输出

### Phase 6: 测试与验收

- [x] 为平台能力模块补单测
- [x] 为 service 文件生成逻辑补测试
- [x] 为 `/reveal` 在 unsupported host 上的降级行为补测试
- [x] 为 `doctor` 新增平台检查补测试
- [x] 在 macOS 做一次回归 smoke test
- [x] 在 Linux 做一次完整 smoke test

## 完成标准

- [x] 同一套 repo 可以在 macOS 和 Linux 上通过 `npm run build`
- [x] 同一套 repo 可以在 macOS 和 Linux 上通过 `npm run doctor`
- [x] 用户只需要记住统一的 service 命令入口，不需要记住 launchd/systemd 细节
- [ ] macOS 现有体验不倒退
- [x] Linux 即使没有桌面 app 也能稳定作为 bridge 主机运行
- [x] skill、README、脚本和运行时行为一致

### 2026-03-09 macOS 验收记录

- 已验证：`npm test`、`npm run build`、`npm run doctor`
- 已验证：`./scripts/service/install.sh`、`./scripts/service/status.sh`、`./scripts/service/logs.sh`、`./scripts/service/restart.sh`
- 已验证：macOS `open` 可以成功执行 `codex://threads/<threadId>` deep link
- 阻塞项：`./scripts/service/restart-safe.sh` 默认会 `source .env`，当前 `.env` 中 `CODEX_APP_LAUNCH_CMD=codex app` 这类带空格的值会被 shell 误解析，导致脚本失败；因此 `macOS 现有体验不倒退` 暂不能勾选

## 实施顺序建议

1. 先做平台能力模型和统一 service 入口。
2. 再做 runtime capability gate，避免 Linux 被 `/reveal` 之类的桌面能力拖垮。
3. 之后改 bootstrap 和 skill。
4. 最后统一 README、`.env.example`、i18n 与验收测试。

## 明确不做的方案

- [x] 不在 macOS 上强行依赖 systemd/systemctl
- [x] 不拆成两套独立业务代码
- [x] 不把“桌面 app 可打开”当成 bridge 可运行的前置条件
