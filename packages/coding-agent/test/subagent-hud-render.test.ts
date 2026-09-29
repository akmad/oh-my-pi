/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists exactly running detached subagents with a semantic role
 * icon, useful description or task, the resolved model (behind
 * task.showResolvedModelBadge), and live metrics. Sync
 * task and eval-agent spawns render progress inline instead.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resetHangulCompatibilityJamoWidthForTests, setHangulCompatibilityJamoWidth } from "@oh-my-pi/pi-tui";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-tui/prompt/composer";
import {
	InteractiveMode,
	layoutPinnedHud,
	renderSubagentHudLines,
	SubagentHudComponent,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { type ObservableSession, SessionObserverRegistry } from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import {
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgTaskShowResolvedModelBadge } from "@oh-my-pi/pi-coding-agent/task/settings";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

function render(sessions: ObservableSession[], columns = 120, nowMs = Date.now(), expanded = true): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns, expanded, nowMs).join("\n"));
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	describe("model badges", () => {
		// The fork keeps its row layout (role icon, description, then model, metrics
		// right-aligned) and places the badge after the description. The badge follows
		// upstream's task.showResolvedModelBadge setting and upstream's feed-badge format.
		const nowMs = Date.parse("2026-08-25T12:00:00Z");

		beforeEach(async () => {
			resetSettingsForTest();
			await Settings.init({ inMemory: true, overrides: { "task.showResolvedModelBadge": true } });
		});

		afterEach(() => {
			resetSettingsForTest();
		});

		it("places thinking, model and optional advisor after the description", () => {
			const session = makeSession({
				id: "BadgeWorker",
				agent: "scout",
				description: "Inspect rendering",
				lastUpdate: nowMs,
				progress: makeProgress({
					id: "BadgeWorker",
					resolvedModel: "openai/gpt-5:high",
					resolvedModelIdentity: "openai/gpt-5",
					resolvedThinkingLevel: ThinkingLevel.High,
					advisor: true,
				}),
			});
			const out = render([session], 120, nowMs);
			const badge = `${theme.thinking.high.split(" ")[0]} openai/gpt-5 ${theme.icon.advisor}`;
			expect(out).toContain(badge);
			expect(out).toContain(theme.symbol("icon.search"));
			expect(out.indexOf("Inspect rendering")).toBeLessThan(out.indexOf(badge));
			expect(out).not.toContain("BadgeWorker");
			expect(out).not.toContain("scout");

			session.progress = makeProgress({
				id: "BadgeWorker",
				resolvedModel: "openai/gpt-5:high",
				resolvedModelIdentity: "openai/gpt-5",
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: false,
			});
			const withoutAdvisor = render([session], 120, nowMs);
			expect(withoutAdvisor).toContain("openai/gpt-5");
			expect(withoutAdvisor).not.toContain(theme.icon.advisor);
		});

		it("keeps metadata hidden when disabled or settings have not initialized", () => {
			const sessions = [
				makeSession({
					id: "HiddenBadge",
					description: "Inspect rendering",
					lastUpdate: nowMs,
					progress: makeProgress({
						id: "HiddenBadge",
						resolvedModel: "openai/gpt-5:high",
						resolvedModelIdentity: "openai/gpt-5",
						resolvedThinkingLevel: ThinkingLevel.High,
						advisor: true,
					}),
				}),
			];
			cfgTaskShowResolvedModelBadge.override(Settings.instance, false);
			const disabled = render(sessions, 120, nowMs);
			expect(disabled).toContain("Inspect rendering");
			expect(disabled).not.toContain("openai/gpt-5");
			expect(disabled).not.toContain(theme.icon.advisor);

			resetSettingsForTest();
			expect(render(sessions, 120, nowMs)).toBe(disabled);
		});

		it("preserves model identity while fitting descriptions and task previews", () => {
			const metadata = {
				resolvedModel: `provider/${"shared-prefix-".repeat(8)}variant-z:high`,
				resolvedModelIdentity: `provider/${"shared-prefix-".repeat(8)}variant-z`,
				resolvedThinkingLevel: ThinkingLevel.High,
				advisor: true,
			};
			const sessions = [
				makeSession({
					id: "Description",
					description: "Inspect description ".repeat(20),
					lastUpdate: nowMs,
					progress: makeProgress({ id: "Description", ...metadata }),
				}),
				makeSession({
					id: "TaskPreview",
					lastUpdate: nowMs,
					progress: makeProgress({ id: "TaskPreview", task: "Inspect preview ".repeat(20), ...metadata }),
				}),
			];
			// Narrow: the description keeps its floor and the badge still fits beside it.
			const narrow = render(sessions, 60, nowMs).split("\n");
			for (const text of ["Inspect des", "Inspect pre"]) {
				const row = narrow.find(line => line.includes(text));
				expect(row).toBeDefined();
				if (!row) continue;
				expect(row).toContain(theme.icon.advisor);
				expect(row).toContain(`${theme.sep.dot}${theme.thinking.high.split(" ")[0]} prov`);
				expect(row.indexOf(text)).toBeLessThan(row.indexOf(" prov"));
				expect(row).not.toContain(":high");
			}
			for (const line of narrow) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60 - 2);
			}
			// Wide: the model identity's distinguishing suffix survives middle truncation.
			const wide = render(sessions, 120, nowMs).split("\n");
			for (const text of ["Inspect desc", "Inspect prev"]) {
				const row = wide.find(line => line.includes(text));
				expect(row).toBeDefined();
				if (!row) continue;
				expect(row).toContain(`variant-z ${theme.icon.advisor}`);
				expect(row.indexOf(text)).toBeLessThan(row.indexOf("variant-z"));
				expect(row).not.toContain(":high");
			}
			for (const line of wide) {
				expect(Bun.stringWidth(line)).toBeLessThanOrEqual(120 - 2);
			}
		});

		it("reserves custom tree prefixes, outer indent and role icons before optional details", () => {
			const priorTree = Object.getOwnPropertyDescriptor(theme, "tree");
			try {
				Object.defineProperty(theme, "tree", {
					configurable: true,
					value: { ...theme.tree, branch: "界├", last: "界界└", vertical: "界界│" },
				});
				const sessions = [
					makeSession({
						id: `LongWorker${"界".repeat(30)}`,
						agent: `custom-role-${"extended-".repeat(10)}`,
						description: "Long column ".repeat(10),
						lastUpdate: nowMs,
						progress: makeProgress({ id: "LongWorker", resolvedModelIdentity: "provider/model", advisor: true }),
					}),
					makeSession({
						id: "ShortWorker",
						agent: "scout",
						description: "Short column ".repeat(10),
						lastUpdate: nowMs,
					}),
				];
				for (const enabled of [true, false]) {
					cfgTaskShowResolvedModelBadge.override(Settings.instance, enabled);
					for (const width of [40, 120, 40]) {
						const rows = render(sessions, width, nowMs).split("\n");
						const longRow = rows.find(row => row.includes("Long"));
						const shortRow = rows.find(row => row.includes("Short"));
						expect(longRow).toStartWith(" 界├ ");
						expect(shortRow).toStartWith(" 界界└ ");
						for (const row of rows) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(width - 2);
						expect(longRow).toContain(theme.symbol("icon.agents"));
						expect(shortRow).toContain(theme.symbol("icon.search"));
						expect(longRow).not.toContain("LongWorker");
						expect(shortRow).not.toContain("scout");
					}
				}
			} finally {
				if (priorTree) Object.defineProperty(theme, "tree", priorTree);
				else Reflect.deleteProperty(theme, "tree");
			}
		});

		it("preserves a legacy selector without inventing a thinking glyph", () => {
			const out = render(
				[
					makeSession({
						id: "LegacyWorker",
						description: "Legacy selector",
						lastUpdate: nowMs,
						progress: makeProgress({ id: "LegacyWorker", resolvedModel: "custom/model:high" }),
					}),
				],
				120,
				nowMs,
			);
			expect(out).toContain(`Legacy selector${theme.sep.dot}custom/model:high`);
			expect(out).not.toContain(theme.thinking.high.split(" ")[0]);
		});
	});

	it("renders detached subagents with descriptions under a Subagents header", () => {
		const out = render([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(out).toContain("Subagents");
		expect(out).toContain("Refactoring the auth flow");
		expect(out).toContain("Migrating the users table");
		expect(out).not.toContain("AuthLoader");
		expect(out).not.toContain("SchemaMigrator");
	});

	it("sanitizes terminal controls before rendering descriptions", () => {
		const raw = renderSubagentHudLines(
			[
				makeSession({
					id: "Unsafe",
					description: "Inspect \x1b]8;;https://evil.invalid\x07linked\x1b]8;;\x07 \x07alert",
				}),
			],
			120,
		).join("\n");
		expect(Bun.stripANSI(raw)).toContain("Inspect linked alert");
		expect(raw).not.toContain("evil.invalid");
		expect(raw).not.toContain("\x07");
	});

	it("pins model, uncached token, and elapsed metrics after the description", async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true, overrides: { "task.showResolvedModelBadge": true } });
		const nowMs = Date.parse("2026-08-25T12:00:00Z");
		const columns = 120;
		const out = render(
			[
				makeSession({
					id: "Compiler",
					agent: "sonic",
					description: "Build the release binary",
					lastUpdate: nowMs,
					progress: makeProgress({
						id: "Compiler",
						agent: "sonic",
						resolvedModel: "openai-codex/gpt-5.6-sol:high",
						inputTokens: 12_300,
						outputTokens: 742,
						durationMs: 65_000,
					}),
				}),
			],
			columns,
			nowMs + 5_000,
		);
		const row = out.split("\n").find(line => line.includes("Build the release binary"));
		expect(row).toBeDefined();
		if (!row) return;
		expect(row).not.toContain("Compiler");
		expect(row).toContain(theme.symbol("icon.fast"));
		expect(row).toContain("gpt-5.6-sol");
		expect(row).toContain("12K tot");
		expect(row).toContain("742 out");
		expect(row).toContain("1m10s");
		expect(row.indexOf("Build the release binary")).toBeLessThan(row.indexOf("gpt-5.6-sol"));
		expect(row.indexOf("gpt-5.6-sol")).toBeLessThan(row.indexOf("12K tot"));
		expect(row.indexOf("742 out")).toBeLessThan(row.indexOf("1m10s"));
		expect(Bun.stringWidth(row)).toBe(columns - 2);
	});

	it("uses semantic role icons and omits internal ids when descriptions are useful", () => {
		const withRole = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "Refactor the auth flow",
			}),
		]);
		expect(withRole).toContain("Refactor the auth flow");
		expect(withRole).toContain(theme.symbol("icon.search"));
		expect(withRole).not.toContain("AuthLoader");
		expect(withRole).not.toContain("scout");

		const echoed = render([
			makeSession({
				id: "AuthLoader",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(echoed).toContain(theme.symbol("icon.search"));
		expect(echoed).toContain("AuthLoader");
		expect(echoed).not.toContain("scout");

		const collision = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "AuthLoader",
			}),
		]);
		expect(collision).toContain(theme.symbol("icon.search"));
		expect(collision).toContain("AuthLoader-3");

		const mixedCase = render([
			makeSession({
				id: "AuthLoader-3",
				agent: "scout",
				description: "authloader",
			}),
		]);
		expect(mixedCase).toContain(theme.symbol("icon.search"));
		expect(mixedCase).toContain("AuthLoader-3");

		const defaultWorker = render([
			makeSession({ id: "SchemaMigrator", agent: "task", description: "Migrate users" }),
		]);
		expect(defaultWorker).toContain("Migrate users");
		expect(defaultWorker).not.toContain("SchemaMigrator");
		expect(defaultWorker).not.toMatch(/(?:^| )task(?: |$)/);
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(out).toContain("live work");
		expect(out).not.toContain("StillRunning");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("falls back to the description and task carried by progress snapshots", () => {
		const fromProgressDesc = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expect(fromProgressDesc).toContain("From progress");
		expect(fromProgressDesc).not.toContain("Worker");

		const fromTask = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		expect(fromTask).toContain("Investigate flaky CI on macOS");
		expect(fromTask).not.toContain("Worker");

		const multiLineTask = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				progress: makeProgress({
					id: "ReviewShell",
					agent: "scout",
					task: "Complete assignment thoroughly:\n\n# Target\nFiles: src/foo.ts",
				}),
			}),
		]);
		expect(multiLineTask).toContain(theme.symbol("icon.search"));
		expect(multiLineTask).toContain("Complete assignment thoroughly: ↵ # Tar");
		expect(multiLineTask).not.toContain("ReviewShell");
		expect(multiLineTask).not.toContain("\n# Target");

		const multiLineDesc = render([
			makeSession({
				id: "ReviewShell",
				agent: "scout",
				description: "First line\n\nSecond line",
			}),
		]);
		expect(multiLineDesc).toContain("First line ↵ Second line");
		expect(multiLineDesc).not.toContain("ReviewShell");
		expect(multiLineDesc).not.toContain("\nSecond line");
	});
	it("hides sync task calls and eval agent spawns", () => {
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
		];
		expect(renderSubagentHudLines(sessions, 120)).toEqual([]);
		const out = render([...sessions, makeSession({ id: "BackgroundSpawn", description: "detached work" })]);
		expect(out).toContain("detached work");
		expect(out).not.toContain("BackgroundSpawn");
		expect(out).not.toContain("SyncSpawn");
		expect(out).not.toContain("EvalSpawn");
	});
	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = render(registry.getSessions());
		expect(out).toContain("background work");
		expect(out).not.toContain("Detached");
		expect(out).not.toContain("FromProgress");
		expect(out).not.toContain("Inline");
	});

	it("truncates long descriptions without leaking internal ids", () => {
		const out = render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60);
		expect(out).toContain("start");
		expect(out).not.toContain("Anna>Bob");
		expect(out).not.toContain("end");
		for (const line of out.split("\n")) {
			expect(Bun.stringWidth(line)).toBeLessThanOrEqual(60);
		}
	});

	it("dedupes frames dual-published on the session bus and the shared bus", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const kinds: string[] = [];
		registry.onChange(kind => kinds.push(kind));
		const payload = makeLifecycle("DualPublished", 0, "dual-published frame");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
		expect(kinds).toEqual(["lifecycle"]);
		expect(registry.getActiveSubagentCount()).toBe(1);
		registry.dispose();
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus, eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("collapses to three rows and expands all rows", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const collapsed = render(active, 120, Date.now(), false);
		for (let index = 0; index < 3; index++) expect(collapsed).toContain(`job ${index}`);
		for (let index = 3; index < 10; index++) expect(collapsed).not.toContain(`job ${index}`);
		expect(collapsed).toContain("7 more — expand");

		const expanded = render(active, 120, Date.now(), true);
		for (let index = 0; index < 10; index++) {
			expect(expanded).toContain(`job ${index}`);
			expect(expanded).not.toContain(`Worker${index}`);
		}
		expect(expanded).toContain("show less");
	});
});

