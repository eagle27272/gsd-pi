/**
 * Unified first-run onboarding wizard.
 *
 * Replaces the raw API-key-only wizard with a branded, clack-based experience
 * that guides users through LLM provider authentication before the TUI launches.
 *
 * Flow: logo -> choose LLM provider -> authenticate (OAuth or API key) ->
 *       optional tool keys -> summary -> TUI launches.
 *
 * All steps are skippable. All errors are recoverable. Never crashes boot.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AuthStorage } from '@gsd/pi-coding-agent'
import { renderGsdPiLogo, GSD_PI_BRAND, GSD_WEBSITE } from './logo.js'
import { agentDir } from './app-paths.js'
import { isClaudeCliReady } from './claude-cli-check.js'
import {
  markOnboardingComplete,
  markStepCompleted,
  markStepSkipped,
  isOnboardingComplete,
} from './resources/extensions/gsd/onboarding-state.js'
import { getLlmProviderIds } from './resources/extensions/gsd/setup-catalog.js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ToolKeyConfig {
  provider: string
  envVar: string
  label: string
  hint: string
}

type LoginProviderId = Parameters<AuthStorage["login"]>[0]
type LoginCallbacks = Parameters<AuthStorage["login"]>[1]

type ClackModule = typeof import('@clack/prompts')
type PicoModule = {
  cyan: (s: string) => string
  green: (s: string) => string
  yellow: (s: string) => string
  dim: (s: string) => string
  bold: (s: string) => string
  red: (s: string) => string
  reset: (s: string) => string
}

interface RunOnboardingOptions {
  /** Show logo + intro banner. Disable when onboarding is launched inside an active TUI session. */
  showIntro?: boolean
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TOOL_KEYS: ToolKeyConfig[] = [
  {
    provider: 'jina',
    envVar: 'JINA_API_KEY',
    label: 'Jina AI',
    hint: 'clean web page extraction',
  },
  {
    provider: 'groq',
    envVar: 'GROQ_API_KEY',
    label: 'Groq',
    hint: 'fast inference — free at console.groq.com',
  },
]

/**
 * Known LLM provider IDs that, if authed, mean the user doesn't need onboarding.
 * Sourced from the shared setup-catalog so adding a provider lands in one place.
 * 'anthropic-vertex' and 'ollama' aren't in PROVIDER_REGISTRY but are still
 * treated as "authed = no onboarding needed" for back-compat.
 */
const LLM_PROVIDER_IDS = Array.from(new Set([
  ...getLlmProviderIds(),
  'anthropic-vertex',
  'ollama',
]))

/** API key prefix validation — loose checks to catch obvious mistakes */
const API_KEY_PREFIXES: Record<string, string[]> = {
  anthropic: ['sk-ant-'],
  openai: ['sk-'],
}

export const OTHER_PROVIDERS = [
  { value: 'google', label: 'Google (Gemini)', hint: 'aistudio.google.com/app/apikey' },
  { value: 'groq', label: 'Groq', hint: 'console.groq.com/keys' },
  { value: 'xai', label: 'xAI (Grok)', hint: 'console.x.ai' },
  { value: 'openrouter', label: 'OpenRouter', hint: '200+ models — openrouter.ai/keys' },
  { value: 'mistral', label: 'Mistral', hint: 'console.mistral.ai/api-keys' },
  { value: 'minimax', label: 'MiniMax', hint: 'platform.minimax.io (Anthropic-compatible)' },
  { value: 'minimax-cn', label: 'MiniMax CN', hint: 'api.minimaxi.com (Anthropic-compatible)' },
  { value: 'ollama-cloud', label: 'Ollama Cloud' },
  { value: 'custom-openai', label: 'Custom (OpenAI-compatible)', hint: 'Ollama, LM Studio, vLLM, proxies — see docs/providers.md' },
]

// ─── Dynamic imports ──────────────────────────────────────────────────────────

/**
 * Dynamically import @clack/prompts.
 * Dynamic import with fallback so the module doesn't crash if it's missing.
 */
