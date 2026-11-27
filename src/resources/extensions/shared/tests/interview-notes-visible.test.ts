import { describe, it, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@gsd/pi-coding-agent";
import { showInterviewRound, type Question } from "../interview-ui.js";

const ENTER = "\r";
const DOWN = "\x1b[B";
const TAB = "\t";

before(() => { initTheme(); });

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const theme = new Proxy({} as Record<string, unknown>, {
	get: (_t, prop) => (prop === "fg" ? (_c: string, t: string) => t : (t: string) => t),
});

function openWidget(questions: Question[]) {
	let widget: any;
	const ctx = {
		ui: {
			custom: (factory: any) => {
				widget = factory({ requestRender: () => {}, terminal: { rows: 30, columns: 120 } }, theme, {}, () => {});
				return new Promise(() => {});
			},
		},
	};
	void showInterviewRound(questions, {}, ctx as any);
	return widget;
}

function lastOptionIndex(count: number): string[] {
	return Array.from({ length: count }, () => DOWN);
}

const questions: Question[] = [
	{
		id: "scope",
		header: "M008 scope",
		question: "What should this become? All seven milestones are done. The backlog has several deferred items waiting for a decision.",
		options: [
			{ label: "SilverLake contact edits", description: "Phase 2 of ESE-2994. Add a ContactUpdater so its internal PUTs stop returning 501.", preview: "# Contact edits\n\nDetails" },
			{ label: "GRAPH search", description: "ESE-2931 search for GRAPH. ESE-3089 is the research spike. Note that R019 puts search out of scope." },
			{ label: "Outbound resilience", description: "R015 circuit breaker plus the per-provider tripperware stack, and R016 retries for idempotent GETs." },
			{ label: "More entity fields (R017)", description: "Tax info, identifications, employment, and foreign customer data. Eight sensitive fields need a decision." },
		],
	},
];

describe("interview-ui side-by-side layout keeps the notes editor visible", () => {
	const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");

	afterEach(() => {
		if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
		else delete (process.stdout as { rows?: number }).rows;
	});

	it("shows the Notes label and editor after selecting the custom-answer slot on a short terminal", () => {
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		const widget = openWidget(questions);

		for (const key of lastOptionIndex(questions[0].options.length)) widget.handleInput(key);
		widget.handleInput(ENTER);
		widget.invalidate();

		const rendered = widget.render(120).map(stripAnsi);
		const notesRow = rendered.findIndex((l: string) => l.includes("Notes:"));
		assert.ok(notesRow >= 0, `Notes label must be on screen. got:\n${rendered.join("\n")}`);

		const editorRows = rendered.slice(notesRow + 1);
		const footerRow = editorRows.findIndex((l: string) => l.includes("enter to confirm"));
		assert.ok(footerRow > 0, `the editor must render between the Notes label and the footer. got:\n${rendered.join("\n")}`);
	});

	it("does not advertise a working scroll key while the editor has focus", () => {
		Object.defineProperty(process.stdout, "rows", { value: 30, configurable: true });
		const widget = openWidget(questions);

		for (const key of lastOptionIndex(questions[0].options.length)) widget.handleInput(key);
		widget.handleInput(ENTER);
		widget.invalidate();

		const rendered = widget.render(120).map(stripAnsi).join("\n");
		assert.ok(!rendered.includes("scroll options"), `scroll hint is inert in notes mode. got:\n${rendered}`);
	});

	it("also keeps notes visible when opened with tab on a regular option", () => {
		Object.defineProperty(process.stdout, "rows", { value: 22, configurable: true });
		const widget = openWidget(questions);

		widget.handleInput(TAB);
		widget.invalidate();

		const rendered = widget.render(120).map(stripAnsi);
		assert.ok(rendered.some((l: string) => l.includes("Notes:")), `Notes label must be on screen. got:\n${rendered.join("\n")}`);
	});
});
