/** Provider usage is evidence of a past request, never a query of a live cache. */
export const DEFAULT_UNKNOWN_CACHE_TTL_MS = 300_000;
const fallbackLifetime = { ttlMs: DEFAULT_UNKNOWN_CACHE_TTL_MS, ttlSource: "fallback" as const };
export interface CacheModel {
	readonly provider: string;
	readonly id: string;
	readonly api?: string;
	readonly promptCache?: { readonly short?: number; readonly long?: number };
}

export interface CacheUsage {
	readonly input: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly cacheWrite1h?: number;
}

export interface CacheMessage {
	readonly role: string;
	readonly provider?: string;
	readonly model?: string;
	readonly api?: string;
	readonly responseModel?: string;
	readonly timestamp?: number;
	readonly stopReason?: string;
	readonly usage?: CacheUsage;
}

export interface CacheEntry {
	readonly type: string;
	readonly timestamp?: string;
	readonly message?: CacheMessage;
	readonly kind?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly usage?: CacheUsage;
}

export interface PromptCacheObservation {
	/** Percentage of the latest real request's input read from cache, not a hit probability. */
	readonly readPercent?: number;
	readonly usage?: CacheUsage;
	readonly timestamp?: number;
	readonly ttlMs?: number;
	readonly ttlSource?: "request" | "catalog" | "fallback";
	readonly warmUsage?: CacheUsage;
	readonly source: "request" | "history" | "warm" | "unknown";
	readonly reason: string;
}

