/**
 * Account discovery and pane→account resolution.
 *
 * Primary resolution path: UUID→jsonl glob scan across discovered config dirs.
 * Fallback: shell PID → /proc/<pid>/environ → CLAUDE_CONFIG_DIR.
 */

export function parseConfigDirFromEnviron(buf: string): string | null {
  const entries = buf.split('\0');
  for (const entry of entries) {
    if (entry.startsWith('CLAUDE_CONFIG_DIR=')) {
      const val = entry.slice('CLAUDE_CONFIG_DIR='.length);
      return val.length > 0 ? val : null;
    }
  }
  return null;
}

export interface DiscoverDeps {
  platform?: string;
  readdir: (path: string) => Promise<string[]>;
  readFile: (path: string) => Promise<string>;
  defaultDir: () => string;
}

export interface ResolveDeps {
  platform?: string;
  /** List /proc pids */
  listProcPids: () => Promise<string[]>;
  /** Read /proc/<pid>/cmdline */
  readCmdline: (pid: string) => Promise<string>;
  /** Read /proc/<pid>/environ */
  readEnviron: (pid: string) => Promise<string>;
  /** List subdirs of a directory */
  readdir: (path: string) => Promise<string[]>;
  /** Check if a path exists (file or dir) */
  exists: (path: string) => Promise<boolean>;
  defaultDir: () => string;
}

function defaultConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? `${process.env['HOME'] ?? '/root'}/.claude`;
}

function defaultDiscoverDeps(): DiscoverDeps {
  return {
    platform: process.platform,
    readdir: async (p: string) => {
      const { readdir } = await import('node:fs/promises');
      return readdir(p);
    },
    readFile: async (p: string) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(p, 'utf8');
    },
    defaultDir: defaultConfigDir,
  };
}

function defaultResolveDeps(): ResolveDeps {
  return {
    platform: process.platform,
    listProcPids: async () => {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir('/proc');
      return entries.filter(e => /^\d+$/.test(e));
    },
    readCmdline: async (pid: string) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(`/proc/${pid}/cmdline`, 'utf8');
    },
    readEnviron: async (pid: string) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(`/proc/${pid}/environ`, 'utf8');
    },
    readdir: async (p: string) => {
      const { readdir } = await import('node:fs/promises');
      return readdir(p);
    },
    exists: async (p: string) => {
      const { access } = await import('node:fs/promises');
      try {
        await access(p);
        return true;
      } catch {
        return false;
      }
    },
    defaultDir: defaultConfigDir,
  };
}

/**
 * Scan /proc for claude processes and collect their CLAUDE_CONFIG_DIR values.
 * Returns deduplicated list including the default dir.
 */
export async function discoverAccountDirs(deps?: Partial<DiscoverDeps>): Promise<string[]> {
  const merged = { ...defaultDiscoverDeps(), ...deps };
  const platform = merged.platform ?? process.platform;
  const base = merged.defaultDir();
  const dirs = new Set<string>([base]);

  if (platform !== 'linux') {
    return [base];
  }

  try {
    const entries = await merged.readdir('/proc');
    const pids = entries.filter(e => /^\d+$/.test(e));

    await Promise.all(pids.map(async pid => {
      try {
        const cmdline = await merged.readFile(`/proc/${pid}/cmdline`);
        if (!cmdline.includes('claude')) return;
        const environ = await merged.readFile(`/proc/${pid}/environ`);
        const dir = parseConfigDirFromEnviron(environ) ?? base;
        dirs.add(dir);
      } catch {
        // skip unreadable pids
      }
    }));
  } catch {
    return [base];
  }

  return Array.from(dirs);
}

/**
 * Resolve which config dir owns a pane, given:
 * - sessionUuid: the Claude Code session UUID from agent_session.value
 * - shellPid: the shell PID from pane.process_info (for fallback)
 * - accountDirs: list of discovered config dirs
 *
 * Tier order:
 * 1. Sole account - return it immediately
 * 2. UUID-to-jsonl scan: glob <configDir>/projects/<star>/<uuid>.jsonl
 * 3. PID-to-environ: read /proc/<shellPid>/environ, extract CLAUDE_CONFIG_DIR
 * 4. null
 */
export async function resolveAccountDir(
  sessionUuid: string | null,
  shellPid: number | null,
  accountDirs: string[],
  deps?: Partial<ResolveDeps>,
): Promise<string | null> {
  const merged = { ...defaultResolveDeps(), ...deps };

  // Tier 1: sole account
  if (accountDirs.length === 1) {
    return accountDirs[0]!;
  }

  if (accountDirs.length === 0) {
    return null;
  }

  // Tier 2: UUID→jsonl scan
  if (sessionUuid !== null) {
    for (const configDir of accountDirs) {
      try {
        const projectsDir = `${configDir}/projects`;
        let projects: string[];
        try {
          projects = await merged.readdir(projectsDir);
        } catch {
          continue;
        }

        let found = false;
        for (const project of projects) {
          const jsonlPath = `${projectsDir}/${project}/${sessionUuid}.jsonl`;
          try {
            const exists = await merged.exists(jsonlPath);
            if (exists) {
              found = true;
              break;
            }
          } catch {
            // skip
          }
        }

        if (found) {
          return configDir;
        }
      } catch {
        // skip this dir
      }
    }
  }

  // Tier 3: PID→environ fallback
  if (shellPid !== null) {
    try {
      const environ = await merged.readEnviron(String(shellPid));
      const dir = parseConfigDirFromEnviron(environ);
      if (dir !== null && accountDirs.includes(dir)) {
        return dir;
      }
    } catch {
      // fallthrough
    }
  }

  // Tier 4: unknown
  return null;
}
