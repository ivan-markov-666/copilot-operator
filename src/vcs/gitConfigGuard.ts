/**
 * The git settings a step might change so that the runner's own git runs a program (audit, 2026-10-27).
 *
 * The step gate refuses `git config` writes and lines that go into `.git` (`repositoryInternalsRefusal`), but it reads
 * what a step says, and a program a step starts — a project script, a test — can write `.git\config` or the operator's
 * `.gitconfig` with nothing in the line to show it. A filter driver, `core.worktree`, an include or an alias written
 * there is run, or followed, by the runner's next `git status`, checkpoint or commit: with the bot's environment, no
 * approval and no log. So the files are read before each of the chat's steps and again after it; where a key that names
 * a program or a path changed, the file is put back as it was, and the step's result says so. Keys that only describe
 * the repository — a branch's upstream, a remote's fetch spec, the user's name — are left as the step left them.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { gitSync } from './git.js';

/** Keys whose value git runs, or follows to another file or folder. */
const NAMES_A_PROGRAM = [
  /^filter\./,
  /^diff\.[^.]+\.(?:textconv|command)$/,
  /^merge\.[^.]+\.driver$/,
  /^core\.(?:hookspath|fsmonitor|sshcommand|gitproxy|pager|editor|askpass|worktree|attributesfile|excludesfile|alternaterefscommand)$/,
  /^credential\./,
  /^gpg\./,
  /^include\./,
  /^includeif\./,
  /^alias\./,
  /^sequence\.editor$/,
  /^uploadpack\./,
  /^receive\./,
  /^remote\.[^.]+\.(?:uploadpack|receivepack|proxy|vcs|url|pushurl)$/,
  /^url\./,
  /^http\./,
  /^protocol\./,
  /^safe\./,
  /^difftool\./,
  /^mergetool\./,
  /^pager\./,
  /^browser\./,
  /^web\.browser$/,
  /^man\./,
  /^instaweb\./,
  /^sendemail\./,
  /^submodule\.[^.]+\.update$/,
  /^ssh\./,
];

const dangerous = (key: string): boolean => NAMES_A_PROGRAM.some((re) => re.test(key));

/** The configuration files a step could change: the repository's own, its worktree's, and the operator's. */
function configFiles(cwd: string): string[] {
  const out: string[] = [];
  for (const name of ['config', 'config.worktree']) {
    const r = gitSync(cwd, ['rev-parse', '--git-path', name]);
    if (r.ok && r.stdout) out.push(resolve(cwd, r.stdout));
  }
  const home = process.env.USERPROFILE || homedir();
  out.push(join(home, '.gitconfig'));
  out.push(process.env.XDG_CONFIG_HOME ? join(process.env.XDG_CONFIG_HOME, 'git', 'config') : join(home, '.config', 'git', 'config'));
  return [...new Set(out)];
}

const bytesOf = (file: string): Buffer | null => {
  try {
    return existsSync(file) ? readFileSync(file) : null;
  } catch {
    return null;
  }
};

/** The keys of one config file, with their values, read by git itself without following includes. */
function keysOf(file: string, cwd: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(file)) return out;
  const r = gitSync(cwd, ['config', '--file', file, '--no-includes', '--list', '-z']);
  for (const entry of r.stdout.split('\0')) {
    if (!entry) continue;
    const at = entry.indexOf('\n');
    const key = (at < 0 ? entry : entry.slice(0, at)).toLowerCase();
    out.set(key, `${out.get(key) ?? ''}\u0001${at < 0 ? '' : entry.slice(at + 1)}`);
  }
  return out;
}

export type GitConfigChange = { file: string; keys: string[] };

/** What the chat is told of it, with the step's output. */
export function gitConfigMessage(changes: GitConfigChange[]): string {
  return (
    `this step changed git settings that name a program or a path git follows (${changes.flatMap((c) => c.keys).join(', ')}); ` +
    'they were put back as they were. The runner owns the repository and runs git itself; leave its settings alone.'
  );
}

/**
 * Reads the configuration now; the function it returns, called after the step, puts back each file in which a key
 * that names a program or a path changed, and says which.
 */
export function watchGitConfig(cwd: string): () => GitConfigChange[] {
  const files = configFiles(cwd);
  const before = files.map((file) => ({ file, bytes: bytesOf(file) }));
  return () => {
    const changes: GitConfigChange[] = [];
    for (const { file, bytes } of before) {
      const now = bytesOf(file);
      if (bytes === null ? now === null : now !== null && bytes.equals(now)) continue;
      const was = new Map<string, string>();
      if (bytes !== null) {
        // Read as it was through a copy: git reads a file, and the file is no longer what it was.
        const copy = `${file}.cop-before`;
        try {
          writeFileSync(copy, bytes);
          for (const [k, v] of keysOf(copy, cwd)) was.set(k, v);
        } finally {
          rmSync(copy, { force: true });
        }
      }
      const is = keysOf(file, cwd);
      const keys = [...new Set([...was.keys(), ...is.keys()])].filter((k) => was.get(k) !== is.get(k) && dangerous(k));
      if (keys.length === 0) continue;
      if (bytes === null) rmSync(file, { force: true });
      else writeFileSync(file, bytes);
      changes.push({ file, keys });
    }
    return changes;
  };
}