describe("SubagentHudComponent click rows", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("maps item rows to session ids and chrome rows nowhere", () => {
		const lines = renderSubagentHudLines([makeSession({ id: "Alpha" }), makeSession({ id: "Beta" })], 120, true);
		const hud = new SubagentHudComponent(lines, ["Alpha", "Beta"]);

		const rendered = hud.render(120);
		expect(rendered).toHaveLength(lines.length);

		expect(hud.getClickAgentAtRow(0)).toBeUndefined();
		expect(hud.getClickAgentAtRow(1)).toBeUndefined();
		expect(hud.getClickAgentAtRow(2)).toBe("Alpha");
		expect(hud.getClickAgentAtRow(3)).toBe("Beta");
		expect(hud.getClickAgentAtRow(4)).toBeUndefined();
		expect(hud.getClickAgentAtRow(-1)).toBeUndefined();
	});

	it("resolves the expander row to the toggle sentinel", () => {
		const hud = new SubagentHudComponent(["", "Subagents", "row", "toggle"], ["Only"], 3);
		hud.render(120);
		expect(hud.getClickAgentAtRow(3)).toBe(PINNED_HUD_TOGGLE_ID);
		expect(hud.getClickAgentAtRow(2)).toBe("Only");
	});

	it("maps wrapped continuation rows to the agent that started them", () => {
		const long = ` ${"x".repeat(200)}`;
		const hud = new SubagentHudComponent(["", "Subagents", long, "short"], ["Long", "Short"]);
		const rendered = hud.render(40);
		expect(rendered.length).toBeGreaterThan(4);
		const shortRow = rendered.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(shortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(2)).toBe("Long");
		expect(hud.getClickAgentAtRow(3)).toBe("Long");
		expect(hud.getClickAgentAtRow(shortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(shortRow + 1)).toBeUndefined();
	});

	it("maps clicks after wrapping and resizing while leaving clicks before rendering unmapped", () => {
		const hud = new SubagentHudComponent(["", "Subagents", ` ${"x".repeat(100)}`, "short"], ["Long", "Short"]);
		expect(hud.getClickAgentAtRow(2)).toBeUndefined();

		const narrowRows = hud.render(40);
		const narrowShortRow = narrowRows.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(narrowShortRow).toBeGreaterThan(3);
		expect(hud.getClickAgentAtRow(narrowShortRow - 1)).toBe("Long");
		expect(hud.getClickAgentAtRow(narrowShortRow)).toBe("Short");

		const wideRows = hud.render(120);
		expect(wideRows.length).toBeLessThan(narrowRows.length);
		const wideShortRow = wideRows.findIndex(line => Bun.stripANSI(line).includes("short"));
		expect(hud.getClickAgentAtRow(wideShortRow)).toBe("Short");
		expect(hud.getClickAgentAtRow(wideShortRow + 1)).toBeUndefined();
	});

	it("remaps clicks when runtime character width changes", () => {
		setHangulCompatibilityJamoWidth(1);
		try {
			const hud = new SubagentHudComponent(["", "Subagents", ` ${"ㅁ".repeat(25)}`, "next"], ["Jamo", "Next"]);
			const narrowRows = hud.render(40);
			const narrowNextRow = narrowRows.findIndex(line => Bun.stripANSI(line).includes("next"));
			expect(hud.getClickAgentAtRow(narrowNextRow)).toBe("Next");

			setHangulCompatibilityJamoWidth(2);
			expect(hud.getClickAgentAtRow(narrowNextRow)).toBe("Next");
			const wideRows = hud.render(40);
			const wideNextRow = wideRows.findIndex(line => Bun.stripANSI(line).includes("next"));
			expect(wideNextRow).toBeGreaterThan(narrowNextRow);
			expect(hud.getClickAgentAtRow(wideNextRow - 1)).toBe("Jamo");
			expect(hud.getClickAgentAtRow(wideNextRow)).toBe("Next");
		} finally {
			resetHangulCompatibilityJamoWidthForTests();
		}
	});
});

