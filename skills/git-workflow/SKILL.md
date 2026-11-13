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
- 只 add 与本次逻辑改动相关的文件，无关改动用 git add -p 拆开或留在工作区
- 提交信息：类型 + 简短描述，如 `fix: 修复登录接口空指针`
- 一个功能不超过 3-5 个原子提交，超过说明粒度可能太小

## 阶段整理
- 先列当前分支历史，与用户确认整理范围
- 同一逻辑线索的散提交 squash 成有意义的提交
- 重写提交信息，删掉 wip / temp / debug 类噪音
- 检查整理后的历史是否可理解、可回溯

## 安全边界
- 只整理未推送的本地提交；已推送历史不重写，除非用户明确要求
- 绝不 force push，除非用户明确要求且确认过目标分支
- 不做 commit / push / PR 之外的操作，除非用户要求

## 交付前自检
- 每个提交只含一个逻辑改动，单独 revert 不会牵连其他改动
- 提交信息能让人不看 diff 就知道改了什么
- 没有 wip/temp 噪音，也没有把无关文件顺手带进 add