async function loadClack(): Promise<ClackModule> {
  try {
    return await import('@clack/prompts')
  } catch {
    throw new Error('[gsd] @clack/prompts not found — onboarding wizard requires this dependency')
  }
}

/**
 * Build the PicoModule color surface from chalk. Chalk is already a
 * dependency of the CLI; this adapter keeps the onboarding call sites stable
 * while removing the redundant picocolors dep.
 */
async function loadPico(): Promise<PicoModule> {
  try {
    const { default: chalk } = await import('chalk')
    return {
      cyan: (s: string) => chalk.cyan(s),
      green: (s: string) => chalk.green(s),
      yellow: (s: string) => chalk.yellow(s),
      dim: (s: string) => chalk.dim(s),
      bold: (s: string) => chalk.bold(s),
      red: (s: string) => chalk.red(s),
      reset: (s: string) => chalk.reset(s),
    }
  } catch {
    // Fallback: return identity functions
    const identity = (s: string) => s
    return { cyan: identity, green: identity, yellow: identity, dim: identity, bold: identity, red: identity, reset: identity }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

/** Open a URL in the system browser (best-effort, non-blocking) */
function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    // PowerShell's Start-Process handles URLs with '&' safely; cmd /c start does not.
    execFile('powershell', ['-c', `Start-Process '${url.replace(/'/g, "''")}'`], () => {})
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open'
    execFile(cmd, [url], () => {})
  }
}

/**
 * Persist the selected default provider to settings.json.
 *
 * This ensures first startup after onboarding prefers the provider the user
 * just configured, instead of falling back to the first "available" provider
 * (which can be influenced by unrelated env auth like AWS_PROFILE).
 */
function persistDefaultProvider(providerId: string): void {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    const raw = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) : {}
    raw.defaultProvider = providerId
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2), 'utf-8')
  } catch {
    // Non-fatal: startup fallback logic will still run.
  }
}

/**
 * Persist the selected default model to settings.json.
 */
function persistDefaultModel(modelId: string): void {
  const settingsPath = join(agentDir, 'settings.json')
  try {
    const raw = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) : {}
    raw.defaultModel = modelId
    mkdirSync(dirname(settingsPath), { recursive: true })
    writeFileSync(settingsPath, JSON.stringify(raw, null, 2), 'utf-8')
  } catch {
    // Non-fatal: startup fallback logic will still run.
  }
}

export function detectNativeProviderFromBaseUrl(baseUrl: string): 'minimax' | 'minimax-cn' | null {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase()
    if (hostname === 'api.minimax.io' || hostname.endsWith('.minimax.io')) {
      return 'minimax'
    }
    if (hostname === 'api.minimaxi.com' || hostname.endsWith('.minimaxi.com')) {
      return 'minimax-cn'
    }
  } catch {
    // ignore parse failures; handled by prior validation
  }
  return null
}

/** Sentinel returned by runStep when the user cancels — tells the caller
 *  to abort the entire wizard. */
const STEP_CANCELLED = Symbol('step-cancelled')
type StepCancelled = typeof STEP_CANCELLED

/**
 * Run a single onboarding step with shared error handling:
 *   - user cancel (Ctrl+C) → p.cancel(cancelMessage), returns STEP_CANCELLED
 *   - other error → p.log.warn + optional info follow-up, returns null
 *   - success → the step's return value
 */
