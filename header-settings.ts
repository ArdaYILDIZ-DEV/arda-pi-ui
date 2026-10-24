import { readFileSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const HEADER_COLORS = ["a", "c", "r", "o", "y", "g", "w", "b", "p", "theme"] as const;
const HEADER_SPEEDS = [25, 50, 75, 100] as const;
export type HeaderColor = typeof HEADER_COLORS[number];

/** Persisted names deliberately match ccHeader; this module never writes settings. */
export interface HeaderConfig {
	readonly color: HeaderColor;
	/** Color neither (0), Pi only (1), or Pi and version (2); never hides the version. */
	readonly ver: 0 | 1 | 2;
	readonly grad: boolean;
	readonly lines: boolean;
	/** Show package-provided skills separately from local skills. */
	readonly pkg: boolean;
	readonly speed: typeof HEADER_SPEEDS[number];
	readonly slogan: string;
	readonly sloganOn: boolean;
	readonly sloganColor: boolean;
	readonly disabled: boolean;
}

export const DEFAULT_HEADER_CONFIG: Readonly<HeaderConfig> = Object.freeze({
	color: "c", ver: 1, grad: true, lines: true, pkg: false, speed: 50,
	slogan: "Code something that makes you proud", sloganOn: true, sloganColor: true, disabled: false,
});

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parseHeaderConfig(value: unknown, onInvalid?: (key: string) => void): HeaderConfig {
	if (!isRecord(value)) {
		if (value !== undefined) onInvalid?.("ccHeader");
		return { ...DEFAULT_HEADER_CONFIG };
	}
	const record = value;
	function field<T>(key: keyof HeaderConfig, guard: (candidate: unknown) => candidate is T, fallback: T): T {
		const candidate = record[key];
		if (candidate === undefined) return fallback;
		if (guard(candidate)) return candidate;
		onInvalid?.(key);
		return fallback;
	}
	const boolean = (candidate: unknown): candidate is boolean => typeof candidate === "boolean";
	return {
		color: field("color", (v): v is HeaderColor => typeof v === "string" && HEADER_COLORS.some((color) => color === v), DEFAULT_HEADER_CONFIG.color),
		ver: field("ver", (v): v is HeaderConfig["ver"] => v === 0 || v === 1 || v === 2, DEFAULT_HEADER_CONFIG.ver),
		grad: field("grad", boolean, DEFAULT_HEADER_CONFIG.grad),
		lines: field("lines", boolean, DEFAULT_HEADER_CONFIG.lines),
		pkg: field("pkg", boolean, DEFAULT_HEADER_CONFIG.pkg),
		speed: field("speed", (v): v is HeaderConfig["speed"] => HEADER_SPEEDS.some((speed) => speed === v), DEFAULT_HEADER_CONFIG.speed),
		slogan: field("slogan", (v): v is string => typeof v === "string" && v.length <= 85, DEFAULT_HEADER_CONFIG.slogan),
		sloganOn: field("sloganOn", boolean, DEFAULT_HEADER_CONFIG.sloganOn),
		sloganColor: field("sloganColor", boolean, DEFAULT_HEADER_CONFIG.sloganColor),
		disabled: field("disabled", boolean, DEFAULT_HEADER_CONFIG.disabled),
	};
}

export interface HeaderSettings {
	readonly config: HeaderConfig;
	/** Configured global packages, not a guess based on leftover node_modules directories. */
	readonly packages: number;
	readonly issues: readonly string[];
}

export function readHeaderSettings(file = path.join(getAgentDir(), "settings.json")): HeaderSettings {
	const issues: string[] = [];
	let settings: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (isRecord(parsed)) settings = parsed;
		else issues.push("Settings must contain an object; using header defaults.");
	} catch (error) {
		if (!(isRecord(error) && error.code === "ENOENT")) {
			issues.push("Cannot read settings; using header defaults. The file was not changed.");
		}
	}
	return {
		config: parseHeaderConfig(settings.ccHeader, (key) => issues.push(`Invalid ${key === "ccHeader" ? key : `ccHeader.${key}`}; using its default.`)),
		packages: Array.isArray(settings.packages) ? settings.packages.filter((item: unknown) =>
			typeof item === "string" || (isRecord(item) && typeof item.source === "string")).length : 0,
		issues,
	};
}
