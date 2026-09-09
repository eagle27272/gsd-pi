import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface CliFlags {
  mode?: 'text' | 'json' | 'rpc' | 'mcp'
  print?: boolean
  continue?: boolean
  help?: boolean
  version?: boolean
  noSession?: boolean
  session?: string
  sessionDir?: string
  worktree?: boolean | string
  model?: string
  thinking?: CliThinkingLevel
  listModels?: string | true
  extensions: string[]
  appendSystemPrompt?: string
  tools?: string[]
  /** --bare: minimal context — suppress CLAUDE.md/AGENTS.md, user skills, prompt templates, themes */
  bare?: boolean
  messages: string[]

  /** Set by `gsd sessions` when the user picks a specific session to resume */
  _selectedSessionPath?: string
}

export type CliThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const VALID_THINKING_LEVELS = new Set<CliThinkingLevel>(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

const PASSTHROUGH_SUBCOMMANDS = new Set([
  'config',
  'graph',
  'headless',
  'install',
  'list',
  'read',
  'remove',
  'quick',
  'sessions',
  'update',
  'upgrade',
  'worktree',
  'wt',
])

function isThinkingLevel(value: string): value is CliThinkingLevel {
  return VALID_THINKING_LEVELS.has(value as CliThinkingLevel)
}

export function parseCliArgs(argv: string[]): CliFlags {
  const flags: CliFlags = { extensions: [], messages: [] }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--mode' && i + 1 < args.length) {
      const mode = args[++i]
      if (mode === 'text' || mode === 'json' || mode === 'rpc' || mode === 'mcp') flags.mode = mode
    } else if (arg === '--print' || arg === '-p') {
      flags.print = true
    } else if (arg === '--continue' || arg === '-c') {
      flags.continue = true
    } else if (arg === '--help' || arg === '-h') {
      flags.help = true
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true
    } else if (arg === '--no-session') {
      flags.noSession = true
    } else if (arg === '--session' && i + 1 < args.length) {
      flags.session = args[++i]
    } else if (arg === '--session-dir' && i + 1 < args.length) {
      flags.sessionDir = args[++i]
    } else if (arg === '--worktree' || arg === '-w') {
      // -w with no value → auto-generate name; -w <name> → use that name
      if (i + 1 < args.length && !args[i + 1].startsWith('-')) {
        flags.worktree = args[++i]
      } else {
        flags.worktree = true
      }
    } else if (arg === '--model' && i + 1 < args.length) {
      flags.model = args[++i]
    } else if (arg === '--thinking' && i + 1 < args.length) {
      const level = args[++i]
      if (!isThinkingLevel(level)) {
        throw new Error(`Invalid thinking level "${level}". Valid values: ${[...VALID_THINKING_LEVELS].join(', ')}`)
      }
      flags.thinking = level
    } else if (arg === '--extension' && i + 1 < args.length) {
      flags.extensions.push(args[++i])
    } else if (arg === '--append-system-prompt' && i + 1 < args.length) {
      flags.appendSystemPrompt = args[++i]
    } else if (arg === '--tools' && i + 1 < args.length) {
      flags.tools = args[++i].split(',')
    } else if (arg === '--bare') {
      // Forwarded by the headless orchestrator / MCP session manager to the
      // spawned RPC child (`--mode rpc ... --bare`); must parse at top level.
      flags.bare = true
    } else if (arg === '--list-models') {
      flags.listModels = (i + 1 < args.length && !args[i + 1].startsWith('-')) ? args[++i] : true
    } else if (!arg.startsWith('--') && !arg.startsWith('-')) {
      if (flags.messages.length === 0 && PASSTHROUGH_SUBCOMMANDS.has(arg) && !flags.print && flags.mode === undefined) {
        flags.messages.push(arg, ...args.slice(i + 1))
        break
      }
      flags.messages.push(arg)
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  return flags
}

export function buildHeadlessCommandArgs(flags: Pick<CliFlags, 'messages' | 'model' | 'thinking'>): string[] {
  const args: string[] = []
  if (flags.model) args.push('--model', flags.model)
  if (flags.thinking) args.push('--thinking', flags.thinking)
  args.push(...flags.messages)
  return args
}

export { getProjectSessionsDir } from './project-sessions.js'

export function migrateLegacyFlatSessions(baseSessionsDir: string, projectSessionsDir: string): void {
  if (!existsSync(baseSessionsDir)) return

  try {
    const entries = readdirSync(baseSessionsDir)
    const flatJsonl = entries.filter((file) => file.endsWith('.jsonl'))
    if (flatJsonl.length === 0) return

    mkdirSync(projectSessionsDir, { recursive: true })
    for (const file of flatJsonl) {
      const src = join(baseSessionsDir, file)
      const dst = join(projectSessionsDir, file)
      if (!existsSync(dst)) {
        renameSync(src, dst)
      }
    }
  } catch {
    // Non-fatal — don't block startup if migration fails
  }
}
