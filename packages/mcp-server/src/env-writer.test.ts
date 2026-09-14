// @opengsd/mcp-server — Tests for env-writer utilities

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync, lstatSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';

import {
  checkExistingEnvKeys,
  detectDestination,
  writeEnvKey,
  applySecrets,
  isSecuritySensitiveEnvKey,
  isSafeEnvVarKey,
  isSupportedDeploymentEnvironment,
  resolveProjectEnvFilePath,
  shellEscapeSingle,
} from './env-writer.js';

/** A temp dir that looks like a real project — resolveProjectEnvFilePath requires a marker. */
function makeTempDir(prefix: string): string {
  const dir = makeBareTempDir(prefix);
  writeFileSync(join(dir, 'package.json'), '{}');
  return dir;
}

/** A temp dir with no project marker, for the cases that must be refused. */
function makeBareTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** Read a key back the way a `set -a; source .env` consumer would. */
function sourceEnvValue(envPath: string, key: string): string {
  const script = `set -a; . "$1"; set +a; printf %s "$${key}"`;
  return execFileSync('/bin/sh', ['-c', script, 'sh', envPath], { encoding: 'utf8' });
}

const describeOnPosix = process.platform === 'win32' ? describe.skip : describe;

// ---------------------------------------------------------------------------
// checkExistingEnvKeys
// ---------------------------------------------------------------------------

