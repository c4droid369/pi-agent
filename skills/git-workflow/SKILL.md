---
name: git-workflow
description: 原子提交与阶段整理 - 只能用 /skill:git-workflow 显式启用；用于创建和整理本地提交，保持小步原子化与可回溯历史。不自动触发，因为提交需要明确授权
disable-model-invocation: true
metadata:
  version: 0.0.2
  author: c4droid369 <c4droid369@users.noreply.github.com>
---
# Git Workflow

## 启用即授权
- 显式启用后，可创建与整理本地 commit
- 全局「不要做破坏性 git 操作」仍然生效，本 skill 不放宽它

## 原子提交
- 完成一个逻辑独立的改动立即提交，不堆积到批处理
- 只 add 与本次逻辑改动相关的文件，无关改动用 `git add -p` 拆开或留在工作区
- 提交信息：类型 + 简短描述，如 `fix: 修复登录接口空指针`
- 一个功能不超过 3-5 个原子提交，超过说明粒度可能太小

## 整理流程（含命令）
- 先看要整理什么：`git status --short`；未推送范围 `git log --oneline @{u}..`，
  没配上游会报错，先用 `git branch -vv` 确认，或退化为 `git log --oneline -20` 手工界定起点
- 与用户确认整理范围后再动手；同一逻辑线索的散提交 squash：`git rebase -i HEAD~N`，标记 `fixup` / `reword` / `drop`
- **非交互环境**（助手跑 bash 时无法打开交互编辑器）：
  - 逐条认领：`git commit --fixup <目标提交>` + `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash HEAD~N`
  - 整体合并最近 N 个：`git reset --soft HEAD~N && git commit`
  - 两者都会重写提交，仅限未推送；遇冲突停下来说明现场，不硬解
- 重写提交信息，删掉 wip / temp / debug 类噪音；检查整理后的历史可理解、可回溯
- 拆提交：`git add -p`；重选某文件的暂存内容：`git reset -p`
- 提交前自检：`git diff --cached --stat`，确认只含本次逻辑的改动
- 改错了但还没推送：`git commit --amend`（**仅限未推送**）

## 安全边界
- 只整理未推送的本地提交；已推送历史不重写，除非用户明确要求
- 绝不 force push，除非用户明确要求且确认过目标分支
- 不做 commit / push / PR 之外的操作，除非用户要求

## 交付前自检
- 每个提交只含一个逻辑改动，单独 revert 不会牵连其他改动
- 提交信息能让人不看 diff 就知道改了什么
- 没有 wip/temp 噪音，也没有把无关文件顺手带进 add
