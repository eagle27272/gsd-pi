import type { AgentMessage } from "@gsd/pi-agent-core";
import type { Message, TextContent } from "@gsd/pi-ai";
import { createHash } from "crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmdirSync,
	statSync,
} from "fs";
import { readdir, readFile, stat } from "fs/promises";
import { join } from "path";

import { getAgentDir as getDefaultAgentDir } from "../config.js";
import { normalizePath, resolvePath } from "../utils/paths.js";
import {
	type FileEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	type SessionMessageEntry,
} from "./session-manager-types.js";

/**
 * Flatten a cwd into a filename-safe, human-readable fragment.
 *
 * Lossy on purpose: separators collapse to hyphens, so `/a/foo-bar` and
 * `/a/foo/bar` produce the same fragment. Callers must disambiguate.
 */
function readableCwdFragment(resolvedCwd: string): string {
	return resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");
}

/** Directory name used before session dirs carried a cwd hash. */
function legacySessionDirName(resolvedCwd: string): string {
	return `--${readableCwdFragment(resolvedCwd)}--`;
}

function sessionDirName(resolvedCwd: string): string {
	const digest = createHash("sha256").update(resolvedCwd).digest("hex").slice(0, 8);
	return `${legacySessionDirName(resolvedCwd)}${digest}`;
}

export function getDefaultSessionDir(cwd: string, agentDir: string = getDefaultAgentDir()): string {
	const resolvedCwd = resolvePath(cwd);
	const resolvedAgentDir = resolvePath(agentDir);
	const sessionsRoot = join(resolvedAgentDir, "sessions");
	const sessionDir = join(sessionsRoot, sessionDirName(resolvedCwd));
	if (!existsSync(sessionDir)) {
		mkdirSync(sessionDir, { recursive: true });
		adoptLegacySessionDir(join(sessionsRoot, legacySessionDirName(resolvedCwd)), sessionDir, resolvedCwd);
	}
	return sessionDir;
}

/**
 * Move sessions belonging to `resolvedCwd` out of the pre-hash directory.
 *
 * The pre-hash naming scheme could map several project directories onto one
 * name, so a file is claimed only when the cwd recorded in its header says it
 * belongs here. Files whose header is missing or unreadable were never listable
 * to begin with and are left where they are.
 */
function adoptLegacySessionDir(legacyDir: string, sessionDir: string, resolvedCwd: string): void {
	if (legacyDir === sessionDir || !existsSync(legacyDir)) return;

	try {
		for (const file of readdirSync(legacyDir)) {
			if (!file.endsWith(".jsonl")) continue;
			const header = readSessionHeader(join(legacyDir, file));
			if (typeof header?.cwd !== "string" || resolvePath(header.cwd) !== resolvedCwd) continue;
			renameSync(join(legacyDir, file), join(sessionDir, file));
		}
		if (readdirSync(legacyDir).length === 0) {
			rmdirSync(legacyDir);
		}
	} catch {
		// Leave the legacy directory untouched; the new directory is still usable.
	}
}

export function loadEntriesFromFile(filePath: string): FileEntry[] {
	const resolvedFilePath = normalizePath(filePath);
	if (!existsSync(resolvedFilePath)) return [];

	const content = readFileSync(resolvedFilePath, "utf8");
	const entries: FileEntry[] = [];
	const lines = content.trim().split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as FileEntry;
			entries.push(entry);
		} catch {
			// Skip malformed lines
		}
	}

	if (entries.length === 0) return entries;
	const header = entries[0];
	if (header.type !== "session" || typeof (header as SessionHeader).id !== "string") {
		return [];
	}

	return entries;
}

const HEADER_CHUNK_BYTES = 4096;
const MAX_HEADER_BYTES = 1024 * 1024;

/** Read the first line of a file without loading the whole thing. */
function readFirstLine(filePath: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const chunk = Buffer.alloc(HEADER_CHUNK_BYTES);
		let read = Buffer.alloc(0);
		while (read.length < MAX_HEADER_BYTES) {
			const bytesRead = readSync(fd, chunk, 0, HEADER_CHUNK_BYTES, read.length);
			if (bytesRead === 0) break;
			read = Buffer.concat([read, chunk.subarray(0, bytesRead)]);
			const newlineIndex = read.indexOf(0x0a);
			if (newlineIndex !== -1) return read.toString("utf8", 0, newlineIndex);
		}
		return read.length > 0 ? read.toString("utf8") : null;
	} catch {
		return null;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function readSessionHeader(filePath: string): SessionHeader | null {
	const firstLine = readFirstLine(filePath);
	if (!firstLine) return null;
	try {
		const header = JSON.parse(firstLine) as SessionHeader;
		return header.type === "session" && typeof header.id === "string" ? header : null;
	} catch {
		return null;
	}
}

function isValidSessionFile(filePath: string): boolean {
	return readSessionHeader(filePath) !== null;
}

export function findMostRecentSession(sessionDir: string): string | null {
	const resolvedSessionDir = normalizePath(sessionDir);
	try {
		const files = readdirSync(resolvedSessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(resolvedSessionDir, f))
			.filter(isValidSessionFile)
			.map((path) => ({ path, mtime: statSync(path).mtime }))
			.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());

		return files[0]?.path || null;
	} catch {
		return null;
	}
}

