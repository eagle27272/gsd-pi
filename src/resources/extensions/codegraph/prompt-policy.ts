export const CODEGRAPH_NO_PROMPT_HOOK_ENV = "CODEGRAPH_NO_PROMPT_HOOK";

function withoutHostContext(prompt: string): string {
  const opening = /<(system[-_]reminder|system[-_]notification|task-notification|agent-message|cross-session-message|current_datetime|copilot_[a-z0-9_]+|branch_rename_request)(?:\s[^<>]*)?>/gi;
  let end = 0;
  let result = "";
  for (let match = opening.exec(prompt); match; match = opening.exec(prompt)) {
    const closing = new RegExp(`</${match[1]}\\s*>`, "gi");
    closing.lastIndex = opening.lastIndex;
    const close = closing.exec(prompt);
    if (!close) break;
    result += `${prompt.slice(end, match.index)} `;
    end = closing.lastIndex;
    opening.lastIndex = end;
  }
  return result + prompt.slice(end);
}

export function isClearlyCodePrompt(prompt: string): boolean {
  const text = withoutHostContext(prompt).replace(/\bhttps?:\/\/[^\s`<>()]+/gi, " ");
  return (
    /(?:^|[\s`"'([{])(?:[A-Za-z]:)?[\\/]?(?:[\w@.~-]+[\\/])*[\w@.-]+\.(?:[cm]?[jt]sx?|pyi?|go|rs|java|kt|kts|c|h|cc|cpp|hpp|cs|rb|php|swift|scala|sh)(?=$|[\s`"')\]},:;!?])/i.test(text) ||
    /\b(?:codebases?|source\s+code|source\s+files?|programming|refactor(?:s|ed|ing)?|(?:unit|integration|regression|automated)\s+tests?|stack\s*trace)\b/i.test(text) ||
    /\b(?:this|the|our|your|my|existing|application|project|production)\s+code\b/i.test(text) ||
    /\b(?:functions?|methods?|class(?:es)?|interfaces?|enums?|types?|symbols?)\s+(?:named|called)\s+`?[A-Za-z_$][\w$]*/i.test(text) ||
    /\b[A-Z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*\s+(?:function|method|class|interface|enum|type|symbol)\b/.test(text) ||
    /```[ \t]*(?:bash|c|c\+\+|c#|cpp|csharp|cs|css|go|golang|html|java|javascript|js|jsx|kotlin|kt|php|py|python|rb|ruby|rs|rust|scala|sh|shell|sql|swift|ts|tsx|typescript)[ \t]*\r?\n/i.test(text) ||
    /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=/.test(text) ||
    /`[A-Za-z_$][\w$]*(?:[A-Z_][\w$]*|\([^`]*\))`/.test(text) ||
    /\b[a-z][a-z0-9_$]+[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*\b/.test(text) ||
    /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/.test(text) ||
    /\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+){2,}\b/.test(text) ||
    /\b[A-Za-z_$][\w$]*\(/.test(text)
  );
}

export function applyCodegraphPromptHookPolicy(
  env: NodeJS.ProcessEnv,
  prompt: string,
): NodeJS.ProcessEnv {
  const result = { ...env };
  if (env.GSD_SUBAGENT_CHILD === "1" || !isClearlyCodePrompt(prompt)) {
    result[CODEGRAPH_NO_PROMPT_HOOK_ENV] = "1";
  }
  return result;
}
