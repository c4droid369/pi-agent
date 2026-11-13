# pi-agent 协作配置

一套长期维护的 [pi coding agent](https://pi.dev) 配置：全局指令、技能（skills）与手写扩展（extensions）。
目标是让「规则」不靠记性，而是落到文件和执行期。

## 目录结构

```
AGENTS.md          # 全局指令：沟通方式、授权边界、工具使用、长命令与验证、Skills 路由表
settings.json      # 默认模型 / 工具选择（不含凭据）
mcp.json           # MCP 服务器声明（filesystem）
skills/            # 9 个自包含技能，每个目录只有一份 SKILL.md
extensions/        # 手写扩展
  10-long-command-guard.ts   # 给可能跑很久的 bash 命令自动加 timeout，复杂命令拦下并要求改写
  20-env-preflight.ts        # 仅在「不在 guix shell 且项目有 guix.scm」时提示
  30-change-ledger.ts        # 记录本轮改过哪些文件 / 跑过哪些验证，/touched 打印明细
  40-handoff-hint.ts         # 存在 .pi/HANDOFF.md 时提示一次（只指路，不搬正文）
  handoff.ts                 # /handoff：把当前会话交接成新会话，正文写 .pi/HANDOFF.md
  plan-mode/                 # /plan：只读探索 + 计划步骤跟踪
```

## 为什么不放这些进仓库

| 路径 | 原因 |
|---|---|
| `auth.json` | 明文 API key |
| `sessions/` | 会话记录，含隐私与大量体积 |
| `models-store.json` | pi 生成的模型目录缓存，随升级变化 |
| `npm/` | pi 自己管理的包目录 |

`.gitignore` 已覆盖以上全部。

## 扩展的几个约定

**行序**：编辑器上方的 widget 按**扩展文件名升序**从上到下排列（先加载的在上）。所以改文件名会改变显示顺序，`10-` / `20-` / `30-` / `40-` 前缀就是用来钉死顺序的。

**单一职责**：每个扩展只干一件事，且能单独禁用（`pi -ne` 全关，或 `pi -e` 单开一个试用）。

**静默优先**：正常状态不占屏幕。环境预检只在异常时出现，长命令守卫只在长命令执行期间出现。

**不搬正文**：`handoff` 生成的内容写到 `.pi/HANDOFF.md`，新会话只拿到一句指路；`handoff-hint` 同理。

## 使用

本机当前采用「仓库放 `~/project/pi-agent`，配置目录用软链指过去」的布局：

```
~/project/pi-agent/     ← 本仓库（在这里 git init / clone）
~/.pi/agent/AGENTS.md     -> ~/project/pi-agent/AGENTS.md
~/.pi/agent/settings.json -> ~/project/pi-agent/settings.json
~/.pi/agent/mcp.json      -> ~/project/pi-agent/mcp.json
~/.pi/agent/skills        -> ~/project/pi-agent/skills
~/.pi/agent/extensions    -> ~/project/pi-agent/extensions
```

`~/.pi/agent` 里只留不进版本控制的东西：`auth.json`、`sessions/`、`npm/`、`models-store.json`。
这样修改仓库 = 修改生效的配置，而 `git checkout` / `git clean` 不会碰到凭据与会话记录。

**软链已验证**：pi 会跟随 `skills/`、`extensions/` 目录软链以及 `AGENTS.md` 软链（实测加载到 7 个模型可见技能、扩展正常注册）。

其他方案：

```sh
# 全新机器：agent 目录为空时可直接克隆
 git clone <repo> ~/.pi/agent

# 只想要某个扩展：单次加载，不改配置
 pi -e ~/.pi/agent/extensions/handoff.ts
```

## 注意

- 仓库与生效配置通过软链连接：改仓库立刻生效（已开着的会话需 `/reload`）。
- 不要往 `~/.pi/agent` 里重建同名实体文件/目录，否则会盖掉软链，仓库就与生效配置脱节。
- 技能与扩展里含有本机绝对路径（如 `/home/<user>/…`），公开前请自行确认是否介意。
- 需要 pi 1.5.x；扩展用到的 API（`ctx.ui.setWidget`、`ctx.ui.setStatus`、`registerCommand`、`before_agent_start`）在该版本上验证过。

## 技能清单

| 技能 | 用途 |
|---|---|
| `clarify-first` | 需求澄清：有歧义、多方案分叉时先问 |
| `design` | 架构选型与结构重构 |
| `diagnose` | 有具体症状的排查（报错、偶发、慢） |
| `quality-review` | 代码评审 / 安全审计 / 质量门禁 |
| `vuln-research` | 外部项目的漏洞挖掘、PoC 复现与影响面判定（仅验证、非武器化） |
| `testing-guidelines` | 测试编写与策略 |
| `minimal-change` | 控制代码量与改动范围 |
| `git-workflow` | 原子提交与历史整理（只能显式启用） |
| `project-onboarding` | 陌生项目摸底与项目卡片 |