async function runStep<T>(
  p: ClackModule,
  warnLabel: string,
  fn: () => Promise<T>,
  opts: { cancelMessage?: string; errorInfo?: string } = {},
): Promise<T | null | StepCancelled> {
  try {
    return await fn()
  } catch (err) {
    if (p.isCancel(err)) {
      p.cancel(opts.cancelMessage ?? 'Setup cancelled.')
      return STEP_CANCELLED
    }
    p.log.warn(`${warnLabel}: ${err instanceof Error ? err.message : String(err)}`)
    if (opts.errorInfo) p.log.info(opts.errorInfo)
    return null
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine if the onboarding wizard should run.
 *
 * Returns true when:
 * - No LLM provider auth is available
 * - We're on a TTY (interactive terminal)
 *
 * Returns false (skip wizard) when:
 * - Any LLM provider is already available via auth.json, env vars, runtime overrides, or fallback auth
 * - A default provider is already configured in settings (covers extension-based providers
 *   that may not require credentials in auth.json)
 * - Not a TTY (piped input, subagent, CI)
 */
export function shouldRunOnboarding(authStorage: AuthStorage, settingsDefaultProvider?: string): boolean {
  if (!process.stdin.isTTY) return false
  // Explicit completion record wins — user has already finished onboarding (and
  // our flowVersion hasn't bumped since).
  if (isOnboardingComplete()) return false
  if (settingsDefaultProvider) return false
  // Check if any LLM provider has credentials
  const hasLlmAuth = LLM_PROVIDER_IDS.some(id => authStorage.hasAuth(id))
  return !hasLlmAuth
}

/**
 * Run the unified onboarding wizard.
 *
 * Walks the user through:
 * 1. Choose LLM provider
 * 2. Authenticate (OAuth or API key)
 * 3. Optional tool API keys
 * 4. Summary
 *
 * All steps are skippable. All errors are recoverable.
 * Writes status to stderr during execution.
 */
export async function runOnboarding(
  authStorage: AuthStorage,
  opts: RunOnboardingOptions = {},
): Promise<void> {
  let p: ClackModule
  let pc: PicoModule
  try {
    ;[p, pc] = await Promise.all([loadClack(), loadPico()])
  } catch (err) {
    // If clack isn't available, fall back silently — don't block boot
    process.stderr.write(`[gsd] Onboarding wizard unavailable: ${err instanceof Error ? err.message : String(err)}\n`)
    return
  }

  // ── Intro ─────────────────────────────────────────────────────────────────
  if (opts.showIntro !== false && process.env.GSD_SUPPRESS_LOGO !== '1') {
    process.stderr.write(renderGsdPiLogo(pc.cyan))
    process.stderr.write(`  ${pc.bold(GSD_PI_BRAND)}  ${pc.dim(GSD_WEBSITE)}\n\n`)
    p.intro(pc.bold('Welcome to GSD — let\'s get you set up'))
  } else if (opts.showIntro !== false) {
    p.intro(pc.bold('Welcome to GSD — let\'s get you set up'))
  }

  const completedSteps: string[] = []

  // ── LLM Provider Selection ────────────────────────────────────────────────
  const llmResult = await runStep(p, 'LLM setup failed', () => runLlmStep(p, pc, authStorage), {
    cancelMessage: 'Setup cancelled — you can run /gsd onboarding --resume later.',
    errorInfo: 'You can configure your LLM provider later with /login inside GSD.',
  })
  if (llmResult === STEP_CANCELLED) return
  const llmConfigured = llmResult ?? false
  if (llmConfigured) { markStepCompleted('llm'); completedSteps.push('llm') } else { markStepSkipped('llm') }

  // ── Web Search Provider ──────────────────────────────────────────────────
  const searchResult = await runStep(p, 'Web search setup failed',
    () => runWebSearchStep(p, pc, authStorage, llmConfigured))
  if (searchResult === STEP_CANCELLED) return
  const searchConfigured = searchResult
  if (searchConfigured) { markStepCompleted('search'); completedSteps.push('search') } else { markStepSkipped('search') }

  // ── Tool API Keys ─────────────────────────────────────────────────────────
  const toolResult = await runStep(p, 'Tool key setup failed',
    () => runToolKeysStep(p, pc, authStorage))
  if (toolResult === STEP_CANCELLED) return
  const toolKeyCount = toolResult ?? 0
  if (toolKeyCount > 0) { markStepCompleted('tool-keys'); completedSteps.push('tool-keys') } else { markStepSkipped('tool-keys') }

  // ── Summary ───────────────────────────────────────────────────────────────
  const summaryLines: string[] = []
  if (llmConfigured) {
    // Re-read what provider was stored
    const authed = authStorage.list().filter(id => LLM_PROVIDER_IDS.includes(id))
    if (authed.length > 0) {
      const name = authed[0]
      summaryLines.push(`${pc.green('✓')} LLM provider: ${name}`)
    } else {
      summaryLines.push(`${pc.green('✓')} LLM provider configured`)
    }
  } else {
    summaryLines.push(`${pc.yellow('↷')} LLM provider: skipped — use /login inside GSD`)
  }

  if (searchConfigured) {
    summaryLines.push(`${pc.green('✓')} Web search: ${searchConfigured}`)
  } else {
    summaryLines.push(`${pc.dim('↷')} Web search: not configured — use /search-provider inside GSD`)
  }

  if (toolKeyCount > 0) {
    summaryLines.push(`${pc.green('✓')} ${toolKeyCount} tool key${toolKeyCount > 1 ? 's' : ''} saved`)
  } else {
    summaryLines.push(`${pc.dim('↷')} Tool keys: none configured`)
  }

  // Persist completion record so re-entry and shouldRunOnboarding
  // all agree the wizard finished. Required steps drive the "complete" semantics
  // in onboarding-state.ts; here we mark wizard-level completion regardless.
  markOnboardingComplete(completedSteps)

  summaryLines.push('')
  summaryLines.push(`${pc.dim('Tip:')} re-run anytime with ${pc.cyan('/gsd onboarding')}`)

  p.note(summaryLines.join('\n'), 'Setup complete')
  p.outro(pc.dim('Launching GSD...'))
}

// ─── LLM Authentication Step ──────────────────────────────────────────────────

export async function runLlmStep(p: ClackModule, pc: PicoModule, authStorage: AuthStorage): Promise<boolean> {
  // Build the OAuth provider list dynamically from what's registered
  const oauthProviders = authStorage.getOAuthProviders()
  const oauthMap = new Map(oauthProviders.map(op => [op.id, op]))

  // Check if already authenticated
  const existingAuth = LLM_PROVIDER_IDS.find(id => authStorage.hasAuth(id))

  // ── Step 1: How do you want to authenticate? ─────────────────────────────
  type AuthOption = { value: string; label: string; hint?: string }
  const authOptions: AuthOption[] = []

  if (existingAuth) {
    authOptions.push({ value: 'keep', label: `Keep current (${existingAuth})`, hint: 'already configured' })
  }

  // Show Claude Code CLI option at the top when the CLI is installed and authenticated (#3772).
  // This is the only TOS-compliant path for Anthropic subscription users.
  if (isClaudeCliReady()) {
    authOptions.push(
      { value: 'claude-cli', label: 'Use Claude Code CLI', hint: 'uses your existing Claude subscription' },
    )
  }

  authOptions.push(
    { value: 'browser', label: 'Sign in with your browser', hint: 'GitHub Copilot or ChatGPT/Codex' },
    { value: 'api-key', label: 'Paste an API key', hint: 'from your provider dashboard' },
    { value: 'skip', label: 'Skip for now', hint: 'use /login inside GSD later' },
  )

  const method = await p.select({
    message: existingAuth ? `LLM provider: ${existingAuth} — change it?` : 'How do you want to sign in?',
    options: authOptions,
  })

  if (p.isCancel(method) || method === 'skip') return false
  if (method === 'keep') return true

  // ── Claude Code CLI path (#3772) ────────────────────────────────────────
  if (method === 'claude-cli') {
    p.log.success('Claude Code CLI detected — routing through local CLI (TOS-compliant)')
    p.log.info('Your Claude subscription will be used for inference. No API key needed.')
    // Store sentinel so hasAuth('claude-code') returns true on future boots
    authStorage.set('claude-code', { type: 'api_key', key: 'cli' })
    // Persist claude-code so startup does not keep users on anthropic direct API.
    persistDefaultProvider('claude-code')
    return true
  }

  // ── Step 2: Which provider? ──────────────────────────────────────────────
  if (method === 'browser') {
    // Anthropic OAuth is removed from browser auth — it violates Anthropic TOS for
    // third-party apps (#3772). Anthropic subscription users should use the Claude
    // Code CLI path (shown above when CLI is installed) or paste an API key.
    const provider = await p.select({
      message: 'Choose provider',
      options: [
	        { value: 'github-copilot', label: 'GitHub Copilot' },
	        { value: 'openai-codex', label: 'ChatGPT Plus/Pro (Codex)' },
	        { value: 'xai', label: 'Grok (SuperGrok / X Premium)' },
	      ],
	    })
    if (p.isCancel(provider)) return false
    return await runOAuthFlow(p, pc, authStorage, provider as string, oauthMap)
  }

  if (method === 'api-key') {
    const provider = await p.select({
      message: 'Choose provider',
      options: [
        { value: 'anthropic', label: 'Anthropic (Claude)' },
        { value: 'openai', label: 'OpenAI' },
        ...OTHER_PROVIDERS.map(op => ({ value: op.value, label: op.label })),
      ],
    })
    if (p.isCancel(provider)) return false
    if (provider === 'custom-openai') {
      return await runCustomOpenAIFlow(p, pc, authStorage)
    }
    if (provider === 'ollama') {
      return await runOllamaLocalFlow(p, pc, authStorage)
    }
    const label = provider === 'anthropic' ? 'Anthropic'
      : provider === 'openai' ? 'OpenAI'
      : OTHER_PROVIDERS.find(op => op.value === provider)?.label ?? String(provider)
    return await runApiKeyFlow(p, pc, authStorage, provider as string, label)
  }

  return false
}

// ─── OAuth Flow ───────────────────────────────────────────────────────────────

async function runOAuthFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  providerId: string,
  oauthMap: Map<string, { id: string; name?: string; usesCallbackServer?: boolean }>,
): Promise<boolean> {
  const providerInfo = oauthMap.get(providerId)
  const providerName = providerInfo?.name ?? providerId
  const usesCallbackServer = providerInfo?.usesCallbackServer ?? false

  const s = p.spinner()
  s.start(`Authenticating with ${providerName}...`)

  try {
    const loginCallbacks: LoginCallbacks = {
      onAuth: (info: { url: string; instructions?: string }) => {
        s.stop(`Opening browser for ${providerName}`)
        openBrowser(info.url)
        p.log.info(`${pc.dim('URL:')} ${pc.cyan(info.url)}`)
        if (info.instructions) {
          p.log.info(pc.yellow(info.instructions))
        }
      },
      onPrompt: async (prompt: { message: string; placeholder?: string }) => {
        const result = await p.text({
          message: prompt.message,
          placeholder: prompt.placeholder,
        })
        if (p.isCancel(result)) return ''
        return result as string
      },
      onProgress: (message: string) => {
        p.log.step(pc.dim(message))
      },
      onManualCodeInput: usesCallbackServer
        ? async () => {
            const result = await p.text({
              message: 'Paste the redirect URL from your browser:',
              placeholder: 'http://localhost:...',
            })
            if (p.isCancel(result)) return ''
            return result as string
          }
        : undefined,
      onDeviceCode: async (info) => {
        p.log.info(`${pc.dim('Code:')} ${pc.cyan(info.userCode)}`)
        p.log.info(`${pc.dim('URL:')} ${pc.cyan(info.verificationUri)}`)
        openBrowser(info.verificationUri)
      },
      onSelect: async (prompt) => {
        const result = await p.select({
          message: prompt.message,
          options: prompt.options.map((option) => ({
            value: option.id,
            label: option.label,
          })),
        })
        if (p.isCancel(result)) return prompt.options[0]?.id
        return result as string
      },
    }

    await authStorage.login(providerId as LoginProviderId, loginCallbacks)
    persistDefaultProvider(providerId)

    p.log.success(`Authenticated with ${pc.green(providerName)}`)
    return true
  } catch (err) {
    s.stop(`${providerName} authentication failed`)
    const errorMsg = err instanceof Error ? err.message : String(err)
    p.log.warn(`OAuth error: ${errorMsg}`)

    // Offer retry or skip
    const retry = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'retry', label: 'Try again' },
        { value: 'skip', label: 'Skip — configure later with /login' },
      ],
    })

    if (p.isCancel(retry) || retry === 'skip') return false
    // Recursive retry
    return runOAuthFlow(p, pc, authStorage, providerId, oauthMap)
  }
}

