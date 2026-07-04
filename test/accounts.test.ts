import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfigDirFromEnviron,
  discoverAccountDirs,
  resolveAccountDir,
} from '../src/accounts.ts';
import type { DiscoverDeps, ResolveDeps } from '../src/accounts.ts';

// ---------------------------------------------------------------------------
// parseConfigDirFromEnviron
// ---------------------------------------------------------------------------
describe('parseConfigDirFromEnviron', () => {
  it('extracts CLAUDE_CONFIG_DIR from null-delimited env string', () => {
    const buf = 'HOME=/home/user\0CLAUDE_CONFIG_DIR=/home/user/.claude-work\0SHELL=/bin/bash\0';
    assert.equal(parseConfigDirFromEnviron(buf), '/home/user/.claude-work');
  });

  it('returns null when var not present', () => {
    const buf = 'HOME=/home/user\0SHELL=/bin/bash\0';
    assert.equal(parseConfigDirFromEnviron(buf), null);
  });

  it('returns null when var is empty string', () => {
    const buf = 'CLAUDE_CONFIG_DIR=\0OTHER=x\0';
    assert.equal(parseConfigDirFromEnviron(buf), null);
  });
});

// ---------------------------------------------------------------------------
// discoverAccountDirs
// ---------------------------------------------------------------------------
describe('discoverAccountDirs', () => {
  it('returns only default dir on non-linux platform', async () => {
    const deps: Partial<DiscoverDeps> = {
      platform: 'darwin',
      defaultDir: () => '/home/user/.claude',
      readdir: async () => { throw new Error('should not be called'); },
      readFile: async () => { throw new Error('should not be called'); },
    };
    const result = await discoverAccountDirs(deps);
    assert.deepEqual(result, ['/home/user/.claude']);
  });

  it('collects CLAUDE_CONFIG_DIR from claude processes on linux', async () => {
    const fs = new Map<string, string>([
      ['/proc/100/cmdline', '/usr/bin/claude\0'],
      ['/proc/100/environ', 'HOME=/home/alice\0CLAUDE_CONFIG_DIR=/home/alice/.claude-work\0'],
      ['/proc/101/cmdline', '/usr/bin/node\0'],
      ['/proc/101/environ', 'HOME=/home/alice\0'],
    ]);

    const deps: Partial<DiscoverDeps> = {
      platform: 'linux',
      defaultDir: () => '/home/alice/.claude',
      readdir: async (p: string) => {
        if (p === '/proc') return ['100', '101'];
        throw new Error(`unexpected readdir: ${p}`);
      },
      readFile: async (p: string) => {
        const val = fs.get(p);
        if (val !== undefined) return val;
        throw new Error(`ENOENT: ${p}`);
      },
    };

    const result = await discoverAccountDirs(deps);
    assert.ok(result.includes('/home/alice/.claude'), 'includes default');
    assert.ok(result.includes('/home/alice/.claude-work'), 'includes proc-discovered dir');
  });

  it('falls back to default when /proc unreadable', async () => {
    const deps: Partial<DiscoverDeps> = {
      platform: 'linux',
      defaultDir: () => '/home/user/.claude',
      readdir: async () => { throw new Error('EACCES'); },
      readFile: async () => { throw new Error('EACCES'); },
    };
    const result = await discoverAccountDirs(deps);
    assert.deepEqual(result, ['/home/user/.claude']);
  });
});

// ---------------------------------------------------------------------------
// resolveAccountDir
// ---------------------------------------------------------------------------

function makeResolveDeps(overrides: Partial<ResolveDeps> & {
  fsMap?: Map<string, string>;
  existsSet?: Set<string>;
  dirsMap?: Map<string, string[]>;
}): ResolveDeps {
  const { fsMap = new Map(), existsSet = new Set(), dirsMap = new Map(), ...rest } = overrides;
  return {
    platform: 'linux',
    listProcPids: async () => [],
    readCmdline: async (pid) => { throw new Error(`no cmdline for ${pid}`); },
    readEnviron: async (pid) => {
      const val = fsMap.get(`/proc/${pid}/environ`);
      if (val !== undefined) return val;
      throw new Error(`ENOENT: /proc/${pid}/environ`);
    },
    readdir: async (p) => {
      const val = dirsMap.get(p);
      if (val !== undefined) return val;
      throw new Error(`ENOENT: ${p}`);
    },
    exists: async (p) => existsSet.has(p),
    defaultDir: () => '/home/user/.claude',
    ...rest,
  };
}

describe('resolveAccountDir — tier 1 (sole account)', () => {
  it('returns the single account immediately, no IO needed', async () => {
    const deps = makeResolveDeps({
      readdir: async () => { throw new Error('should not call readdir'); },
      exists: async () => { throw new Error('should not call exists'); },
    });
    const result = await resolveAccountDir(
      'uuid-abc',
      null,
      ['/home/user/.claude'],
      deps,
    );
    assert.equal(result, '/home/user/.claude');
  });
});

