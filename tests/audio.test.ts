import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import * as audio from "../audio.ts";
import * as display from "../cache-display.ts";
import * as cache from "../cache-timer.ts";

// A fresh module isolates player-detection state without exposing a production reset API.
function freshAudio(test: string): Promise<typeof audio> {
	return import(new URL(`../audio.ts?test=${test}`, import.meta.url).href);
}

function platform(t: TestContext, value: NodeJS.Platform): void {
	const original = Object.getOwnPropertyDescriptor(process, "platform")!;
	Object.defineProperty(process, "platform", { ...original, value });
	t.after(() => Object.defineProperty(process, "platform", original));
}

function processStub() {
	return Object.assign(new EventEmitter(), { unref() {} });
}

describe("cache module boundaries", () => {
	it("preserves standalone cache-timer exports as the same implementations", () => {
		for (const name of Object.keys(display) as (keyof typeof display)[]) {
			assert.equal(cache[name], display[name], name);
		}
		for (const name of Object.keys(audio) as (keyof typeof audio)[]) {
			assert.equal(cache[name], audio[name], name);
		}
		assert.equal(audio.resolveSoundPath("3.mp3"), path.resolve("sounds/3.mp3"));
		assert.equal(audio.resolveSoundPath("missing-test-sound.mp3"), null);
	});
});

describe("local audio playback", () => {
	it("retries missing players and caches a later successful detection", async (t) => {
		platform(t, "linux");
		let available = false;
		const probe = t.mock.method(childProcess, "spawnSync", () => ({ status: available ? 0 : 1 }));
		const player = await freshAudio("detection");
		assert.equal(player.detectAudioPlayer(), null);
		assert.equal(player.detectAudioPlayer(), null);
		assert.equal(probe.mock.callCount(), 4);
		available = true;
		assert.deepEqual(player.detectAudioPlayer(), { cmd: "mpv", type: "mpv" });
		assert.deepEqual(player.detectAudioPlayer(), { cmd: "mpv", type: "mpv" });
		assert.equal(probe.mock.callCount(), 5);
	});

	it("plays mpv repeats in one detached, silent process and tolerates errors", async (t) => {
		platform(t, "linux");
		t.mock.method(fs, "existsSync", () => true);
		t.mock.method(childProcess, "spawnSync", () => ({ status: 0 }));
		const proc = processStub();
		const unref = t.mock.method(proc, "unref");
		const spawn = t.mock.method(childProcess, "spawn", () => proc);
		const player = await freshAudio("mpv");
		player.playAudio("/test/sound.mp3", 2.9);
		assert.deepEqual(spawn.mock.calls[0].arguments, ["mpv",
			["--no-config", "--no-video", "--really-quiet", "/test/sound.mp3", "/test/sound.mp3"],
			{ stdio: "ignore", detached: true },
		]);
		assert.equal(unref.mock.callCount(), 1);
		assert.doesNotThrow(() => proc.emit("error", new Error("simulated player error")));
		spawn.mock.mockImplementation(() => { throw new Error("simulated spawn error"); });
		assert.doesNotThrow(() => player.playAudio("/test/sound.mp3"));
	});

	it("uses ffplay looping when mpv is unavailable", async (t) => {
		platform(t, "linux");
		t.mock.method(fs, "existsSync", () => true);
		t.mock.method(childProcess, "spawnSync", (_cmd: string, args: string[]) => ({ status: args[0] === "ffplay" ? 0 : 1 }));
		const spawn = t.mock.method(childProcess, "spawn", () => processStub());
		const player = await freshAudio("ffplay");
		player.playAudio("/test/sound.mp3", 2);
		assert.deepEqual(spawn.mock.calls[0].arguments.slice(0, 2), ["ffplay",
			["-nodisp", "-autoexit", "-loglevel", "quiet", "-loop", "2", "/test/sound.mp3"],
		]);
	});

	it("chains afplay repeats sequentially without probing another player", async (t) => {
		platform(t, "darwin");
		t.mock.method(fs, "existsSync", () => true);
		const probe = t.mock.method(childProcess, "spawnSync", () => { throw new Error("must not probe"); });
		const processes: ReturnType<typeof processStub>[] = [];
		const spawn = t.mock.method(childProcess, "spawn", () => {
			const proc = processStub();
			processes.push(proc);
			return proc;
		});
		const player = await freshAudio("afplay");
		player.playAudio("/test/sound.mp3", 2);
		assert.equal(spawn.mock.callCount(), 1);
		processes[0].emit("exit", 0);
		assert.equal(spawn.mock.callCount(), 2);
		processes[1].emit("exit", 0);
		assert.equal(spawn.mock.callCount(), 2);
		assert.equal(probe.mock.callCount(), 0);
	});

	it("does not spawn for absent or unreadable files", async (t) => {
		const spawn = t.mock.method(childProcess, "spawn", () => { throw new Error("must not spawn"); });
		const exists = t.mock.method(fs, "existsSync", () => false);
		audio.playAudio("");
		audio.playAudio("/test/missing.mp3");
		exists.mock.mockImplementation(() => { throw new Error("simulated filesystem error"); });
		assert.doesNotThrow(() => audio.playAudio("/test/unreadable.mp3"));
		assert.equal(spawn.mock.callCount(), 0);
	});
});