// ─── API Key Flow ─────────────────────────────────────────────────────────────

async function runApiKeyFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  providerId: string,
  providerLabel: string,
): Promise<boolean> {
  const key = await p.password({
    message: `Paste your ${providerLabel} API key:`,
    mask: '●',
  })

  if (p.isCancel(key) || !key) return false
  const trimmed = (key as string).trim()
  if (!trimmed) return false

  // Basic prefix validation
  const expectedPrefixes = API_KEY_PREFIXES[providerId]
  if (expectedPrefixes && !expectedPrefixes.some(pfx => trimmed.startsWith(pfx))) {
    p.log.warn(`Key doesn't start with expected prefix (${expectedPrefixes.join(' or ')}). Saving anyway.`)
  }

  authStorage.set(providerId, { type: 'api_key', key: trimmed })
  persistDefaultProvider(providerId)
  p.log.success(`API key saved for ${pc.green(providerLabel)}`)

  // Provider-specific post-setup hints
  if (providerId === 'openrouter') {
    p.log.info(`Use ${pc.cyan('/model')} inside GSD to pick an OpenRouter model.`)
    p.log.info(`To add custom models or control routing, see ${pc.dim('docs/providers.md#openrouter')}`)
  }

  return true
}

// ─── Ollama Local Flow ───────────────────────────────────────────────────────

