/**
 * handoff —— 把当前会话交接成一个新的聚焦会话
 *
 * 相比官方 `examples/extensions/handoff.ts` 的改动：
 *  P1 总字符预算：超预算时保留「首条用户消息 + 最近的轮次」，发送前告知将发送多少
 *  P2 硬事实由脚本采集（git 状态/改动、涉及到的文件、工具/模型/环境），不让模型凭记忆写
 *  P3 生成结果先落盘 `<project>/.pi/HANDOFF.md`，再开新会话
 *  P4 输出结构钉死为四段式，缺段落重试一次，仍缺则显式标注
 *  P5 摘要失败时用「硬事实 + 目标」兜底，不丢上下文
 *  P8 无参数时默认「接续当前任务」；非 TUI 模式只打印 + 落盘，不切会话
 *  P9 prompt 头部带元信息（cwd / 模型 / 工具 / 父会话 / 读过的 Skill、可用的 Skill）
 *  P11 新会话只拿到一个指向 HANDOFF.md 的短 prompt，正文不塞进上下文
 *
 * 用法：/handoff [下一步要做什么]
 */

import * as fs from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type Message, uuidv7 } from "@earendil-works/pi-ai";
import {
	BorderedLoader,
	CONFIG_DIR_NAME,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";

/** 目标缺失时的默认值（P8） */
const DEFAULT_GOAL = "接续当前任务：先复述现场状态，再继续没做完的部分";

/** 发训练模型的总字符预算（P1）。约 60k 字符 ≈ 20k token，留足输出余量。 */
const BUDGET_CHARS = 60_000;
/** 首条用户消息最多保留多少字符（原始需求往往很长但最重要） */
const FIRST_MESSAGE_CAP = 4_000;
/** 单条 tool call 参数 / 错误输出的截断长度 */
const ARGS_CAP = 240;
const ERROR_CAP = 400;
/** 硬事实里 git 输出的截断长度 */
const GIT_CAP = 2_000;
/** 改动文件清单最多列多少条 */
const FILES_CAP = 40;

const SECTION_FILES = "## 改了哪些文件";
const SECTION_CHANGES = "## 关键改动";
const SECTION_VERIFY = "## 验证命令与结果";
const SECTION_RISK = "## 未验证项与风险";
const SECTION_NEXT = "## 下一步";
const REQUIRED_SECTIONS = [SECTION_FILES, SECTION_CHANGES, SECTION_VERIFY, SECTION_RISK];

const SYSTEM_PROMPT = `你是上下文交接助手。用户要把当前会话交接给一个新的、聚焦的会话。
你会收到三部分：脚本采集的「硬事实」、压缩过的对话记录、用户对新会话的目标。

要求：
1. 只依据给定材料，不要编造没出现的命令、文件、结论。
2. 必须严格按下面的段落输出，段标题逐字一致，不要加别的顶级标题：

${SECTION_FILES}
（文件路径列表，每条注明是新增/修改/删除之一；没有就写「无」）

${SECTION_CHANGES}
（关键改动，按模块分组，说明为什么这么改；带出仍然有效的约束/契约）

${SECTION_VERIFY}
（跑了哪些命令、结果如何；没跑过的写「未运行」）

${SECTION_RISK}
（未验证项、已知风险、待确认的假设）

${SECTION_NEXT}
（新会话第一件该做的事，2–4 条）

3. 对话记录可能被截断；截断处不要猜，直接在对应段落里标注「记录缺失」。
4. 不要复述硬事实里的原文，硬事实会原样带到新会话。
5. 用简体中文，简洁，不要客套话。`;

// ---------------------------------------------------------------------------
// 会话记录整理
// ---------------------------------------------------------------------------

function entryToMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		return entry.message;
	}
	if (entry.type === "compaction") {
		return {
			role: "compactionSummary",
			summary: entry.summary,
			tokensBefore: entry.tokensBefore,
			timestamp: new Date(entry.timestamp).getTime(),
		};
	}
	return undefined;
}