describe('checkExistingEnvKeys', () => {
  it('finds key in .env file', async () => {
    const tmp = makeTempDir('env-check');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'API_KEY=secret123\nOTHER=val\n');
      const result = await checkExistingEnvKeys(['API_KEY'], envPath);
      assert.deepStrictEqual(result, ['API_KEY']);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('finds key in process.env', async () => {
    const tmp = makeTempDir('env-check');
    const saved = process.env.GSD_MCP_TEST_KEY_1;
    try {
      process.env.GSD_MCP_TEST_KEY_1 = 'some-value';
      const envPath = join(tmp, '.env');
      const result = await checkExistingEnvKeys(['GSD_MCP_TEST_KEY_1'], envPath);
      assert.deepStrictEqual(result, ['GSD_MCP_TEST_KEY_1']);
    } finally {
      delete process.env.GSD_MCP_TEST_KEY_1;
      if (saved !== undefined) process.env.GSD_MCP_TEST_KEY_1 = saved;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty for missing keys', async () => {
    const tmp = makeTempDir('env-check');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'OTHER=val\n');
      delete process.env.DEFINITELY_NOT_SET_MCP_XYZ;
      const result = await checkExistingEnvKeys(['DEFINITELY_NOT_SET_MCP_XYZ'], envPath);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('handles missing .env file gracefully', async () => {
    const tmp = makeTempDir('env-check');
    try {
      const envPath = join(tmp, 'nonexistent.env');
      delete process.env.DEFINITELY_NOT_SET_MCP_XYZ;
      const result = await checkExistingEnvKeys(['DEFINITELY_NOT_SET_MCP_XYZ'], envPath);
      assert.deepStrictEqual(result, []);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rethrows read errors other than ENOENT instead of reporting every key unset', async () => {
    const tmp = makeTempDir('env-check');
    try {
      // A directory read fails with EISDIR — swallowing it would make an
      // already-configured project look empty and re-prompt for every key.
      await assert.rejects(() => checkExistingEnvKeys(['ANY_KEY'], tmp), /EISDIR|EPERM|EACCES/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('ignores process.env entries this process hydrated after its own write', async () => {
    const tmp = makeTempDir('env-check');
    const key = 'GSD_HYDRATED_ONLY_KEY';
    try {
      const firstFile = join(tmp, '.env');
      const { applied } = await applySecrets([{ key, value: 'v1' }], 'dotenv', { envFilePath: firstFile });
      assert.deepStrictEqual(applied, [key]);

      // Second call targets a different file. The key is not in that file, so
      // the user must still be prompted — our own hydration is not evidence.
      const secondFile = join(tmp, '.env.production');
      const result = await checkExistingEnvKeys([key], secondFile);
      assert.deepStrictEqual(result, []);
    } finally {
      delete process.env[key];
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// detectDestination
// ---------------------------------------------------------------------------

describe('detectDestination', () => {
  it('returns vercel when vercel.json exists', () => {
    const tmp = makeTempDir('dest');
    try {
      writeFileSync(join(tmp, 'vercel.json'), '{}');
      assert.equal(detectDestination(tmp), 'vercel');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns convex when convex/ dir exists', () => {
    const tmp = makeTempDir('dest');
    try {
      mkdirSync(join(tmp, 'convex'));
      assert.equal(detectDestination(tmp), 'convex');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns dotenv when neither exists', () => {
    const tmp = makeTempDir('dest');
    try {
      assert.equal(detectDestination(tmp), 'dotenv');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('vercel takes priority over convex', () => {
    const tmp = makeTempDir('dest');
    try {
      writeFileSync(join(tmp, 'vercel.json'), '{}');
      mkdirSync(join(tmp, 'convex'));
      assert.equal(detectDestination(tmp), 'vercel');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writeEnvKey
// ---------------------------------------------------------------------------

describe('writeEnvKey', () => {
  it('creates .env file with new key', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      await writeEnvKey(envPath, 'NEW_KEY', 'new-value');
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes("NEW_KEY='new-value'"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('updates existing key in-place', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'EXISTING=old\nOTHER=keep\n');
      await writeEnvKey(envPath, 'EXISTING', 'new');
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes("EXISTING='new'"));
      assert.ok(content.includes('OTHER=keep'));
      assert.ok(!content.includes('old'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('escapes newlines in values', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      await writeEnvKey(envPath, 'MULTI', 'line1\nline2');
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes("MULTI='line1\\nline2'"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects non-string values', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      await assert.rejects(
        () => writeEnvKey(envPath, 'KEY', undefined as unknown as string),
        /expects a string value/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('updates every definition of a duplicated key, not just the first', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'DUP=first\nOTHER=keep\nDUP=last\n');
      await writeEnvKey(envPath, 'DUP', 'fresh');
      const content = readFileSync(envPath, 'utf8');
      // dotenv and `source` both honour the LAST definition — leaving it stale
      // reports the write as applied while the operative value never changed.
      assert.ok(!content.includes('last'), `stale trailing definition survived: ${content}`);
      assert.ok(!content.includes('first'), `stale leading definition survived: ${content}`);
      assert.ok(content.includes('OTHER=keep'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes a value containing a replacement pattern literally', async () => {
    const tmp = makeTempDir('write');
    try {
      const envPath = join(tmp, '.env');
      writeFileSync(envPath, 'TOKEN=old\n');
      // `$&` is a String.replace replacement pattern — an unguarded replace
      // would splice the matched line into the secret.
      await writeEnvKey(envPath, 'TOKEN', 'a$&b$`c');
      assert.ok(readFileSync(envPath, 'utf8').includes('a$&b$`c'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('does not follow symlinked env files when writing', async () => {
    const tmp = makeTempDir('write');
    const outside = makeTempDir('write-outside');
    try {
      const outsideEnv = join(outside, '.env');
      writeFileSync(outsideEnv, 'SECRET=outside\n');
      symlinkSync(outsideEnv, join(tmp, '.env'));

      await assert.rejects(
        () => writeEnvKey(join(tmp, '.env'), 'SECRET', 'inside'),
        /ELOOP|symbolic link|symlink/i,
      );
      assert.equal(readFileSync(outsideEnv, 'utf8'), 'SECRET=outside\n');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Value quoting — the written line must survive both dotenv and `source`
// ---------------------------------------------------------------------------

describeOnPosix('writeEnvKey value quoting', () => {
  it('round-trips a password containing $ and a backtick through `set -a; source`', async () => {
    const tmp = makeTempDir('quote');
    try {
      const envPath = join(tmp, '.env');
      const password = 'pa$$w`ord!x';
      await writeEnvKey(envPath, 'DB_PASSWORD', password);
      assert.equal(sourceEnvValue(envPath, 'DB_PASSWORD'), password);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('round-trips a value containing a single quote', async () => {
    const tmp = makeTempDir('quote');
    try {
      const envPath = join(tmp, '.env');
      const value = "it's-a-token";
      await writeEnvKey(envPath, 'TOKEN', value);
      assert.equal(sourceEnvValue(envPath, 'TOKEN'), value);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('round-trips a value containing spaces and a comment marker', async () => {
    const tmp = makeTempDir('quote');
    try {
      const envPath = join(tmp, '.env');
      const value = 'two words #notacomment';
      await writeEnvKey(envPath, 'PHRASE', value);
      assert.equal(sourceEnvValue(envPath, 'PHRASE'), value);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stays shell-exact, and dotenv-lossy, when a value mixes a quote with $', async () => {
    const tmp = makeTempDir('quote');
    try {
      const envPath = join(tmp, '.env');
      const value = "it's $HOME";
      await writeEnvKey(envPath, 'MIXED', value);
      // No encoding is exact for both here: dotenv cannot represent `'` inside
      // single quotes and unescapes nothing inside double quotes. The shell is
      // the tie-break, and dotenv gets the value with the backslash retained.
      assert.equal(readFileSync(envPath, 'utf8'), 'MIXED="it\'s \\$HOME"\n');
      assert.equal(sourceEnvValue(envPath, 'MIXED'), value);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('single-quotes ordinary values so dotenv reads them verbatim', async () => {
    const tmp = makeTempDir('quote');
    try {
      const envPath = join(tmp, '.env');
      await writeEnvKey(envPath, 'API_KEY', 'sk-abc$123');
      // Single quotes are the only form dotenv returns byte-for-byte: it does
      // not unescape `\$`, `` \` ``, `\"` or `\\` inside double quotes.
      assert.equal(readFileSync(envPath, 'utf8'), "API_KEY='sk-abc$123'\n");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProjectEnvFilePath
// ---------------------------------------------------------------------------

describe('resolveProjectEnvFilePath', () => {
  it('rejects a destination that is not a .env-family file', () => {
    const tmp = makeTempDir('env-path');
    try {
      for (const name of ['.bashrc', '.envrc', 'profile', 'src/index.ts']) {
        assert.throws(
          () => resolveProjectEnvFilePath(tmp, name),
          /\.env/,
          `${name} should not be a writable secret destination`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a symlink whose target is not a .env-family file', () => {
    const tmp = makeTempDir('env-path');
    try {
      // The name check sees the link, not the file that actually gets written.
      // `.envrc` is executed by direnv on `cd`.
      writeFileSync(join(tmp, '.envrc'), 'export FOO=1\n');
      symlinkSync(join(tmp, '.envrc'), join(tmp, '.env'));
      assert.throws(() => resolveProjectEnvFilePath(tmp, '.env'), /\.env/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses git-tracked placeholder env files', () => {
    const tmp = makeTempDir('env-path');
    try {
      for (const name of ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.EXAMPLE']) {
        assert.throws(
          () => resolveProjectEnvFilePath(tmp, name),
          /\.env/,
          `${name} is a tracked placeholder, not a secret store`,
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses an alternate-data-stream suffix', () => {
    const tmp = makeTempDir('env-path');
    try {
      for (const name of ['.env.local:evil', '.env::$DATA']) {
        assert.throws(() => resolveProjectEnvFilePath(tmp, name), /\.env/, name);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses a filesystem root as the project root', () => {
    assert.throws(() => resolveProjectEnvFilePath(parse(process.cwd()).root, '.env'), /filesystem root/i);
  });

  it('refuses a directory with no project marker at or above it', () => {
    const parent = makeBareTempDir('no-marker');
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    try {
      const proj = join(parent, 'proj');
      mkdirSync(proj);
      // Pin HOME to the parent so the upward search terminates here rather than
      // at whatever happens to sit above the system temp directory.
      process.env.HOME = parent;
      process.env.USERPROFILE = parent;
      assert.throws(() => resolveProjectEnvFilePath(proj, '.env'), /project/i);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it('accepts a subdirectory of a marked project', () => {
    const tmp = makeTempDir('env-path');
    try {
      const nested = join(tmp, 'apps', 'web');
      mkdirSync(nested, { recursive: true });
      assert.equal(
        resolveProjectEnvFilePath(nested, '.env'),
        join(realpathSync.native(tmp), 'apps', 'web', '.env'),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts a git worktree, whose .git is a file rather than a directory', () => {
    const tmp = makeBareTempDir('worktree');
    try {
      writeFileSync(join(tmp, '.git'), 'gitdir: /elsewhere/.git/worktrees/wt\n');
      assert.equal(resolveProjectEnvFilePath(tmp, '.env'), join(realpathSync.native(tmp), '.env'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('accepts the .env family, including inside a subdirectory', () => {
    const tmp = makeTempDir('env-path');
    try {
      mkdirSync(join(tmp, 'config'));
      const root = realpathSync.native(tmp);
      assert.equal(resolveProjectEnvFilePath(tmp, '.env.local'), join(root, '.env.local'));
      assert.equal(
        resolveProjectEnvFilePath(tmp, 'config/.env.production'),
        join(root, 'config', '.env.production'),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('refuses to treat the home directory as a project root', () => {
    const tmp = makeTempDir('env-path');
    const savedHome = process.env.HOME;
    const savedProfile = process.env.USERPROFILE;
    try {
      process.env.HOME = tmp;
      process.env.USERPROFILE = tmp;
      assert.throws(() => resolveProjectEnvFilePath(tmp, '.env'), /home directory/i);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedProfile;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves an in-root symlink to its target so the link survives the write', async () => {
    const tmp = makeTempDir('env-path');
    try {
      mkdirSync(join(tmp, 'config'));
      const target = join(tmp, 'config', '.env.local');
      writeFileSync(target, 'EXISTING=1\n');
      symlinkSync(target, join(tmp, '.env'));

      const resolved = resolveProjectEnvFilePath(tmp, '.env');
      assert.equal(resolved, realpathSync.native(target));

      await writeEnvKey(resolved, 'ADDED', 'value');
      assert.ok(readFileSync(target, 'utf8').includes('ADDED='));
      assert.ok(lstatSync(join(tmp, '.env')).isSymbolicLink(), 'the project symlink must survive');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('allows .env under the project root', () => {
    const tmp = makeTempDir('env-path');
    try {
      assert.equal(resolveProjectEnvFilePath(tmp, '.env'), join(realpathSync.native(tmp), '.env'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects envFilePath outside the project root', () => {
    const tmp = makeTempDir('env-path');
    try {
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, '../outside.env'),
        /inside the project directory/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects symlinked parent directories that escape the project root', () => {
    const tmp = makeTempDir('env-path');
    const outside = makeTempDir('env-path-outside');
    try {
      symlinkSync(outside, join(tmp, 'linked-outside'), 'dir');
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, 'linked-outside/.env'),
        /inside the project directory/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('rejects existing env files that are symlinks outside the project root', () => {
    const tmp = makeTempDir('env-path');
    const outside = makeTempDir('env-path-outside');
    try {
      writeFileSync(join(outside, '.env'), 'SECRET=outside\n');
      symlinkSync(join(outside, '.env'), join(tmp, '.env'));
      assert.throws(
        () => resolveProjectEnvFilePath(tmp, '.env'),
        /inside the project directory/,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// applySecrets (dotenv)
// ---------------------------------------------------------------------------

describe('applySecrets', () => {
  const savedKeys: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [k, v] of Object.entries(savedKeys)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('writes keys to .env and hydrates process.env', async () => {
    const tmp = makeTempDir('apply');
    const envPath = join(tmp, '.env');
    savedKeys.GSD_APPLY_TEST_A = process.env.GSD_APPLY_TEST_A;
    try {
      const { applied, errors } = await applySecrets(
        [{ key: 'GSD_APPLY_TEST_A', value: 'val-a' }],
        'dotenv',
        { envFilePath: envPath },
      );
      assert.deepStrictEqual(applied, ['GSD_APPLY_TEST_A']);
      assert.deepStrictEqual(errors, []);
      assert.equal(process.env.GSD_APPLY_TEST_A, 'val-a');
      const content = readFileSync(envPath, 'utf8');
      assert.ok(content.includes("GSD_APPLY_TEST_A='val-a'"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects invalid dotenv keys before writing or hydrating', async () => {
    const tmp = makeTempDir('apply-invalid');
    const envPath = join(tmp, '.env');
    try {
      const { applied, errors } = await applySecrets(
        [{ key: 'BAD-KEY', value: 'val-a' }],
        'dotenv',
        { envFilePath: envPath },
      );
      assert.deepStrictEqual(applied, []);
      assert.deepStrictEqual(errors, ['BAD-KEY: invalid environment variable name']);
      assert.throws(() => readFileSync(envPath, 'utf8'), /ENOENT/);
      assert.equal(process.env['BAD-KEY'], undefined);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('rejects security-sensitive dotenv keys case-insensitively', async () => {
    const tmp = makeTempDir('apply-sensitive');
    const envPath = join(tmp, '.env');
    try {
      const { applied, errors } = await applySecrets(
        [{ key: 'path', value: 'malicious-bin' }],
        'dotenv',
        { envFilePath: envPath },
      );
      assert.deepStrictEqual(applied, []);
      assert.deepStrictEqual(errors, ['path: refusing to set MCP server runtime variable via secure_env_collect']);
      assert.throws(() => readFileSync(envPath, 'utf8'), /ENOENT/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns errors for invalid vercel environment', async () => {
    const tmp = makeTempDir('apply');
    try {
      const { applied, errors } = await applySecrets(
        [{ key: 'KEY', value: 'val' }],
        'vercel',
        {
          envFilePath: join(tmp, '.env'),
          environment: 'staging' as 'development',
          execFn: async () => ({ code: 0, stderr: '' }),
        },
      );
      assert.deepStrictEqual(applied, []);
      assert.ok(errors[0]?.includes('unsupported'));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reports a failed provider command by exit code without echoing its stderr', async () => {
    const tmp = makeTempDir('apply-stderr');
    const secret = 'sk-supersecret-value';
    try {
      const { applied, errors } = await applySecrets(
        [{ key: 'REMOTE_KEY', value: secret }],
        'vercel',
        {
          envFilePath: join(tmp, '.env'),
          environment: 'production',
          // Providers routinely echo the rejected value back in validation errors.
          execFn: async () => ({ code: 2, stderr: `Error: value "${secret}" is too long` }),
        },
      );
      assert.deepStrictEqual(applied, []);
      assert.equal(errors.length, 1);
      assert.ok(!errors[0].includes(secret), `provider stderr leaked the secret: ${errors[0]}`);
      assert.match(errors[0], /REMOTE_KEY/);
      assert.match(errors[0], /\b2\b/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('passes remote destination secrets on stdin instead of process arguments', async () => {
    const tmp = makeTempDir('apply-remote-stdin');
    const calls: Array<{ cmd: string; args: string[]; opts?: { stdin?: string } }> = [];
    try {
      const { applied, errors } = await applySecrets(
        [{ key: 'REMOTE_SECRET', value: 'super-secret-value' }],
        'vercel',
        {
          envFilePath: join(tmp, '.env'),
          environment: 'preview',
          execFn: async (cmd, args, opts) => {
            calls.push({ cmd, args, opts });
            return { code: 0, stderr: '' };
          },
        },
      );

      assert.deepStrictEqual(applied, ['REMOTE_SECRET']);
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(calls, [
        {
          cmd: 'vercel',
          args: ['env', 'add', 'REMOTE_SECRET', 'preview'],
          opts: { stdin: 'super-secret-value' },
        },
      ]);
      assert.ok(!calls[0].args.some((arg) => arg.includes('super-secret-value')));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

describe('isSafeEnvVarKey', () => {
  it('accepts valid keys', () => {
    assert.ok(isSafeEnvVarKey('API_KEY'));
    assert.ok(isSafeEnvVarKey('_PRIVATE'));
    assert.ok(isSafeEnvVarKey('key123'));
  });

  it('rejects invalid keys', () => {
    assert.ok(!isSafeEnvVarKey('123BAD'));
    assert.ok(!isSafeEnvVarKey('has-dash'));
    assert.ok(!isSafeEnvVarKey('has space'));
    assert.ok(!isSafeEnvVarKey(''));
  });
});

describe('isSecuritySensitiveEnvKey', () => {
  it('matches sensitive keys case-insensitively', () => {
    assert.ok(isSecuritySensitiveEnvKey('PATH'));
    assert.ok(isSecuritySensitiveEnvKey('path'));
    assert.ok(isSecuritySensitiveEnvKey('Node_Options'));
  });
});

describe('isSupportedDeploymentEnvironment', () => {
  it('accepts valid environments', () => {
    assert.ok(isSupportedDeploymentEnvironment('development'));
    assert.ok(isSupportedDeploymentEnvironment('preview'));
    assert.ok(isSupportedDeploymentEnvironment('production'));
  });

  it('rejects invalid environments', () => {
    assert.ok(!isSupportedDeploymentEnvironment('staging'));
    assert.ok(!isSupportedDeploymentEnvironment('test'));
  });
});

describe('shellEscapeSingle', () => {
  it('wraps in single quotes', () => {
    assert.equal(shellEscapeSingle('hello'), "'hello'");
  });

  it('escapes embedded single quotes', () => {
    assert.equal(shellEscapeSingle("it's"), "'it'\\''s'");
  });
});
