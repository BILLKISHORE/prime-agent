import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { ActiveSessionState } from "../../../src/modes/daemon/active-session-state.js";
import { activeActivityForSession } from "../../../src/modes/daemon/daemon-session-list.js";

interface StateOptions {
	messages?: AgentMessage[];
	busy?: boolean;
	kind?: "top-level" | "subagent";
	summaryState?: ActiveSessionState["summaryState"];
}

function makeState(options: StateOptions = {}): ActiveSessionState {
	const messages = options.messages ?? ([] as AgentMessage[]);
	return {
		activeSessionId: "active",
		clients: new Set(),
		lastEventSequence: 0,
		summaryState: options.summaryState,
		runtime: {
			metadata: { kind: options.kind ?? "top-level", createdAt: 1 },
			diagnostics: [],
			session: {
				messages,
				isSessionActive: options.busy === true,
				hasRunningRlmChildren: () => false,
			},
		},
	} as unknown as ActiveSessionState;
}

const oneMessage = [{ role: "user", content: "hi" }] as unknown as AgentMessage[];

describe("issue #1201 a session that never sent a message does not report working forever", () => {
	// The summarizer returns early on an empty session, so summaryState is never
	// written and isSummaryCurrent stays false. Without an explicit exit the
	// "hold until the idle verdict lands" rule below pins these at "working" for
	// the life of the daemon: the reported rows sat there for over an hour with
	// 0 messages and 0 clients, and automation waiting for the fleet to go idle
	// waits forever.
	it("reports an idle session with no messages as idle", () => {
		expect(activeActivityForSession(makeState())).toBe("idle");
	});

	// A turn can start before the first message is appended, so busy still wins.
	it("still reports a busy session with no messages as working", () => {
		expect(activeActivityForSession(makeState({ busy: true }))).toBe("working");
	});

	// The hold itself is intentional for sessions the summarizer will label, and
	// must survive: a session with content and no current verdict is not idle yet.
	it("keeps holding a session with messages and no current verdict at working", () => {
		expect(activeActivityForSession(makeState({ messages: oneMessage }))).toBe("working");
	});

	it("reports a session with messages and a current verdict as idle", () => {
		const summaryState = { basedOnMessageCount: 1 } as ActiveSessionState["summaryState"];
		expect(activeActivityForSession(makeState({ messages: oneMessage, summaryState }))).toBe("idle");
	});
});
