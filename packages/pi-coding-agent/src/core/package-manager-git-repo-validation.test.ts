import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultPackageManager } from "./package-manager.ts";
import { SettingsManager } from "./settings-manager.ts";

function createPackageManager(t: import("node:test").TestContext): {
	packageManager: DefaultPackageManager;
	agentDir: string;
} {
	const tempDir = mkdtempSync(join(tmpdir(), "pm-git-repo-validation-"));
	t.after(() => rmSync(tempDir, { recursive: true, force: true }));
	const agentDir = join(tempDir, ".gsd", "agent");
	return {
		packageManager: new DefaultPackageManager({
			cwd: join(tempDir, "project"),
			agentDir,
			settingsManager: SettingsManager.inMemory(),
		}),
		agentDir,
	};
}

for (const [label, source] of [
	["a space", "git:example.com/owner/re po"],
	["a carriage return", "git:example.com/owner/re\rpo"],
	["a newline", "git:example.com/owner/re\npo"],
] as const) {
	test(`install rejects a git repository containing ${label}`, async (t) => {
		const { packageManager } = createPackageManager(t);

		await assert.rejects(packageManager.install(source), /git repository/u);
	});
}

test("install rejects an unsafe git repository before creating its install directory", async (t) => {
	const { packageManager, agentDir } = createPackageManager(t);

	await assert.rejects(packageManager.install("git:example.com/owner/re po"), /git repository/u);
	assert.equal(existsSync(join(agentDir, "git")), false);
});