describe("layoutPinnedHud", () => {
	it("fits small lists without an expander", () => {
		expect(layoutPinnedHud(0, false)).toEqual({ itemRows: 0, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, false)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
		expect(layoutPinnedHud(3, true)).toEqual({ itemRows: 3, toggle: undefined, toggleRow: undefined });
	});

	it("collapses longer lists behind an expander", () => {
		expect(layoutPinnedHud(4, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
		expect(layoutPinnedHud(10, false)).toEqual({ itemRows: 3, toggle: "expand", toggleRow: 5 });
	});

	it("expands to every row with a collapse row", () => {
		expect(layoutPinnedHud(5, true)).toEqual({ itemRows: 5, toggle: "collapse", toggleRow: 7 });
		expect(layoutPinnedHud(10, true)).toEqual({ itemRows: 10, toggle: "collapse", toggleRow: 12 });
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const rebuildHud = vi.spyOn(mode.subagentContainer, "clear");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();

		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("Burst job 0");
		expect(hud).toContain("3 more — expand");
		expect(hud).not.toContain("BurstAgent");
		expect(rebuildHud).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("refreshes elapsed time while a detached subagent remains active", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		vi.useFakeTimers();
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("LongRunner", 0, "Wait for work", true));
		await Promise.resolve();
		vi.advanceTimersByTime(100);
		await Promise.resolve();
		expect(Bun.stripANSI(mode.subagentContainer.render(120).join("\n"))).toContain("100ms");

		vi.advanceTimersByTime(1000);
		await Promise.resolve();
		const hud = Bun.stripANSI(mode.subagentContainer.render(120).join("\n"));
		expect(hud).toContain("1.1s");
		expect(requestRender).toHaveBeenCalledTimes(2);
	});
});