/** 取当前分支；若经过压缩，用「压缩摘要 + firstKeptEntryId 之后的条目」 */
function getHandoffMessages(branch: SessionEntry[]): AgentMessage[] {
	let compactionIndex = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			compactionIndex = i;
			break;
		}
	}
	if (compactionIndex < 0) {
		return branch.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
	}

	const compaction = branch[compactionIndex];
	const firstKeptIndex =
		compaction.type === "compaction" ? branch.findIndex((e) => e.id === compaction.firstKeptEntryId) : -1;
	const compacted = [
		compaction,
		...(firstKeptIndex >= 0 ? branch.slice(firstKeptIndex, compactionIndex) : []),
		...branch.slice(compactionIndex + 1),
	];
	return compacted.map(entryToMessage).filter((m): m is AgentMessage => m !== undefined);
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n…（截断，共 ${text.length} 字符）`;
}

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const out: string[] = [];
	for (const block of content as Array<Record<string, unknown>>) {
		if (block && block.type === "text" && typeof block.text === "string") out.push(block.text);
	}
	return out.join("\n");
}

function renderMessage(message: Message): string {
	const role = (message as { role: string }).role;
	if (role === "user") {
		return `[用户] ${contentText((message as { content: unknown }).content)}`;
	}
	if (role === "compactionSummary") {
		return `[上下文压缩摘要] ${(message as { summary?: string }).summary ?? ""}`;
	}
	if (role === "assistant") {
		const content = (message as { content?: Array<Record<string, unknown>> }).content ?? [];
		const texts = [contentText(content)];
		for (const block of content) {
			if (block && block.type === "toolCall") {
				const args = JSON.stringify(block.arguments ?? {});
				texts.push(`[调用] ${String(block.name)} ${clip(args, ARGS_CAP).replace(/\n/g, " ")}`);
			}
		}
		return `[助手] ${texts.filter(Boolean).join("\n")}`;
	}
	if (role === "toolResult") {
		const failed = (message as { isError?: boolean }).isError === true;
		if (!failed) return ""; // 成功的工具输出信息量低、体积大，直接丢弃（P1）
		return `[工具失败] ${contentText((message as { content: unknown }).content).slice(0, ERROR_CAP)}`;
	}
	return "";
}

/** 按字符预算挑选记录：首条用户消息 + 尽可能多的最近轮次（P1） */
function buildTranscript(messages: Message[], budget: number): string {
	const rendered = messages.map(renderMessage);
	const firstIdx = rendered.findIndex((r) => r.startsWith("[用户]"));
	const head = firstIdx >= 0 ? clip(rendered[firstIdx], FIRST_MESSAGE_CAP) : "";

	const kept: string[] = [];
	let used = head.length;
	for (let i = rendered.length - 1; i >= 0; i--) {
		if (i === firstIdx) continue;
		const block = rendered[i];
		if (!block) continue;
		if (used + block.length > budget) break;
		kept.unshift(block);
		used += block.length;
	}

	const dropped = rendered.filter((b, i) => b && i !== firstIdx).length - kept.length;
	const parts: string[] = [];
	if (head) parts.push(head);
	if (dropped > 0) parts.push(`…（中间省略 ${dropped} 条记录：超出预算或为成功工具输出）`);
	parts.push(...kept);
	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// 硬事实采集（P2）
// ---------------------------------------------------------------------------

interface ExecResult {
	stdout: string;
	code: number;
}

async function tryExec(pi: ExtensionAPI, cmd: string, args: string[], cwd: string): Promise<ExecResult | undefined> {
	try {
		const r = await pi.exec(cmd, args, { cwd, timeout: 8_000 });
		return { stdout: r.stdout ?? "", code: r.code ?? 1 };
	} catch {
		return undefined;
	}
}

function modelLabel(ctx: ExtensionContext): string {
	const model = ctx.model as unknown as { id?: string; provider?: string; name?: string } | undefined;
	if (!model) return "(未选择)";
	const id = model.id ?? model.name ?? "?";
	return model.provider ? `${model.provider}/${id}` : `${id}`;
}

interface SkillInfo {
	name: string;
	description?: string;
	/** 带 disable-model-invocation，只能通过 /skill:name 显式启用 */
	explicitOnly?: boolean;
}

/**
 * 取技能清单。命令上下文有 getSystemPromptOptions()（session_start 的 ctx 没有），优先用它；
 * 拿不到就退回解析系统提示里的 <available_skills> 块（那条路径只能看到模型可见的技能）。
 */
function availableSkills(ctx: ExtensionContext): SkillInfo[] {
	try {
		const opts = (ctx as unknown as { getSystemPromptOptions?: () => { skills?: unknown } }).getSystemPromptOptions?.();
		const list = opts?.skills;
		if (Array.isArray(list) && list.length > 0) {
			return list
				.map((s) => s as { name?: string; description?: string; disableModelInvocation?: boolean })
				.filter((s): s is { name: string; description?: string; disableModelInvocation?: boolean } =>
					typeof s?.name === "string" && s.name.length > 0,
				)
				.map((s) => ({
					name: s.name,
					description: typeof s.description === "string" ? s.description : undefined,
					explicitOnly: s.disableModelInvocation === true,
				}));
		}
	} catch {
		// 落到下面的兜底
	}
	try {
		const prompt = ctx.getSystemPrompt();
		const out: SkillInfo[] = [];
		const re = /<skill>\s*<name>([^<]+)<\/name>\s*<description>([\s\S]*?)<\/description>/g;
		let match: RegExpExecArray | null;
		while ((match = re.exec(prompt)) !== null) {
			out.push({ name: match[1].trim(), description: match[2].trim() });
		}
		return out;
	} catch {
		return [];
	}
}

/** 从工具调用里推断本次会话读过哪些 SKILL.md */
function skillsRead(messages: Message[]): string[] {
	const seen = new Set<string>();
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<Record<string, unknown>>) {
			if (!block || block.type !== "toolCall") continue;
			const args = block.arguments as Record<string, unknown> | undefined;
			if (!args) continue;
			for (const key of ["path", "file", "filePath"]) {
				const value = args[key];
				if (typeof value !== "string") continue;
				const match = /[/\\]skills[/\\]([^/\\]+)[/\\]SKILL\.md$/.exec(value);
				if (match) seen.add(match[1]);
			}
		}
	}
	return [...seen];
}

function touchedFiles(messages: Message[]): string[] {
	const seen = new Map<string, Set<string>>();
	for (const message of messages) {
		const content = (message as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<Record<string, unknown>>) {
			if (!block || block.type !== "toolCall") continue;
			const name = String(block.name ?? "");
			const args = block.arguments as Record<string, unknown> | undefined;
			if (!args) continue;
			for (const key of ["path", "file", "filePath"]) {
				const value = args[key];
				if (typeof value === "string" && value) {
					if (!seen.has(value)) seen.set(value, new Set());
					seen.get(value)?.add(name);
				}
			}
		}
	}
	return [...seen.entries()].map(([path, tools]) => `${path} (${[...tools].join("/")})`);
}

async function collectFacts(pi: ExtensionAPI, ctx: ExtensionContext, messages: Message[]): Promise<string> {
	const lines: string[] = [];
	lines.push(`- 工作目录：${ctx.cwd}`);
	lines.push(`- 模型：${modelLabel(ctx)}，思考级别：${ctx.thinkingLevel ?? "off"}`);
	lines.push(`- 工具：${pi.getActiveTools().join(", ") || "(无)"}`);
	const skills = availableSkills(ctx);
	const used = skillsRead(messages);
	lines.push(`- 本次会话读过的 Skill：${used.length > 0 ? used.join(", ") : "无"}`);
	lines.push(`- 可用的 Skill（新会话可直接 /skill:<名字> 或按 description 自动触发）：${skills.length > 0 ? "" : "（未取到）"}`);
	for (const skill of skills) {
		const suffix = skill.explicitOnly ? `（仅 /skill:${skill.name} 显式启用）` : "";
		const desc = skill.description ? `：${clip(skill.description, 60).replace(/\n/g, " ")}` : "";
		lines.push(`  - ${skill.name}${suffix}${desc}`);
	}
	const explicitOnlyMissing = used.filter((name) => !skills.some((s) => s.name === name));
	if (explicitOnlyMissing.length > 0) {
		lines.push(`  - 另有本次读过但不在清单里的 Skill：${explicitOnlyMissing.join(", ")}（可能仅显式启用）`);
	}
	lines.push(`- 父会话：${ctx.sessionManager.getSessionFile() ?? "(临时会话)"}`);

	const inside = await tryExec(pi, "git", ["rev-parse", "--is-inside-work-tree"], ctx.cwd);
	if (inside && inside.code === 0 && inside.stdout.trim() === "true") {
		const branch = await tryExec(pi, "git", ["branch", "--show-current"], ctx.cwd);
		const status = await tryExec(pi, "git", ["status", "--short"], ctx.cwd);
		const unstaged = await tryExec(pi, "git", ["diff", "--stat"], ctx.cwd);
		const staged = await tryExec(pi, "git", ["diff", "--cached", "--stat"], ctx.cwd);

		lines.push(`- Git 分支：${branch?.stdout.trim() || "(detached 或无分支)"}`);
		lines.push("- Git 状态（`git status --short`）：");
		lines.push("```");
		lines.push(status?.stdout.trim() ? clip(status.stdout.trim(), GIT_CAP) : "（工作树干净）");
		lines.push("```");
		if (unstaged?.stdout.trim()) {
			lines.push("- 未暂存改动（`git diff --stat`）：");
			lines.push("```");
			lines.push(clip(unstaged.stdout.trim(), GIT_CAP));
			lines.push("```");
		}
		if (staged?.stdout.trim()) {
			lines.push("- 已暂存改动（`git diff --cached --stat`）：");
			lines.push("```");
			lines.push(clip(staged.stdout.trim(), GIT_CAP));
			lines.push("```");
		}
	} else {
		lines.push("- Git：不是 git 仓库（或 git 不可用）");
	}

	const files = touchedFiles(messages);
	lines.push("- 本轮会话涉及的文件（从工具调用提取，不代表最终改动）：");
	if (files.length === 0) {
		lines.push("  - 无");
	} else {
		for (const file of files.slice(0, FILES_CAP)) lines.push(`  - ${file}`);
		if (files.length > FILES_CAP) lines.push(`  - …另有 ${files.length - FILES_CAP} 个`);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 生成与校验
// ---------------------------------------------------------------------------

function missingSections(text: string): string[] {
	return REQUIRED_SECTIONS.filter((heading) => !text.includes(heading));
}

function buildUserText(facts: string, transcript: string, goal: string): string {
	return [
		"## 硬事实（脚本采集，未经模型改写）",
		facts,
		"",
		"## 压缩后的对话记录",
		transcript,
		"",
		"## 用户给新会话的目标",
		goal,
	].join("\n");
}

async function generate(
	ctx: ExtensionContext,
	text: string,
	strict: boolean,
	signal: AbortSignal,
): Promise<string | null> {
	const systemPrompt = strict
		? `${SYSTEM_PROMPT}\n\n注意：上一次输出缺少必须的段落标题，这次必须逐字包含全部段落标题。`
		: SYSTEM_PROMPT;

	const response = await ctx.modelRegistry.complete(
		ctx.model!,
		{
			systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				},
			],
		},
		{ signal, cacheRetention: "none", sessionId: uuidv7() },
	);
	if (response.stopReason === "aborted") return null;
	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