function isMessageWithContent(message: AgentMessage): message is Message {
	return typeof (message as Message).role === "string" && "content" in message;
}

function extractTextContent(message: Message): string {
	const content = message.content;
	if (typeof content === "string") {
		return content;
	}
	return content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join(" ");
}

function getLastActivityTime(entries: FileEntry[]): number | undefined {
	let lastActivityTime: number | undefined;

	for (const entry of entries) {
		if (entry.type !== "message") continue;

		const message = (entry as SessionMessageEntry).message;
		if (!isMessageWithContent(message)) continue;
		if (message.role !== "user" && message.role !== "assistant") continue;

		const msgTimestamp = (message as { timestamp?: number }).timestamp;
		if (typeof msgTimestamp === "number") {
			lastActivityTime = Math.max(lastActivityTime ?? 0, msgTimestamp);
			continue;
		}

		const entryTimestamp = (entry as SessionEntryBase).timestamp;
		if (typeof entryTimestamp === "string") {
			const t = new Date(entryTimestamp).getTime();
			if (!Number.isNaN(t)) {
				lastActivityTime = Math.max(lastActivityTime ?? 0, t);
			}
		}
	}

	return lastActivityTime;
}

function getSessionModifiedDate(entries: FileEntry[], header: SessionHeader, statsMtime: Date): Date {
	const lastActivityTime = getLastActivityTime(entries);
	if (typeof lastActivityTime === "number" && lastActivityTime > 0) {
		return new Date(lastActivityTime);
	}

	const headerTime = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
	return !Number.isNaN(headerTime) ? new Date(headerTime) : statsMtime;
}

async function buildSessionInfo(filePath: string): Promise<SessionInfo | null> {
	try {
		const content = await readFile(filePath, "utf8");
		const entries: FileEntry[] = [];
		const lines = content.trim().split("\n");

		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				entries.push(JSON.parse(line) as FileEntry);
			} catch {
				// Skip malformed lines
			}
		}

		if (entries.length === 0) return null;
		const header = entries[0];
		if (header.type !== "session" || typeof header.id !== "string") return null;

		const stats = await stat(filePath);
		let messageCount = 0;
		let firstMessage = "";
		const allMessages: string[] = [];
		let name: string | undefined;

		for (const entry of entries) {
			if (entry.type === "session_info") {
				const infoEntry = entry as SessionInfoEntry;
				name = infoEntry.name?.trim() || undefined;
			}

			if (entry.type !== "message") continue;
			messageCount++;

			const message = (entry as SessionMessageEntry).message;
			if (!isMessageWithContent(message)) continue;
			if (message.role !== "user" && message.role !== "assistant") continue;

			const textContent = extractTextContent(message);
			if (!textContent) continue;

			allMessages.push(textContent);
			if (!firstMessage && message.role === "user") {
				firstMessage = textContent;
			}
		}

		const cwd = typeof header.cwd === "string" ? header.cwd : "";
		const parentSessionPath = header.parentSession;
		const modified = getSessionModifiedDate(entries, header, stats.mtime);

		return {
			path: filePath,
			id: header.id,
			cwd,
			name,
			parentSessionPath,
			created: new Date(header.timestamp),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return null;
	}
}

export type SessionListProgress = (loaded: number, total: number) => void;

const MAX_CONCURRENT_SESSION_INFO_LOADS = 10;

export async function buildSessionInfosWithConcurrency(
	files: string[],
	onLoaded: () => void,
): Promise<(SessionInfo | null)[]> {
	const results: (SessionInfo | null)[] = new Array(files.length).fill(null);
	const inFlight = new Set<Promise<void>>();
	let nextIndex = 0;

	const startNext = (): void => {
		const index = nextIndex++;
		const file = files[index];
		if (!file) return;

		let task: Promise<void>;
		task = buildSessionInfo(file)
			.then((info) => {
				results[index] = info;
			})
			.catch(() => {
				results[index] = null;
			})
			.finally(() => {
				inFlight.delete(task);
				onLoaded();
			});
		inFlight.add(task);
	};

	while (nextIndex < files.length || inFlight.size > 0) {
		while (nextIndex < files.length && inFlight.size < MAX_CONCURRENT_SESSION_INFO_LOADS) {
			startNext();
		}
		if (inFlight.size > 0) {
			await Promise.race(inFlight);
		}
	}

	return results;
}

export async function listSessionsFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	progressOffset = 0,
	progressTotal?: number,
): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];
	if (!existsSync(dir)) {
		return sessions;
	}

	try {
		const dirEntries = await readdir(dir);
		const files = dirEntries.filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f));
		const total = progressTotal ?? files.length;

		let loaded = 0;
		const results = await buildSessionInfosWithConcurrency(files, () => {
			loaded++;
			onProgress?.(progressOffset + loaded, total);
		});
		for (const info of results) {
			if (info) {
				sessions.push(info);
			}
		}
	} catch {
		// Return empty list on error
	}

	return sessions;
}
