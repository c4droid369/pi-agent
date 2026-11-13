/**
 * long-command-guard —— 给可能跑很久的 bash 命令自动加上限
 *
 * 行序：widget 的垂直顺序由扩展加载顺序决定（文件名升序，先加载在上），
 * 所以本文件用 10- 前缀保证它比 20-env-preflight 更靠上。改文件名会影响行序。
 *
 * 为什么：历史会话里 84% 的 bash 墙钟时间花在单条 >60s 的命令上，最长的 1800s，
 * 且多次出现「跑了 10 分钟没输出」的静默等待。规则写在 AGENTS.md 里，靠自觉；
 * 这个扩展把它落到执行期。
 *
 * 行为（只对 bash 工具生效）：
 *  1. 命令已含 timeout -> 放行
 *  2. 命令命中「长命令」模式且没有 timeout
 *     - 简单命令（无 && || ; | 换行、无前置 VAR=、不以 cd 开头）-> 前缀 timeout N
 *     - 其余 -> 拦下并给出改写建议（避免 timeout 只包住命令片段）
 *  3. 其余命令 -> 放行
 *
 * 上限默认 1800 秒，可用环境变量 PI_LONG_CMD_TIMEOUT 覆盖。
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const DEFAULT_TIMEOUT_SECONDS = 1800;

function timeoutSeconds(): number {
	const raw = Number(process.env.PI_LONG_CMD_TIMEOUT ?? "");
	return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_TIMEOUT_SECONDS;
}

/** 看起来会跑很久的命令（只看命令开头，避免误伤管道里的 make） */
const LONG_PATTERNS: RegExp[] = [
	/^\s*make(\s|$)/,
	/^\s*guix(\s|$)/,
	/^\s*cargo\s+(build|test|run|check|install|bench)\b/,
	/^\s*(npm|pnpm|yarn)\s+(test|run|install|ci|build|audit)\b/,
	/^\s*(pytest|tox|nox)\b/,
	/^\s*go\s+(test|build|vet)\b/,
	/^\s*(cmake|ctest|ninja)\b/,
	/^\s*\.\/tests\//,
	/^\s*\.\/bench\//,
	/^\s*bash\s+\S*test/,
];

/** 加 timeout 前缀会破坏语义的情形 */
function isComplex(command: string): boolean {
	return (
		/&&|\|\||[;|\n]/.test(command) ||
		/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command) ||
		/^\s*(cd|pushd|source|\.)\s/.test(command)
	);
}

function hasTimeout(command: string): boolean {
	return /(^|[;&|(]\s*)timeout\s+(-\S+\s+)*\d/.test(command);
}

/** 按 shell 分隔符切开，逐段看是否命中长命令模式 */
function segments(command: string): string[] {
	return command
		.split(/&&|\|\||[;|\n]/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** 去掉前置的 VAR=value，使 FOO=1 make check 也能被认出来 */
function stripAssignments(segment: string): string {
	return segment.replace(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
}

function matchesLongPattern(command: string): boolean {
	return segments(command).some((segment) => {
		const body = stripAssignments(segment);
		return LONG_PATTERNS.some((pattern) => pattern.test(body));
	});
}

export default function longCommandGuard(pi: ExtensionAPI): void {
	let applied = false;

	/** footer 的 setStatus 被所有扩展共用一行，用 widget 才能单独占一行 */
	function setLine(ctx: ExtensionContext, text?: string): void {
		try {
			ctx.ui.setWidget("long-command-guard", text ? [text] : undefined);
		} catch {
			// 非 UI 模式下忽略
		}
	}

	function clearStatus(ctx: ExtensionContext): void {
		if (!applied) return;
		applied = false;
		setLine(ctx);
	}

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const input = event.input as { command?: unknown };
		const command = typeof input.command === "string" ? input.command : "";
		if (!command || !matchesLongPattern(command) || hasTimeout(command)) return;

		const limit = timeoutSeconds();

		if (isComplex(command)) {
			return {
				block: true,
				reason: [
					`长命令守卫：这条命令可能跑很久，但没有 timeout，且含 && / ; / | / 换行或 cd / VAR= 前缀，无法安全地加前缀。`,
					`请改写后重试，例如：timeout ${limit} bash -c '<原命令>'`,
					"建议同时把输出重定向到 /tmp/<名字>.log，再 tail 抽样。",
					"确实不该限时的，命令里显式加一个足够大的 timeout 即可放行。",
				].join("\n"),
			};
		}

		input.command = `timeout ${limit} ${command}`;
		applied = true;
		try {
			ctx.ui.setWidget("long-command-guard", [`⏳ 已给这条命令加 ${limit}s 上限`]);
		} catch {
			// 非 UI 模式下忽略
		}
		return;
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "bash") clearStatus(ctx);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		clearStatus(ctx);
	});
}
