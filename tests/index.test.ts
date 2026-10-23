import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverAndLoadExtensions, UserMessageComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension from "../index.ts";

describe("extension startup compatibility", () => {
	it("loads through Pi's public loader without replacing registered tool execution", async () => {
		const agentDir = await mkdtemp(path.join(tmpdir(), "arda-pi-ui-loader-"));
		try {
			const result = await discoverAndLoadExtensions([path.resolve("index.ts")], process.cwd(), agentDir);
			assert.deepEqual(result.errors, []);
			assert.equal(result.extensions.length, 1);
			const loaded = result.extensions[0];
			assert.equal(loaded.toolRenderers?.length, 1);
			assert.equal(loaded.tools.size, 0);
			assert.ok(loaded.commands.has("arda-tools"));
			assert.ok(!loaded.commands.has("cc-tools"));
			assert.ok(loaded.handlers.has("agent_settled"));
			assert.ok(loaded.handlers.has("session_shutdown"));
		} finally {
			await rm(agentDir, { recursive: true, force: true });
		}
	});

	it("logs a failed user message patch without crashing or changing the original renderer", () => {
		const proto = UserMessageComponent.prototype;
		const descriptor = Object.getOwnPropertyDescriptor(proto, "render")!;
		const render = (_width: number) => ["", "default message", ""];
		const failures: string[] = [];
		const originalError = console.error;
		try {
			Object.defineProperty(proto, "render", { ...descriptor, value: render, writable: false });
			console.error = (message: string) => failures.push(message);
			assert.doesNotThrow(() => extension({
				on() {},
				registerCommand() {},
				registerToolRenderer() {},
			} as unknown as ExtensionAPI));
			assert.equal(proto.render, render);
			assert.deepEqual(proto.render(80), ["", "default message", ""]);
			assert.ok(failures.includes("[arda-pi-ui] User message patch disabled; keeping Pi's default rendering."));
		} finally {
			Object.defineProperty(proto, "render", descriptor);
			console.error = originalError;
		}
	});

	it("isolates Pi API registration failures to the affected features", () => {
		const failures: string[] = [];
		const originalError = console.error;
		console.error = (message: string) => failures.push(message);

		try {
			assert.doesNotThrow(() =>
				extension({
					on() {
						throw new Error("simulated host API mismatch");
					},
					registerCommand() {
						throw new Error("simulated host API mismatch");
					},
				} as unknown as ExtensionAPI),
			);
		} finally {
			console.error = originalError;
		}

		assert.deepEqual(failures, [
			"[arda-pi-ui] Prompt editor disabled during Pi API setup.",
			"[arda-pi-ui] Spinner disabled during Pi API setup.",
			"[arda-pi-ui] Git status disabled during Pi API setup.",
			"[arda-pi-ui] Cache timer disabled during Pi API setup.",
			"[arda-pi-ui] Footer disabled during Pi API setup.",
			"[arda-pi-ui] Tool renderers disabled during Pi API setup.",
		]);
	});
});