async function runOllamaLocalFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<boolean> {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434'

  const s = p.spinner()
  s.start(`Checking Ollama at ${host}...`)

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    const response = await fetch(host, { signal: controller.signal })
    clearTimeout(timeout)

    if (response.ok) {
      s.stop(`Ollama is running at ${pc.green(host)}`)
      // Store a placeholder so the provider is recognized as authenticated
      authStorage.set('ollama', { type: 'api_key', key: 'ollama' })
      persistDefaultProvider('ollama')
      p.log.success(`${pc.green('Ollama (Local)')} configured — no API key needed`)
      p.log.info(pc.dim('Models are discovered automatically from your local Ollama instance.'))
      return true
    } else {
      s.stop('Ollama check failed')
      p.log.warn(`Ollama responded with status ${response.status} at ${host}`)
    }
  } catch {
    s.stop('Ollama not detected')
    p.log.warn(`Could not reach Ollama at ${host}`)
    p.log.info(pc.dim('Install Ollama from https://ollama.com and run "ollama serve"'))
    p.log.info(pc.dim('Set OLLAMA_HOST if using a non-default address.'))
  }

  // Even if not reachable now, save the config — the extension will detect it at runtime
  const proceed = await p.confirm({
    message: 'Save Ollama as your provider anyway? (it will auto-detect when running)',
  })

  if (p.isCancel(proceed) || !proceed) return false

  authStorage.set('ollama', { type: 'api_key', key: 'ollama' })
  persistDefaultProvider('ollama')
  p.log.success(`${pc.green('Ollama (Local)')} saved — models will appear when Ollama is running`)
  return true
}

