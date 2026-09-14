/**
 * Sanitize error messages by redacting token-like strings before surfacing.
 *
 * Dependency-free so shared/mod.ts can re-export it. maskEditorLine lives in
 * mask-editor-line.ts because it needs CURSOR_MARKER from @gsd/pi-tui.
 */

const TOKEN_PATTERNS = [
  /xoxb-[A-Za-z0-9\-]+/g,    // Slack bot tokens
  /xoxp-[A-Za-z0-9\-]+/g,    // Slack user tokens
  /xoxa-[A-Za-z0-9\-]+/g,    // Slack app tokens
  /\d{8,10}:[A-Za-z0-9_-]{35}/g, // Telegram bot tokens
  /[A-Za-z0-9_\-.]{20,}/g,   // Long opaque secrets (Discord tokens, etc.)
];

export function sanitizeError(msg: string): string {
  let sanitized = msg;
  for (const pattern of TOKEN_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[REDACTED]");
  }
  return sanitized;
}