describe('resolveAccountDir — tier 2 (UUID→jsonl scan)', () => {
  it('returns matching config dir when jsonl found', async () => {
    const uuid = 'e9ac70a4-fde5-4313-b202-51b9c9a695e9';
    const accountDirs = ['/home/alice/.claude', '/home/bob/.claude'];
    const existsSet = new Set<string>([
      `/home/bob/.claude/projects/myproject/${uuid}.jsonl`,
    ]);
    const dirsMap = new Map<string, string[]>([
      ['/home/alice/.claude/projects', ['proj1']],
      ['/home/bob/.claude/projects', ['myproject']],
    ]);

    const deps = makeResolveDeps({ existsSet, dirsMap });
    const result = await resolveAccountDir(uuid, null, accountDirs, deps);
    assert.equal(result, '/home/bob/.claude');
  });

  it('checks all projects in a config dir before moving on', async () => {
    const uuid = 'aaaa-bbbb';
    const accountDirs = ['/home/alice/.claude', '/home/bob/.claude'];
    // uuid found in alice's second project
    const existsSet = new Set<string>([
      `/home/alice/.claude/projects/proj2/${uuid}.jsonl`,
    ]);
    const dirsMap = new Map<string, string[]>([
      ['/home/alice/.claude/projects', ['proj1', 'proj2']],
      ['/home/bob/.claude/projects', ['proj3']],
    ]);

    const deps = makeResolveDeps({ existsSet, dirsMap });
    const result = await resolveAccountDir(uuid, null, accountDirs, deps);
    assert.equal(result, '/home/alice/.claude');
  });
});

describe('resolveAccountDir — tier 3 (PID→environ fallback)', () => {
  it('falls back to PID environ when UUID scan misses', async () => {
    const uuid = 'uuid-notfound';
    const shellPid = 9999;
    const accountDirs = ['/home/alice/.claude', '/home/bob/.claude'];
    // UUID not in any project
    const dirsMap = new Map<string, string[]>([
      ['/home/alice/.claude/projects', []],
      ['/home/bob/.claude/projects', []],
    ]);
    const fsMap = new Map<string, string>([
      [`/proc/${shellPid}/environ`, `HOME=/home/bob\0CLAUDE_CONFIG_DIR=/home/bob/.claude\0`],
    ]);

    const deps = makeResolveDeps({ dirsMap, fsMap });
    const result = await resolveAccountDir(uuid, shellPid, accountDirs, deps);
    assert.equal(result, '/home/bob/.claude');
  });

  it('returns null when PID environ dir not in known accounts', async () => {
    const uuid = 'uuid-notfound';
    const shellPid = 1234;
    // Two accounts so tier 1 doesn't fire; UUID misses; PID environ points to unknown dir
    const accountDirs = ['/home/alice/.claude', '/home/carol/.claude'];
    const dirsMap = new Map<string, string[]>([
      ['/home/alice/.claude/projects', []],
      ['/home/carol/.claude/projects', []],
    ]);
    const fsMap = new Map<string, string>([
      [`/proc/${shellPid}/environ`, `CLAUDE_CONFIG_DIR=/home/unknown/.claude\0`],
    ]);

    const deps = makeResolveDeps({ dirsMap, fsMap });
    const result = await resolveAccountDir(uuid, shellPid, accountDirs, deps);
    assert.equal(result, null);
  });

  it('returns null when UUID is null and PID is null', async () => {
    const accountDirs = ['/home/alice/.claude', '/home/bob/.claude'];
    const deps = makeResolveDeps({});
    const result = await resolveAccountDir(null, null, accountDirs, deps);
    assert.equal(result, null);
  });

  it('returns null when no accounts discovered', async () => {
    const deps = makeResolveDeps({});
    const result = await resolveAccountDir('some-uuid', 123, [], deps);
    assert.equal(result, null);
  });
});

describe('resolveAccountDir — tier order (sole account wins over UUID scan)', () => {
  it('returns sole account even when UUID would match a different dir', async () => {
    // Only one account — tier 1 fires before UUID scan
    const uuid = 'e9ac70a4-fde5-4313-b202-51b9c9a695e9';
    const accountDirs = ['/home/alice/.claude'];
    let readdirCalled = false;
    const deps = makeResolveDeps({
      readdir: async () => { readdirCalled = true; return []; },
    });
    const result = await resolveAccountDir(uuid, null, accountDirs, deps);
    assert.equal(result, '/home/alice/.claude');
    assert.equal(readdirCalled, false, 'readdir should not be called for sole account');
  });
});
