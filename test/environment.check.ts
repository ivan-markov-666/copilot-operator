/**
 * Which world a run got, written down.
 *
 * Two runs of one plan a day apart got TypeScript 6 and then 7, Next 15 and then 16, and
 * behaved differently for reasons that took an afternoon to explain. The manifest is the
 * layer under the project's lockfile: the machine's tools, once per process.
 *
 *   npm run check:environment
 */
import { collectEnvironment, describeEnvironment } from '../src/exec/environment.js';

const started = Date.now();
const env = collectEnvironment();
const took = Date.now() - started;

console.log('--- the manifest ---');
console.log(describeEnvironment(env).split('\n').map((l) => '  ' + l).join('\n'));
console.log('\nnode matches this process :', env.node === process.versions.node, '(expect true)');
console.log('git was found             :', env.git !== null, '(expect true on a machine that runs the bot)');
console.log('a PowerShell was found    :', env.pwsh !== null || env.powershell !== null, '(expect true)');
console.log('collected in              :', `${took} ms`);

const again = Date.now();
const second = collectEnvironment();
console.log('reused, not re-probed     :', second === env && Date.now() - again < 50, '(expect true)');
console.log('fresh when asked          :', collectEnvironment(true) !== env, '(expect true)');