// ---------------------------------------------------------------------------
// 落盘（P3）
// ---------------------------------------------------------------------------

function handoffPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "HANDOFF.md");
}

function writeHandoff(cwd: string, body: string): string {
	const path = handoffPath(cwd);
	fs.mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	fs.writeFileSync(path, body, "utf8");
	return path;
}

function composeDocument(facts: string, narrative: string, goal: string, parent: string | undefined): string {
	return [
		`# HANDOFF —— ${new Date().toISOString()}`,
		"",
		`<!-- 由 /handoff 生成。硬事实段为脚本采集；叙事段为模型生成。父会话：${parent ?? "(临时)"} -->`,
		"",
		"## 目标",
		goal,
		"",
		"## 硬事实",
		facts,
		"",
		"---",
		"",
		narrative,
		"",
	].join("\n");
}

/**
 * 新会话的起步 prompt（P11）：只说「读哪个文件」，不搬运正文。
 * 这样交接内容只存在于磁盘上，上下文里只有一句指路。
 */
function shortPrompt(path: string | undefined, parent: string | undefined, fallback: string): string {
	if (!path) return fallback; // 落盘失败时退回内联，否则新会话拿不到任何东西
	const lines = [
		`读 ${path}，按里面的「目标」和「下一步」接续工作。`,
		"现场以该文件的硬事实段和当前 git 状态为准；需要原始过程时看父会话" + ` ${parent ?? "(未记录)"}。`,
		"先复述现场，再动手。",
	];
	return lines.join("");
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("handoff", {
		description: "把当前会话交接成新会话（含硬事实、预算与落盘）",
		handler: async (args, ctx) => {
			if (!ctx.model) {
				ctx.ui.notify("没有可用模型，无法生成交接摘要", "error");
				return;
			}

			const goal = args.trim() || DEFAULT_GOAL;

			// 1. 收集材料
			const messages = getHandoffMessages(ctx.sessionManager.getBranch());
			if (messages.length === 0) {
				ctx.ui.notify("当前会话没有可交接的内容", "error");
				return;
			}
			const llmMessages = convertToLlm(messages) as Message[];
			const transcript = buildTranscript(llmMessages, BUDGET_CHARS);
			const facts = await collectFacts(pi, ctx, llmMessages);

			// 2. 预算预览（P1）
			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm(
					"发送给模型的内容",
					[
						`共 ${messages.length} 条记录，压缩后 ${transcript.length} 字符（预算 ${BUDGET_CHARS}）。`,
						`硬事实 ${facts.length} 字符，模型：${modelLabel(ctx)}。`,
						"",
						"继续生成交接摘要？",
					].join("\n"),
				);
				if (!ok) {
					ctx.ui.notify("已取消", "info");
					return;
				}
			}

			const userText = buildUserText(facts, transcript, goal);
			const parent = ctx.sessionManager.getSessionFile();

			// 3. 生成；失败走兜底（P5 / P4 重试）
			const run = async (signal: AbortSignal): Promise<string> => {
				let narrative: string | null = null;
				try {
					narrative = await generate(ctx, userText, false, signal);
				} catch (err) {
					ctx.ui.notify(`摘要生成失败：${err instanceof Error ? err.message : String(err)}`, "warning");
				}
				if (!narrative) return "";
				const missing = missingSections(narrative);
				if (missing.length === 0) return narrative;
				ctx.ui.notify(`摘要缺段落（${missing.join(" / ")}），重试一次`, "warning");
				try {
					const retry = await generate(ctx, userText, true, signal);
					if (retry) return retry;
				} catch {
					// 重试失败，保留第一次的结果
				}
				return narrative;
			};

			let narrative = "";
			if (ctx.mode === "tui") {
				const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
					const loader = new BorderedLoader(tui, theme, "生成交接摘要…");
					loader.onAbort = () => done(null);
					run(loader.signal)
						.then(done)
						.catch(() => done(null));
					return loader;
				});
				if (result === null) {
					ctx.ui.notify("已取消", "info");
					return;
				}
				narrative = result;
			} else {
				const controller = new AbortController();
				narrative = await run(controller.signal);
			}

			// 4. 兜底与补标（P5）
			if (!narrative) {
				narrative = [
					SECTION_FILES,
					"（摘要生成失败，见上方硬事实与 git 状态）",
					"",
					SECTION_CHANGES,
					"（摘要生成失败）",
					"",
					SECTION_VERIFY,
					"（摘要生成失败）",
					"",
					SECTION_RISK,
					"（摘要生成失败：本次交接只带硬事实，新会话需要自己重新确认状态）",
					"",
					SECTION_NEXT,
					goal,
				].join("\n");
			} else {
				const missing = missingSections(narrative);
				if (missing.length > 0) {
					narrative = `> ⚠ 以下段落缺失：${missing.join(" / ")}\n\n${narrative}`;
				}
			}

			// 5. 落盘（P3）
			const document = composeDocument(facts, narrative, goal, parent);
			let savedPath: string | undefined;
			try {
				savedPath = writeHandoff(ctx.cwd, document);
			} catch (err) {
				ctx.ui.notify(`写入 HANDOFF.md 失败：${err instanceof Error ? err.message : String(err)}`, "warning");
			}

			// 6. 新会话只拿一个指向文件的短 prompt（P11）
			const prompt = shortPrompt(savedPath, parent, document);

			// 非 TUI：只打印短 prompt + 落盘，不切会话（P8）
			if (ctx.mode !== "tui") {
				console.log(prompt);
				if (savedPath) ctx.ui.notify(`交接文档已写入 ${savedPath}`, "info");
				return;
			}

			// 7. 交给用户改，再开新会话
			const edited = await ctx.ui.editor(
				"编辑新会话的起步 prompt（正文在 HANDOFF.md 里，提交后进入新会话）",
				prompt,
			);
			if (edited === undefined) {
				ctx.ui.notify(`已取消，文档保留在 ${savedPath ?? handoffPath(ctx.cwd)}`, "info");
				return;
			}

			const result = await ctx.newSession({
				parentSession: parent,
				withSession: async (replacementCtx) => {
					replacementCtx.ui.setEditorText(edited);
					replacementCtx.ui.notify(
						savedPath ? `交接已就绪（${savedPath}）` : "交接已就绪",
						"info",
					);
				},
			});
			if (result.cancelled) {
				ctx.ui.notify(`新会话被取消，文档保留在 ${savedPath ?? handoffPath(ctx.cwd)}`, "warning");
			}
		},
	});
}
