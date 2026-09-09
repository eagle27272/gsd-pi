/**
 * Per-process count of issues filed by the self-report extension this session.
 * Reset on session_start.
 */

let filed = 0;

export function filedThisSession(): number {
  return filed;
}

export function recordFiled(): void {
  filed += 1;
}

export function resetSession(): void {
  filed = 0;
}
