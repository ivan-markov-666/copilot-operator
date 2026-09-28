/**
 * Where everything is, for the two ways this program is installed.
 *
 *   checkout   a git clone of the repository, started with `npm start`. The records live beside
 *              the code — `data/` and `runs/` in the clone — as they always have, and the UI is a
 *              Next.js dev server of its own.
 *   package    `npm i -D copilot-operator` in a project, started with `npx cop start`. The code
 *              is in `node_modules`, which `npm install` rewrites whenever it likes, so nothing of
 *              the operator's may live there: the records go to `<project>/.copilot-operator/`,
 *              and the UI is the prebuilt one shipped in the package, served by the API itself.
 *
 * Which one is decided by where the code is: inside a `node_modules` folder is a package. The
 * project a package serves is the folder that holds that `node_modules` when it is started from in
 * there — a dev dependency — and otherwise the folder it is started from: a global install
 * (`npm i -g copilot-operator`, then `cop start` in the project) or an `npx` run keep the code in a
 * `node_modules` that belongs to no project, and leave the project's package.json untouched.
 * `COP_PROJECT_ROOT` overrides both.
 *
 * Everything that used to reach for `process.cwd()` or the clone's root to find a prompt, the
 * data folder or the runs folder asks here instead, so the two installs cannot disagree about
 * where a thing is.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { botRootDir } from '../exec/workDir.js';

export type InstallLayout = {
  mode: 'checkout' | 'package';
  /** Where the program's own files are: `prompts/`, `dist/`. */
  botRoot: string;
  promptsDir: string;
  /** The project this install serves. In a checkout, the folder it was started from. */
  projectRoot: string;
  /** The folder that holds the operator's records for this install. */
  homeDir: string;
  dataDir: string;
  runsDir: string;
  /** The prebuilt web interface, when this install carries one; null means the dev server runs it. */
  webDir: string | null;
};

/** The name of the records folder a package keeps inside the project. */
export const HOME_FOLDER = '.copilot-operator';

/** The project a package install belongs to: the folder holding the `node_modules` the code sits in. */
function projectOfPackage(botRoot: string): string | null {
  const parent = dirname(resolve(botRoot));
  // `<project>/node_modules/copilot-operator`
  if (basename(parent).toLowerCase() === 'node_modules') return dirname(parent);
  // `<project>/node_modules/@scope/copilot-operator`
  if (basename(parent).startsWith('@') && basename(dirname(parent)).toLowerCase() === 'node_modules') return dirname(dirname(parent));
  return null;
}

function isInside(dir: string, root: string): boolean {
  const a = resolve(dir).toLowerCase();
  const b = resolve(root).toLowerCase();
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
}

export function installLayout(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd(), botRoot: string = botRootDir()): InstallLayout {
  const promptsDir = join(botRoot, 'prompts');
  const shippedWeb = join(botRoot, 'dist', 'web');
  const webDir = existsSync(join(shippedWeb, 'index.html')) ? shippedWeb : null;
  const packaged = projectOfPackage(botRoot);

  if (packaged) {
    // A dev dependency serves the project around it; a global or npx install serves wherever it
    // was started. Checked by folder, so a start from a subfolder of the project still finds it.
    const owner = isInside(cwd, packaged) ? packaged : cwd;
    const projectRoot = resolve(env.COP_PROJECT_ROOT ?? owner);
    const homeDir = join(projectRoot, HOME_FOLDER);
    return {
      mode: 'package',
      botRoot,
      promptsDir,
      projectRoot,
      homeDir,
      dataDir: resolve(env.COP_DATA_DIR ?? join(homeDir, 'data')),
      runsDir: join(homeDir, 'runs'),
      webDir,
    };
  }

  const projectRoot = resolve(env.COP_PROJECT_ROOT ?? cwd);
  return {
    mode: 'checkout',
    botRoot,
    promptsDir,
    projectRoot,
    homeDir: projectRoot,
    dataDir: resolve(env.COP_DATA_DIR ?? join(projectRoot, 'data')),
    runsDir: join(projectRoot, 'runs'),
    webDir,
  };
}
