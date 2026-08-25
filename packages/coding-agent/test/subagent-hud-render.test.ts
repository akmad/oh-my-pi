/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists exactly the running *detached* subagents as bounded rows
 * with a semantic role icon, useful description/task, resolved model, and
 * right-aligned live metrics. It yields no output once nothing qualifies, so
 * the block self-clears. Sync task spawns and eval `agent()` spawns are
 * excluded: their progress is already rendered inline (tool block / eval cell).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	InteractiveMode,
	layoutPinnedHud,
	renderSubagentHudLines,
	SubagentHudComponent,
} from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { PINNED_HUD_TOGGLE_ID } from "@oh-my-pi/pi-coding-agent/modes/composer";
import {
	type ObservableSession,
	SessionObserverRegistry,
} from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

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

// `expanded` sits third in the renderer and `nowMs` fourth: expansion is structural and
// every real caller passes it, while the clock exists only so a test need not sleep. This
// helper keeps the fork's original argument order for its own callers and defaults to the
// expanded list, because most cases here are about what a ROW contains rather than how
// many rows survive collapsing. A case that means to exercise collapsing passes false.
function render(sessions: ObservableSession[], columns = 120, nowMs = Date.now(), expanded = true): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, columns, expanded, nowMs).join("\n"));
}

describe("subagent HUD lines", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("renders running subagents with useful descriptions under a Subagents header", () => {
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

	it("strips terminal control sequences from descriptions", () => {
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

	it("keeps description/model before right-aligned uncached token and duration metrics", () => {
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
		expect(row).toContain(theme.icon.fast);
		expect(row.indexOf(theme.icon.fast)).toBeLessThan(row.indexOf("Build the release binary"));
		expect(row).toContain("gpt-5.6-sol");
		expect(row).toContain("12K tot");
		expect(row).toContain("742 out");
		expect(row).toContain("1m10s");
		expect(row.indexOf("Build the release binary")).toBeLessThan(row.indexOf("gpt-5.6-sol"));
		expect(row.indexOf("gpt-5.6-sol")).toBeLessThan(row.indexOf("12K tot"));
		expect(row.indexOf("742 out")).toBeLessThan(row.indexOf("1m10s"));
		expect(row.trimEnd().endsWith("1m10s")).toBe(true);
		// Two columns short of the terminal width, not flush with it: SubagentHudComponent
		// mounts these rows in a Text that reserves one column of padding each side. A row
		// padded to the full 120 is two columns too wide for the box it lands in and wraps,
		// turning every HUD entry into two rows. This assertion used to say `columns` and
		// was the reason that went unnoticed.
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
	it("hides non-detached spawns: sync task calls and eval agent() helpers", () => {
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) both stay off the HUD.
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

	it("truncates long descriptions to the viewport without leaking internal ids", () => {
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

	// Overflow is upstream's expand/collapse, not the fork's original fixed cap of eight
	// with an "open Agent Hub" line. The cap was this feature's own answer to a long list
	// before upstream had one; upstream's is wired to the display.pinnedAgents setting, a
	// toggle command and the click map, so keeping the cap would have orphaned all three.
	// What did NOT change is what a row contains, or which agents are eligible to be one.
	it("collapses to three rows with an expander, and shows every row when expanded", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({
				id: `Worker${index}`,
				description: `job ${index}`,
			}),
		);

		const collapsed = render(active, 120, Date.now(), false);
		for (let index = 0; index < 3; index++) {
			expect(collapsed).toContain(`job ${index}`);
		}
		for (let index = 3; index < 10; index++) {
			expect(collapsed).not.toContain(`job ${index}`);
		}
		expect(collapsed).toContain("7 more — expand");

		const expanded = render(active, 120, Date.now(), true);
		for (let index = 0; index < 10; index++) {
			expect(expanded).toContain(`job ${index}`);
			// Still the fork's row: the description carries the row, never the internal id.
			expect(expanded).not.toContain(`Worker${index}`);
		}
		expect(expanded).toContain("show less");
	});
});

// The two blocks below test machinery this fork KEPT from upstream — the click hit map
// and the collapse layout — so they came back verbatim when the rest of upstream's HUD
// suite was replaced. They are design-neutral: nothing here asserts what a row contains,
// only which agent a clicked row belongs to and how many rows survive collapsing. The
// fixtures work unchanged because makeSession already spawns detached, which is the only
// kind this HUD lists.
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
		// Six spawns, collapsed to three plus an expander — the count is what the display
		// setting dictates, and this case is about the six bursts producing ONE rebuild,
		// not about how many survive collapsing.
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
