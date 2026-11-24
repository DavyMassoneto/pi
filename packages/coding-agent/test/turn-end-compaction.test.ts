import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const apiKey = process.env.PI_TEST_COMPACTION_API_KEY;
const baseUrl = process.env.PI_TEST_COMPACTION_BASE_URL;
const modelId = process.env.PI_TEST_COMPACTION_MODEL;

it.skipIf(!apiKey || !baseUrl || !modelId).each(["toolUse", "stop"] as const)(
	"compacts natively at a %s boundary without aborting or adding a turn",
	async (stopReason) => {
		if (!apiKey || !baseUrl || !modelId) throw new Error("Missing live compaction test configuration");
		const cwd = mkdtempSync(join(tmpdir(), "pi-turn-end-compaction-"));
		let session: AgentSession | undefined;
		try {
			const modelRuntime = await ModelRuntime.create({
				credentials: AuthStorage.inMemory(),
				modelsPath: null,
				allowModelNetwork: false,
			});
			modelRuntime.registerProvider("compaction-test", {
				api: "openai-completions",
				apiKey,
				baseUrl,
				models: [
					{
						id: modelId,
						name: modelId,
						input: ["text"],
						reasoning: false,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 128000,
						maxTokens: 4096,
					},
				],
			});
			const model = modelRuntime.getModel("compaction-test", modelId);
			if (!model) throw new Error("Live model not registered");
			const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 1 } });
			const lifecycle: string[] = [];
			let requestCompaction = false;
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir: cwd,
				settingsManager,
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "double",
							label: "Double",
							description: "Double an integer",
							parameters: Type.Object({ value: Type.Integer() }),
							execute: async (_id, { value }) => ({
								content: [{ type: "text", text: String(value * 2) }],
								details: {},
							}),
						});
						pi.on("turn_end", (event) => {
							if (
								!requestCompaction ||
								event.message.role !== "assistant" ||
								event.message.stopReason !== stopReason
							)
								return;
							requestCompaction = false;
							lifecycle.push("request");
							return {
								compact: true,
								entries: [{ type: "custom", customType: "before-compaction", data: true }],
							};
						});
						pi.on("session_before_compact", (event) => {
							if (
								event.branchEntries.some(
									(entry) => entry.type === "custom" && entry.customType === "before-compaction",
								)
							) {
								lifecycle.push("session_before_compact");
							}
						});
						pi.on("session_compact", (event) => {
							if (!event.fromExtension && event.compactionEntry.summary.trim())
								lifecycle.push("session_compact");
						});
					},
				],
			});
			await resourceLoader.reload();
			({ session } = await createAgentSession({
				cwd,
				agentDir: cwd,
				model,
				modelRuntime,
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
				tools: ["double"],
			}));
			await session.prompt("Remember that my project is called Cedar. Reply only OK; do not call tools.");
			session.subscribe((event) => {
				if (event.type === "compaction_start" || event.type === "compaction_end") lifecycle.push(event.type);
				if (event.type === "agent_settled") lifecycle.push(event.aborted ? "aborted" : "settled");
				if (event.type === "turn_end" && event.message.role === "assistant")
					lifecycle.push(event.message.stopReason);
			});
			requestCompaction = true;
			await session.prompt(
				stopReason === "toolUse"
					? "Call the double tool exactly once with value 21. Then reply with just the tool result."
					: "Reply with just 42; do not call tools.",
			);

			expect(lifecycle).toEqual([
				"request",
				"compaction_start",
				"session_before_compact",
				"session_compact",
				"compaction_end",
				...(stopReason === "toolUse" ? ["toolUse"] : []),
				"stop",
				"settled",
			]);
			expect(session.getLastAssistantText()).toContain("42");
		} finally {
			session?.dispose();
			rmSync(cwd, { recursive: true, force: true });
		}
	},
);
