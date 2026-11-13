/**
 * handoff-hint —— 存在 .pi/HANDOFF.md 时提醒一次
 *
 * 为什么：/handoff 把交接正文写进 .pi/HANDOFF.md，新会话不该把正文塞进 prompt，
 * 但需要一个指路，否则模型不会主动去读。
 *
 * 行为：
 *  - session_start：检查文件是否存在，存在就在状态栏挂「📋 HANDOFF 2 小时前」
 *  - before_agent_start：本会话第一次收到用户消息时，注入一行指路（display: false），
 *    只提示去读文件，不搬运内容；之后不再重复
 */

import * as fs from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

function ageText(at: number): string {
	const diff = Date.now() - at;
	if (diff < 60_000) return "刚刚";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
	return `${Math.floor(diff / 86_400_000)} 天前`;
}

/** 状态栏用的紧凑写法：2m / 3h / 5d */
function compactAge(at: number): string {
	const diff = Date.now() - at;
	if (diff < 60_000) return "now";
	if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
	if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
	return `${Math.floor(diff / 86_400_000)}d`;
}

export default function handoffHint(pi: ExtensionAPI): void {
	let path: string | undefined;
	let mtime = 0;
	let hinted = false;

	pi.on("session_start", async (_event, ctx) => {
		hinted = false;
		path = join(ctx.cwd, CONFIG_DIR_NAME, "HANDOFF.md");
		try {
			const stat = fs.statSync(path);
			if (!stat.isFile()) {
				path = undefined;
				ctx.ui.setWidget("handoff-hint", undefined);
				return;
			}
			mtime = stat.mtimeMs;
			ctx.ui.setWidget("handoff-hint", [`📋 HANDOFF ${compactAge(mtime)}`]);
		} catch {
			path = undefined;
			try {
				ctx.ui.setWidget("handoff-hint", undefined);
			} catch {
				// 非 UI 模式忽略
			}
		}
	});

	pi.on("before_agent_start", async (event) => {
		if (hinted || !path) return;
		if (event.messageType !== "user") return;
		hinted = true;
		return {
			message: {
				customType: "handoff-hint",
				content: `本目录有 ${path}（${ageText(mtime)}生成）：接续或接手任务前先读它，正文不在这里。`,
				display: false,
			},
		};
	});
}
