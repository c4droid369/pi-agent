/**
 * status-bar —— 把「当前在跑什么、跑了多久」放到状态栏
 *
 * 为什么：长任务期间助手往往静默执行，用户被迫盯屏轮询。
 * 这个扩展不改上下文、不改工具行为，只做展示。
 *
 * 显示内容：
 *   运行中：▶ 1:23 · 3 调用 · 长 1 │ make check
 *   结束后：✓ 45s · 12 调用 · 长 2
 * 「长」= 单次执行超过 60 秒的调用次数。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const LONG_MS = 60_000;

function formatDuration(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	return minutes > 0 ? `${minutes}:${String(seconds).padStart(2, "0")}` : `${seconds}s`;
}

function describeArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	const raw =
		toolName === "bash"
			? typeof record.command === "string"
				? record.command
				: ""
			: typeof record.path === "string"
				? record.path
				: "";
	const oneLine = raw.replace(/\s+/g, " ").trim();
	return oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine;
}

export default function statusBar(pi: ExtensionAPI): void {
	const running = new Map<string, string>();
	let startedAt = 0;
	let calls = 0;
	let longCalls = 0;
	let settled = false;
	let ticker: ReturnType<typeof setInterval> | undefined;

	function render(ctx: ExtensionContext): void {
		try {
			if (running.size > 0) {
				const latest = [...running.values()].at(-1) ?? "";
				const head = `▶ ${formatDuration(Date.now() - startedAt)} · ${calls} 调用`;
				const tail = longCalls > 0 ? ` · 长 ${longCalls}` : "";
				ctx.ui.setStatus("status-bar", `${head}${tail}${latest ? ` │ ${latest}` : ""}`);
				return;
			}
			if (startedAt > 0 && !settled) {
				// 工具之间的间隙仍显示计时，避免状态栏闪烁/消失
				const head = `▶ ${formatDuration(Date.now() - startedAt)} · ${calls} 调用`;
				ctx.ui.setStatus("status-bar", longCalls > 0 ? `${head} · 长 ${longCalls}` : head);
				return;
			}
			if (settled && startedAt > 0) {
				const head = `✓ ${formatDuration(Date.now() - startedAt)} · ${calls} 调用`;
				ctx.ui.setStatus("status-bar", longCalls > 0 ? `${head} · 长 ${longCalls}` : head);
				return;
			}
			ctx.ui.setStatus("status-bar", undefined);
		} catch {
			// 非 UI 模式下忽略
		}
	}

	function startTicker(ctx: ExtensionContext): void {
		if (ticker) return;
		ticker = setInterval(() => render(ctx), 1_000);
		// 不让计时器拖住进程退出
		(ticker as unknown as { unref?: () => void }).unref?.();
	}

	function stopTicker(): void {
		if (!ticker) return;
		clearInterval(ticker);
		ticker = undefined;
	}

	pi.on("agent_start", async (_event, ctx) => {
		running.clear();
		startedAt = Date.now();
		calls = 0;
		longCalls = 0;
		settled = false;
		render(ctx);
		startTicker(ctx);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		calls += 1;
		running.set(event.toolCallId, describeArgs(event.toolName, event.args));
		render(ctx);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		running.delete(event.toolCallId);
		if ((event.durationMs ?? 0) >= LONG_MS) longCalls += 1;
		render(ctx);
	});

	pi.on("turn_end", async (_event, ctx) => {
		if (running.size === 0) render(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		settled = true;
		running.clear();
		stopTicker();
		render(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopTicker();
	});
}
