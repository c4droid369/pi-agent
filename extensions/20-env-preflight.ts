/**
 * env-preflight —— 只在「该提醒」的时候提醒
 *
 * 前提：用户习惯先 `guix shell` 再启动 Pi。
 *
 * 规则（刻意做到正常时完全静默）：
 *  - 已在 guix shell 里            -> 不显示任何东西
 *  - 不在 shell 且是 guix 项目      -> 显示一行 + notify 一次，给出起 shell 的命令
 *  - 不在 shell 且不是 guix 项目    -> 不显示（guix shell 跟这个项目无关）
 *
 * 不再探测 guix/python3/perf/gdb/cc，也不显示 git 仓库状态：
 * 在 guix shell 里工具必然齐；git 状态由 handoff 的硬事实段负责。
 *
 * 行序：widget 的垂直顺序由扩展加载顺序决定（文件名升序，先加载在上），
 * 本文件用 20- 前缀，落在 10-long-command-guard 下方、紧贴编辑器。改文件名会影响行序。
 */

import * as fs from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function inGuixShell(): boolean {
	const env = process.env.GUIX_ENVIRONMENT;
	return typeof env === "string" && env.trim().length > 0;
}

function hasGuixProject(cwd: string): boolean {
	try {
		return fs.existsSync(join(cwd, "guix.scm"));
	} catch {
		return false;
	}
}

export default function envPreflight(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const warn = !inGuixShell() && hasGuixProject(ctx.cwd);
		try {
			ctx.ui.setWidget("env-preflight", warn ? ["⚠ 不在 guix shell · 这个项目有 guix.scm"] : undefined);
		} catch {
			// 非 UI 模式忽略
		}
		if (!warn) return;
		ctx.ui.notify(
			"环境预检：当前不在 guix shell，而项目有 guix.scm。长任务前先起 guix shell -D -f guix.scm（带调试工具加 -m shell.scm）。",
			"warning",
		);
	});
}