// ─── Custom OpenAI-compatible Flow ────────────────────────────────────────────

async function runCustomOpenAIFlow(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<boolean> {
  p.log.info(pc.dim('Common endpoints:\n  Ollama:     http://localhost:11434/v1\n  LM Studio:  http://localhost:1234/v1\n  vLLM:       http://localhost:8000/v1'))

  // Prompt for base URL
  const baseUrl = await p.text({
    message: 'Base URL of your OpenAI-compatible endpoint:',
    placeholder: 'http://localhost:11434/v1',
    validate: (val) => {
      const trimmed = val?.trim()
      if (!trimmed) return 'Base URL is required'
      try {
        new URL(trimmed)
      } catch {
        return 'Must be a valid URL (e.g. https://my-proxy.example.com/v1)'
      }
    },
  })
  if (p.isCancel(baseUrl) || !baseUrl) return false
  const trimmedUrl = (baseUrl as string).trim()

  // Prompt for API key
  const apiKey = await p.password({
    message: 'API key for this endpoint:',
    mask: '●',
  })
  if (p.isCancel(apiKey) || !apiKey) return false
  const trimmedKey = (apiKey as string).trim()
  if (!trimmedKey) return false

  // Prompt for model ID
  const modelId = await p.text({
    message: 'Model ID to use:',
    placeholder: 'gpt-4o',
    validate: (val) => {
      if (!val?.trim()) return 'Model ID is required'
    },
  })
  if (p.isCancel(modelId) || !modelId) return false
  const trimmedModelId = (modelId as string).trim()

  const nativeProvider = detectNativeProviderFromBaseUrl(trimmedUrl)
  if (nativeProvider) {
    const envVar = nativeProvider === 'minimax' ? 'MINIMAX_API_KEY' : 'MINIMAX_CN_API_KEY'
    authStorage.set(nativeProvider, { type: 'api_key', key: trimmedKey })
    persistDefaultProvider(nativeProvider)
    persistDefaultModel(trimmedModelId)
    process.env[envVar] = trimmedKey

    p.log.success(`${pc.green('MiniMax')} detected — configured as native provider (${pc.cyan(nativeProvider)})`)
    p.log.info(`Model: ${pc.cyan(trimmedModelId)}`)
    p.log.info(pc.dim('Using Anthropic-compatible MiniMax integration for full model metadata and clean thinking output.'))
    return true
  }

  // Save API key to auth storage
  authStorage.set('custom-openai', { type: 'api_key', key: trimmedKey })
  persistDefaultProvider('custom-openai')
  persistDefaultModel(trimmedModelId)

  // Write or merge into models.json
  const modelsJsonPath = join(agentDir, 'models.json')
  let config: { providers: Record<string, any> } = { providers: {} }

  if (existsSync(modelsJsonPath)) {
    try {
      config = JSON.parse(readFileSync(modelsJsonPath, 'utf-8'))
      if (!config.providers) config.providers = {}
    } catch {
      // If existing file is corrupt, start fresh
      config = { providers: {} }
    }
  }

  config.providers['custom-openai'] = {
    baseUrl: trimmedUrl,
    apiKey: `env:CUSTOM_OPENAI_API_KEY`,
    api: 'openai-completions',
    models: [
      {
        id: trimmedModelId,
        name: trimmedModelId,
        reasoning: false,
        input: ['text'],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  }

  // Ensure parent directory exists
  const dir = dirname(modelsJsonPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(modelsJsonPath, JSON.stringify(config, null, 2), 'utf-8')

  // Also set env var so the current session picks up the key via fallback resolver
  process.env.CUSTOM_OPENAI_API_KEY = trimmedKey

  p.log.success(`Custom endpoint saved: ${pc.green(trimmedUrl)}`)
  p.log.info(`Model: ${pc.cyan(trimmedModelId)}`)
  p.log.info(`Config written to ${pc.dim(modelsJsonPath)}`)
  p.log.info(`If you get role or streaming errors, add compat settings to models.json.`)
  p.log.info(`See ${pc.dim('docs/providers.md#common-pitfalls')} for details.`)
  return true
}

// ─── Web Search Provider Step ─────────────────────────────────────────────────

async function runWebSearchStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
  isAnthropicAuth: boolean,
): Promise<string | null> {
  // Check which LLM provider was configured
  const authed = authStorage.list().filter(id => LLM_PROVIDER_IDS.includes(id))
  const isAnthropic = isAnthropicAuth && authed.includes('anthropic')

  // Check if web search is already configured
  const hasBrave = !!process.env.BRAVE_API_KEY || authStorage.has('brave')
  const hasTavily = !!process.env.TAVILY_API_KEY || authStorage.has('tavily')
  const existingSearch = hasBrave ? 'Brave Search' : hasTavily ? 'Tavily' : null

  // Build options based on what's available
  type SearchOption = { value: string; label: string; hint?: string }
  const options: SearchOption[] = []

  if (existingSearch) {
    options.push({ value: 'keep', label: `Keep current (${existingSearch})`, hint: 'already configured' })
  }

  if (isAnthropic) {
    options.push({
      value: 'anthropic-native',
      label: 'Anthropic built-in web search',
      hint: 'no API key needed — already included with Claude',
    })
  }

  options.push(
    { value: 'brave', label: 'Brave Search', hint: 'requires API key — brave.com/search/api' },
    { value: 'tavily', label: 'Tavily', hint: 'requires API key — tavily.com' },
    { value: 'skip', label: 'Skip for now', hint: 'use /search-provider inside GSD later' },
  )

  const choice = await p.select({
    message: 'How do you want to search the web?',
    options,
  })

  if (p.isCancel(choice) || choice === 'skip') return null
  if (choice === 'keep') return existingSearch

  if (choice === 'anthropic-native') {
    p.log.success(`Web search: ${pc.green('Anthropic built-in')} — works out of the box`)
    return 'Anthropic built-in'
  }

  if (choice === 'brave') {
    const key = await p.password({
      message: `Paste your Brave Search API key ${pc.dim('(brave.com/search/api)')}:`,
      mask: '●',
    })
    if (p.isCancel(key) || !(key as string)?.trim()) return null
    const trimmed = (key as string).trim()
    authStorage.set('brave', { type: 'api_key', key: trimmed })
    process.env.BRAVE_API_KEY = trimmed
    p.log.success(`Web search: ${pc.green('Brave Search')} configured`)
    return 'Brave Search'
  }

  if (choice === 'tavily') {
    const key = await p.password({
      message: `Paste your Tavily API key ${pc.dim('(tavily.com)')}:`,
      mask: '●',
    })
    if (p.isCancel(key) || !(key as string)?.trim()) return null
    const trimmed = (key as string).trim()
    authStorage.set('tavily', { type: 'api_key', key: trimmed })
    process.env.TAVILY_API_KEY = trimmed
    p.log.success(`Web search: ${pc.green('Tavily')} configured`)
    return 'Tavily'
  }

  return null
}

// ─── Tool API Keys Step ───────────────────────────────────────────────────────

async function runToolKeysStep(
  p: ClackModule,
  pc: PicoModule,
  authStorage: AuthStorage,
): Promise<number> {
  // Filter to keys not already configured
  const missing = TOOL_KEYS.filter(tk => !authStorage.has(tk.provider) && !process.env[tk.envVar])
  if (missing.length === 0) return 0

  const wantToolKeys = await p.confirm({
    message: 'Set up optional tool API keys? (web search, docs, etc.)',
    initialValue: false,
  })

  if (p.isCancel(wantToolKeys) || !wantToolKeys) return 0

  let savedCount = 0
  for (const tk of missing) {
    const key = await p.password({
      message: `${tk.label} ${pc.dim(`(${tk.hint})`)} — Enter to skip:`,
      mask: '●',
    })

    if (p.isCancel(key)) break

    const trimmed = (key as string | undefined)?.trim()
    if (trimmed) {
      authStorage.set(tk.provider, { type: 'api_key', key: trimmed })
      process.env[tk.envVar] = trimmed
      p.log.success(`${tk.label} saved`)
      savedCount++
    } else {
      // Store empty key so wizard doesn't re-ask on next launch
      authStorage.set(tk.provider, { type: 'api_key', key: '' })
      p.log.info(pc.dim(`${tk.label} skipped`))
    }
  }

  return savedCount
}
