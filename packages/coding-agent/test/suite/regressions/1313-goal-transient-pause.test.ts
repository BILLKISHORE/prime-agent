import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.js";

function providerFailure(kind: string, status: number, errorMessage: string): AssistantMessage {
	return {
		...fauxAssistantMessage("", { stopReason: "error", errorMessage }),
		diagnostics: [
			{
				type: "provider_stream_failure",
				timestamp: Date.now(),
				details: { kind, status },
			},
		],
	};
}

const overloaded = () => providerFailure("overloaded", 529, "server_is_overloaded");
const authFailure = () => providerFailure("auth", 401, "401 Unauthorized: invalid API key");

describe("issue #1313 a transient provider failure pauses a goal instead of ending it", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	async function runGoalToTerminalFailure(message: () => AssistantMessage) {
		const harness = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 } },
			initialGoal: { objective: "keep working" },
		});
		harnesses.push(harness);
		// Exhaust the retry budget, then one more to terminate the turn.
		harness.setResponses([message(), message(), message(), message()]);
		await harness.session.prompt("go");
		return harness.session.goalState;
	}

	// "error" is not resumable: the resume gate admits only "paused" and "budget_limited",
	// so ending a goal there after a run of overloads strands autonomy until a human
	// creates a new goal. The reported incident sat in needs_input for 8h48m.
	it("leaves an overload-exhausted goal resumable", async () => {
		const goal = await runGoalToTerminalFailure(overloaded);
		expect(goal.status).toBe("paused");
		expect(goal.active).toBe(false);
		expect(goal.lastError).toContain("overloaded");
	});

	// A permanent failure must still end the goal; retrying an invalid credential forever
	// is the failure mode this guard exists to avoid.
	it("still ends a goal on a permanent auth failure", async () => {
		const goal = await runGoalToTerminalFailure(authFailure);
		expect(goal.status).toBe("error");
		expect(goal.active).toBe(false);
	});
});
