import { sleep } from "@gsd/pi-coding-agent/utils/sleep.js";

const NON_RETRYABLE_PROVIDER_LIMIT_PATTERN = new RegExp(
	[
		"GoUsageLimitError",
		"FreeUsageLimitError",
		"Monthly usage limit reached",
		"available balance",
		"insufficient_quota",
		"out of budget",
		"quota exceeded",
		"billing",
		"subscription_sharing_usage_limit_exceeded",
		"subscription_sharing_workplace_individual_usage_limit_exceeded",
		// Zhipu/Z.ai plan limit, sent as HTTP 429 but reset in hours, not seconds.
		'"code"\\s*:\\s*"?1308(?![0-9])',
	].join("|"),
	"i",
);

const RETRYABLE_PROVIDER_ERROR_PATTERN = new RegExp(
	[
		"overloaded",
		"server_busy",
		"servers are currently busy",
		"currently experiencing high demand",
		"model is at capacity",
		"rate.?limit",
		"too many requests",
		// Not part of a longer word or number, so request ids and byte counts don't match.
		"(?<![a-z0-9])(?:429|500|502|503|504|520|524)(?![a-z0-9])",
		"service.?(?:is.?)?(?:temporarily.?)?unavailable",
		"server.?error",
		"internal.?error",

		"provider.?returned.?(?:an.?)?error",
		"exceeded request buffer limit while retrying upstream",
		"unable to forward upstream",
		"upstream.?request.?failed",
		"upstream_stream_read_error",
		"stream was interrupted",
		"http/?2 stream failed",

		"network.?error",
		"connection.?error",
		"connection.?refused",
		"connection.?lost",
		"other side closed",
		"fetch failed",
		// node-fetch system errors, e.g. a Google ADC token refresh; the reason is often empty.
		"request to \\S+ failed, reason:",
		"getaddrinfo",
		"ENOTFOUND",
		"EAI_AGAIN",
		"upstream.?connect",
		"reset before headers",
		"socket hang up",
		"socket connection was closed",
		"timed? out",
		"timeout",
		"terminated",

		"websocket.?closed",
		"websocket.?error",

		"ended without",
		"stream ended before message_stop",
		"stream ended before a terminal response event",
		"http2 request did not get a response",
		"stream disconnected before completion",
		"cut short after the reply had begun",
		// ERR_HTTP2_STREAM_CANCEL after the Bedrock SDK's session timeout.
		"pending stream has been canceled",

		"retry delay",

		"you can retry your request",
		"try your request again",
		"please retry your request",

		"ResourceExhausted",

		"subscription_sharing_usage_unavailable",
		"subscription_sharing_user_unavailable",
	].join("|"),
	"i",
);

export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;

/**
 * Plan and billing limits are excluded even when they arrive as 429, because
 * retrying cannot succeed until the account resets or is topped up.
 */
export function isRetryableErrorText(errorMessage: string): boolean {
	if (NON_RETRYABLE_PROVIDER_LIMIT_PATTERN.test(errorMessage)) return false;
	return RETRYABLE_PROVIDER_ERROR_PATTERN.test(errorMessage);
}

export function retryDelayMs(policy: { baseDelayMs: number; maxDelayMs?: number }, attempt: number): number {
	const delay = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
	const safeDelay = Number.isSafeInteger(delay) ? delay : Number.MAX_SAFE_INTEGER;
	return Math.min(safeDelay, policy.maxDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS);
}

export interface TransientRetryPolicy {
	enabled: boolean;
	maxRetries: number;
	baseDelayMs: number;
}

/**
 * The backoff sleep is cancelled by `signal`; a cancelled sleep rethrows the
 * operation's own error so the caller reports what actually failed.
 */
export async function retryTransientFailures<T>(
	operation: () => Promise<T>,
	policy: TransientRetryPolicy,
	signal: AbortSignal,
	sleepFn: (ms: number, signal: AbortSignal) => Promise<void> = sleep,
): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await operation();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!policy.enabled || attempt > policy.maxRetries || signal.aborted || !isRetryableErrorText(message)) {
				throw error;
			}
			try {
				await sleepFn(retryDelayMs(policy, attempt), signal);
			} catch {
				throw error;
			}
		}
	}
}