function positive(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function cacheReadPercent(usage: CacheUsage | undefined): number | undefined {
	if (!usage || ![usage.input, usage.cacheRead, usage.cacheWrite].every(
		(value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
	)) return undefined;
	const total = usage.input + usage.cacheRead + usage.cacheWrite;
	return positive(total) ? usage.cacheRead / total * 100 : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown> : undefined;
}

/** Inspect only cache fields/structural containers, never retain prompts or change payloads. */
export function requestCacheLifetime(model: CacheModel, payload: unknown): Pick<PromptCacheObservation, "ttlMs" | "ttlSource"> {
	const root = object(payload);
	if (!root) return {};
	const options = object(root.prompt_cache_options);
	if (options?.mode === "explicit" && options.ttl === undefined) return {};
	const duration = (value: unknown): number | undefined => {
		if (value === "5m") return 300_000;
		if (value === "30m") return 1_800_000;
		if (value === "1h") return 3_600_000;
		if (value === "24h") return 86_400_000;
		return undefined;
	};
	// These are requested lifetimes, not server expiry timestamps.
	// OpenAI "24h" is a retention ceiling, not a 24-hour refreshed lease.
	if (root.prompt_cache_retention === "24h") {
		const seconds = model.promptCache?.long;
		return positive(seconds) && positive(seconds * 1000) ? { ttlMs: seconds * 1000, ttlSource: "catalog" } : {};
	}
	const requested = duration(options?.ttl ?? root.prompt_cache_retention);
	if (requested) return { ttlMs: requested, ttlSource: "request" };
	if (options?.ttl !== undefined || (root.prompt_cache_retention !== undefined && root.prompt_cache_retention !== "in-memory" && root.prompt_cache_retention !== "in_memory")) return {};

	const lifetimes: number[] = [];
	const queue: unknown[] = [root];
	const visited = new Set<object>();
	let incomplete = false;
	for (let index = 0; index < queue.length; index++) {
		if (index >= 10_000) { incomplete = true; break; }
		const value = queue[index];
		if (value === null || typeof value !== "object" || visited.has(value)) continue;
		visited.add(value);
		if (Array.isArray(value)) {
			if (queue.length + value.length > 10_000) { incomplete = true; break; }
			queue.push(...value);
			continue;
		}
		const node = object(value)!;
		for (const field of ["cache_control", "cachePoint"]) {
			const marker = object(node[field]);
			if (!marker) continue;
			const ttl = marker.ttl === undefined ? 300_000 : duration(marker.ttl);
			if (!ttl) incomplete = true;
			else lifetimes.push(ttl);
		}
		// Text, JSON tool inputs and schemas are not cache directives.
		for (const field of ["system", "messages", "tools", "content"]) {
			if (node[field] !== undefined) {
				if (queue.length >= 10_000) { incomplete = true; break; }
				queue.push(node[field]);
			}
		}
	}
	if (incomplete) return {};
	// Mixed TTLs are not one cache lease: display the earliest window only.
	if (lifetimes.length) return { ttlMs: Math.min(...lifetimes), ttlSource: "request" };
	// Explicit APIs without cache markers have not requested a cache lifetime.
	if (model.api === "anthropic-messages" || model.api === "bedrock-converse-stream") return {};
	// Automatic caches: only use the active host catalog's conservative short lifetime.
	// Do not infer long retention from an environment preference absent from the payload.
	const seconds = model.promptCache?.short;
	return positive(seconds) && positive(seconds * 1000) ? { ttlMs: seconds * 1000, ttlSource: "catalog" } : {};
}

function matches(model: CacheModel, message: { provider?: string; model?: string; api?: string }): boolean {
	return model.provider === message.provider && model.id === message.model &&
		(!message.api || !model.api || message.api === model.api);
}

function usable(message: CacheMessage): boolean {
	return message.stopReason !== "error" && message.stopReason !== "aborted" &&
		message.stopReason !== "pending" && message.stopReason !== "deferred";
}

/** Bounded, process-local request metadata. Session history remains the source of usage. */
export class PromptCacheTracker {
	private pending?: { model: CacheModel; timestamp: number; lifetime: ReturnType<typeof requestCacheLifetime> };
	private completed?: { message: CacheMessage; observation: PromptCacheObservation };

	reset(): void { this.pending = undefined; this.completed = undefined; }
	settled(): void { this.pending = undefined; }

	request(model: CacheModel | undefined, payload: unknown, now = Date.now()): void {
		this.pending = model ? { model, timestamp: now, lifetime: requestCacheLifetime(model, payload) } : undefined;
	}

	message(message: CacheMessage): void {
		if (message.role !== "assistant") return;
		const pending = this.pending;
		this.pending = undefined;
		this.completed = undefined;
		if (!pending || !matches(pending.model, message) || !usable(message)) return;
		const lifetime = message.responseModel && message.responseModel !== pending.model.id ? {} : pending.lifetime;
		this.completed = { message, observation: this.fromMessage(message, pending.timestamp, "request", lifetime) };
	}

	private fromMessage(message: CacheMessage, timestamp: number | undefined, source: PromptCacheObservation["source"], lifetime: ReturnType<typeof requestCacheLifetime> = {}): PromptCacheObservation {
		const readPercent = usable(message) ? cacheReadPercent(message.usage) : undefined;
		const evidence = readPercent !== undefined && (message.usage!.cacheRead > 0 || message.usage!.cacheWrite > 0);
		return {
			readPercent, usage: readPercent === undefined ? undefined : message.usage,
			timestamp: evidence && positive(timestamp) && timestamp <= Date.now() ? timestamp : undefined,
			...(evidence ? (lifetime.ttlMs ? lifetime : fallbackLifetime) : {}), source,
			reason: readPercent === undefined ? "Son isteğin cache kullanımı bilinmiyor veya istek başarısız."
				: evidence ? `Cache read/write raporlandı; bir sonraki hit garanti değil.${lifetime.ttlMs ? "" : " Ömür bilinmiyor: 5dk varsayılan hatırlatma penceresi."}`
					: "Pi son istekte cache read/write raporlamadı; bu tek başına cache'in kapalı olduğunu kanıtlamaz.",
		};
	}

	observe(model: CacheModel | undefined, entries?: readonly CacheEntry[]): PromptCacheObservation {
		const unknown: PromptCacheObservation = { source: "unknown", reason: "Bu model için doğrulanmış cache kullanımı yok." };
		if (!model) return unknown;
		if (!entries) return this.completed && matches(model, this.completed.message) ? this.completed.observation : unknown;
		let warm: CacheEntry | undefined;
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (entry.type === "compaction") return unknown;
			if (!warm && entry.type === "usage" && entry.kind === "cache_warm" && matches(model, entry) && cacheReadPercent(entry.usage) !== undefined && (entry.usage!.cacheRead > 0 || entry.usage!.cacheWrite > 0)) warm = entry;
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			const message = entry.message;
			if (!matches(model, message)) return unknown;
			const live = this.completed;
			let result = live && live.message === message ? live.observation
				: this.fromMessage(message, message.timestamp, "history");
			if (warm) {
				const timestamp = Date.parse(warm.timestamp ?? "");
				// Warm entries record completion, not request start or retention. Show age only.
				if (positive(timestamp) && timestamp <= Date.now() && timestamp > (result.timestamp ?? 0)) result = {
					...result, timestamp, ...fallbackLifetime, source: "warm", warmUsage: warm.usage,
					reason: "Pi cache_warm read/write raporladı; başlangıç zamanı ve TTL kaydedilmedi. Yaş yaklaşık; ömür için 5dk varsayılan pencere.",
				};
			}
			return result;
		}
		return unknown;
	}
}
