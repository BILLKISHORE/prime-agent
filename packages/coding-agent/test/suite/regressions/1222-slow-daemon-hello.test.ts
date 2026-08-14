import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeDaemonVersion } from "../../../src/cli/daemon-launch.js";
import { VERSION } from "../../../src/config.js";
import { DAEMON_PROTOCOL_VERSION, DAEMON_SCHEMA_ID } from "../../../src/modes/daemon/daemon-protocol.js";

interface FakePeer {
	socketPath: string;
	close: () => Promise<void>;
}

/**
 * A peer that accepts the connection and greets after `helloDelayMs`, or never
 * greets when `helloDelayMs` is undefined. Modelling the delay is the point: the
 * reported daemon was healthy and merely slow under a saturated event loop.
 */
async function startSlowPeer(options: { helloDelayMs?: number } = {}): Promise<FakePeer> {
	const dir = mkdtempSync(join(tmpdir(), "pa-1222-"));
	const socketPath = join(dir, "d.sock");
	const timers: NodeJS.Timeout[] = [];
	const sockets = new Set<Socket>();
	const server: Server = createServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => undefined);
		socket.on("close", () => sockets.delete(socket));
		if (options.helloDelayMs === undefined) {
			return;
		}
		timers.push(
			setTimeout(() => {
				if (socket.destroyed) return;
				socket.write(
					`${JSON.stringify({
						type: "daemon_hello",
						socketPath,
						protocol: { name: "prime-agent.daemon", version: DAEMON_PROTOCOL_VERSION },
						appVersion: VERSION,
						schemaId: DAEMON_SCHEMA_ID,
						clientId: "slow-peer",
						serverCapabilities: [],
					})}\n`,
				);
			}, options.helloDelayMs),
		);
	});
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	return {
		socketPath,
		close: () =>
			new Promise<void>((resolve) => {
				for (const timer of timers) clearTimeout(timer);
				for (const socket of sockets) socket.destroy();
				server.close(() => resolve());
				rmSync(dir, { recursive: true, force: true });
			}),
	};
}

describe("issue #1222 a busy daemon that is slow to greet is not treated as stale", () => {
	const peers: FakePeer[] = [];

	afterEach(async () => {
		while (peers.length > 0) {
			await peers.pop()?.close();
		}
	});

	async function peer(options: { helloDelayMs?: number } = {}): Promise<FakePeer> {
		const started = await startSlowPeer(options);
		peers.push(started);
		return started;
	}

	// The defect: one handshake attempt, so a daemon that greets late is reported
	// stale. The client then tries to replace a healthy daemon, is refused, and
	// hangs on the loading screen with the reason only in client-errors.log.
	it("reports a daemon that greets after the first attempt as current", async () => {
		const slow = await peer({ helloDelayMs: 180 });
		expect(await probeDaemonVersion(slow.socketPath, [80, 1000])).toMatchObject({ status: "current" });
	});

	// The retry is bounded, so a peer holding the socket open without ever
	// greeting is still resolved as stale rather than hanging the probe.
	it("still reports a peer that never greets as stale", async () => {
		const silent = await peer();
		expect(await probeDaemonVersion(silent.socketPath, [60, 60])).toEqual({ status: "stale" });
	});

	// A greeting inside the first attempt must not pay for the retry.
	it("reports a prompt daemon as current without spending the second attempt", async () => {
		const prompt = await peer({ helloDelayMs: 5 });
		const startedAt = Date.now();
		expect(await probeDaemonVersion(prompt.socketPath, [1000, 5000])).toMatchObject({ status: "current" });
		expect(Date.now() - startedAt).toBeLessThan(1000);
	});

	// Nothing is listening, so this never reaches the handshake at all.
	it("reports an unused socket path as absent", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pa-1222-absent-"));
		try {
			expect(await probeDaemonVersion(join(dir, "missing.sock"), [60, 60])).toEqual({ status: "absent" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
