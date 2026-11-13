/**
 * change-ledger —— 记录本轮改过哪些文件、跑过哪些验证
 *
 * 为什么：全局规则要求「改完核对 diff」「验证不得虚报」，但这些只能靠自觉。
 * 这个扩展把两者变成可核对的记录，并挂在状态栏上。
 *
 * 显示：
 *   ✎ 3 文件 · ⚠ 未验证   改了但没跑验证
 *   ✎ 3 文件 · ⚠ 改后未验  验证过但之后又改了
 *   ✎ 3 文件 · ✓ 已验      最近一次验证在最近一次改动之后
 * 命令：/touched 打印明细
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const WRITE_TOOLS = new Set(["write", "edit"]);

/** 算作「验证」的命令 */
const VERIFY_PATTERN =
	/(^|[\s;&|(])(make\s+(check|test|check-)|npm\s+test|pnpm\s+test|yarn\s+test|pytest|tox|\.\/tests\/|cargo\s+test|go\s+test|ctest|\bsan\b)/;

interface Verification {
	command: string;
	ok: boolean;
	at: number;
}

function clock(at: number): string {
	const d = new Date(at);
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export default function changeLedger(pi: ExtensionAPI): void {
	const edits = new Map<string, Set<string>>();
	const verifications: Verification[] = [];
	/** toolCallId -> 原始命令，用于 tool_execution_end 时回查 */
	const pending = new Map<string, string>();
	let editSeq = 0;
	let verifySeq = 0;

	function verdict(): string {
		if (edits.size === 0) return verifications.length > 0 ? "✓ 已验" : "";
		if (verifySeq === 0) return "⚠ 未验证";
		return verifySeq < editSeq ? "⚠ 改后未验" : "✓ 已验";
	}

	function render(ctx: ExtensionContext): void {
		try {
			const parts: string[] = [];
			if (edits.size > 0) parts.push(`✎ ${edits.size} 文件`);
			const state = verdict();
			if (state) parts.push(state);
			const text = parts.length > 0 ? parts.join(" · ") : undefined;
			// 用 widget 而不是 footer status：footer 是所有扩展共用的一行，放不下多行信息
			ctx.ui.setWidget("change-ledger", text ? [text] : undefined);
		} catch {
			// 非 UI 模式忽略
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		edits.clear();
		verifications.length = 0;
		pending.clear();
		editSeq = 0;
		verifySeq = 0;
		render(ctx);
	});

	pi.on("tool_call", async (event) => {
		const input = event.input as { command?: unknown } | undefined;
		if (event.toolName === "bash" && typeof input?.command === "string") {
			pending.set(event.toolCallId, input.command);
			return;
		}
		if (!WRITE_TOOLS.has(event.toolName)) return;
		const path = (input as { path?: unknown } | undefined)?.path;
		if (typeof path !== "string" || !path) return;
		if (!edits.has(path)) edits.set(path, new Set());
		edits.get(path)?.add(event.toolName);
		editSeq += 1;
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = pending.get(event.toolCallId);
		if (!command) return;
		pending.delete(event.toolCallId);
		if (!VERIFY_PATTERN.test(command)) return;
		verifications.push({ command, ok: event.isError !== true, at: Date.now() });
		verifySeq += 1;
		render(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => render(ctx));

	pi.on("agent_settled", async (_event, ctx) => render(ctx));

	pi.registerCommand("touched", {
		description: "打印本轮改过的文件与验证记录",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			if (edits.size === 0) {
				lines.push("本轮还没有 write/edit 记录。");
			} else {
				lines.push(`改动文件（${edits.size}）：`);
				for (const [path, tools] of edits) {
					lines.push(`- ${path}（${[...tools].join("/")}）`);
				}
			}
			if (verifications.length === 0) {
				lines.push("", "验证记录：无（没跑过看起来像验证的命令）");
			} else {
				lines.push("", `验证记录（${verifications.length}）：`);
				for (const v of verifications) {
					lines.push(`- ${v.ok ? "✓" : "✗"} ${v.command}（${clock(v.at)}）`);
				}
			}
			const state = verdict();
			if (state === "⚠ 改后未验") lines.push("", "⚠ 最近一次改动晚于最近一次验证，需要重跑。");
			if (state === "⚠ 未验证") lines.push("", "⚠ 改了文件但没有任何验证记录。");
			ctx.ui.notify(lines.join("\n"), state.startsWith("⚠") ? "warning" : "info");
		},
	});
}
