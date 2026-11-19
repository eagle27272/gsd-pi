import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	DEFAULT_MAX_RETRY_DELAY_MS,
	isRetryableErrorText,
	retryDelayMs,
	retryTransientFailures,
} from "./retry-classification.js";

describe("isRetryableErrorText", () => {
	const transient = [
		"overloaded_error: Overloaded",
		"429 Too Many Requests",
		"HTTP 503 Service Unavailable",
		"upstream_error: the upstream provider returned an error",
		"Unable to forward upstream stream",
		"stream disconnected before completion: stream closed before response.completed",
		"The service is temporarily unavailable",
		"server_busy",
		"The servers are currently busy, please try again later",
		"The model is at capacity right now",
		"Cloudflare 524: A timeout occurred",
		"520 Web server returned an unknown error",
		"getaddrinfo ENOTFOUND api.example.com",
		"EAI_AGAIN api.example.com",
		"The socket connection was closed unexpectedly",
		"Claude Code's stream from Anthropic was cut short after the reply had begun",
		"The pending stream has been canceled",
		"You can retry your request",
		"ResourceExhausted: try again later",
		"request to https://oauth2.googleapis.com/token failed, reason:",
	];
	for (const text of transient) {
		it(`retries: ${text}`, () => {
			assert.equal(isRetryableErrorText(text), true);
		});
	}

	it("does not treat digits inside a request id as an HTTP status", () => {
		assert.equal(isRetryableErrorText('400 {"type":"invalid_request_error","request_id":"req_011CU503xyz"}'), false);
		assert.equal(isRetryableErrorText("invalid request, 5000 bytes over the limit"), false);
	});

	const exhausted = [
		'429 {"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}',
		'429 {"code":"1308","message":"Usage limit reached for 5 hour"}',
		"429 quota exceeded for this project",
		"GoUsageLimitError: Monthly usage limit reached",
		"429 your billing account is out of budget",
	];
	for (const text of exhausted) {
		it(`does not retry an exhausted plan: ${text}`, () => {
			assert.equal(isRetryableErrorText(text), false);
		});
	}

	it("does not retry an ordinary client error", () => {
		assert.equal(isRetryableErrorText("400 invalid_request_error: messages.0.content is required"), false);
	});
});

describe("retryDelayMs", () => {
	it("doubles per attempt", () => {
		assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 1), 2000);
		assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 3), 8000);
	});

	it("caps the delay", () => {
		assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 10), DEFAULT_MAX_RETRY_DELAY_MS);
		assert.equal(retryDelayMs({ baseDelayMs: 2000 }, 2000), DEFAULT_MAX_RETRY_DELAY_MS);
	});
});

describe("retryTransientFailures", () => {
	const policy = { enabled: true, maxRetries: 2, baseDelayMs: 1000 };
	const noSleep = async () => {};

	it("retries a transient failure and returns the eventual result", async () => {
		const delays: number[] = [];
		let calls = 0;
		const result = await retryTransientFailures(
			async () => {
				calls++;
				if (calls < 3) throw new Error("Summarization failed: 429 rate limit exceeded");
				return "summary";
			},
			policy,
			new AbortController().signal,
			async (ms) => {
				delays.push(ms);
			},
		);

		assert.equal(result, "summary");
		assert.equal(calls, 3);
		assert.deepEqual(delays, [1000, 2000]);
	});

	it("gives up after maxRetries and throws the last error", async () => {
		let calls = 0;
		await assert.rejects(
			retryTransientFailures(
				async () => {
					calls++;
					throw new Error(`Summarization failed: 503 attempt ${calls}`);
				},
				policy,
				new AbortController().signal,
				noSleep,
			),
			/attempt 3/,
		);
		assert.equal(calls, 3);
	});

	it("does not retry an error that is not transient", async () => {
		let calls = 0;
		await assert.rejects(
			retryTransientFailures(
				async () => {
					calls++;
					throw new Error("Summarization failed: 400 invalid_request_error");
				},
				policy,
				new AbortController().signal,
				noSleep,
			),
			/invalid_request_error/,
		);
		assert.equal(calls, 1);
	});

	it("does not retry when retries are disabled", async () => {
		let calls = 0;
		await assert.rejects(
			retryTransientFailures(
				async () => {
					calls++;
					throw new Error("429 too many requests");
				},
				{ ...policy, enabled: false },
				new AbortController().signal,
				noSleep,
			),
		);
		assert.equal(calls, 1);
	});

	it("surfaces the original error when aborted during the backoff", async () => {
		const controller = new AbortController();
		await assert.rejects(
			retryTransientFailures(
				async () => {
					throw new Error("Summarization failed: 502 bad gateway");
				},
				policy,
				controller.signal,
				async () => {
					controller.abort();
					throw new Error("Aborted");
				},
			),
			/502 bad gateway/,
		);
	});
});
