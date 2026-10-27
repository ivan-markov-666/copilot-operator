/**
 * Commands that reach a platform outside this machine with the operator's own access (operator, 2026-10-23: "it asked
 * me whether to run Azure CLI commands; ask the same for every other such platform — Jira, Vercel, AWS, GitHub —
 * permission must come from the user"). Such a command acts in the operator's name, on their cloud, their tickets,
 * their repositories, their packages: it is put to the operator in every run, an unattended one too, as a download is
 * (`network.ts`), unless Settings say to agree with what the bot proposes (`execution.questions: agree`).
 *
 * Read by the programs a line starts (`commandHeads`, as the shell reads it), not by words anywhere in it: a file
 * that mentions `az` is not a command to Azure.
 */
import { commandHeads, externalProgram, startProcessTargets } from './programs.js';
import { scanCommandHeads } from './commandHeads.js';

/** Platform command-line tools, by the program's name. */
const TOOLS: Record<string, string> = {
  az: 'Azure (az)',
  azd: 'Azure Developer CLI (azd)',
  func: 'Azure Functions (func)',
  aws: 'AWS (aws)',
  sam: 'AWS SAM (sam)',
  cdk: 'AWS CDK (cdk)',
  eb: 'AWS Elastic Beanstalk (eb)',
  eksctl: 'AWS EKS (eksctl)',
  gcloud: 'Google Cloud (gcloud)',
  gsutil: 'Google Cloud Storage (gsutil)',
  bq: 'Google BigQuery (bq)',
  gh: 'GitHub (gh)',
  glab: 'GitLab (glab)',
  jira: 'Jira (jira)',
  acli: 'Atlassian (acli)',
  vercel: 'Vercel (vercel)',
  netlify: 'Netlify (netlify)',
  heroku: 'Heroku (heroku)',
  fly: 'Fly.io (fly)',
  flyctl: 'Fly.io (flyctl)',
  firebase: 'Firebase (firebase)',
  doctl: 'DigitalOcean (doctl)',
  wrangler: 'Cloudflare (wrangler)',
  supabase: 'Supabase (supabase)',
  railway: 'Railway (railway)',
  kubectl: 'Kubernetes (kubectl)',
  helm: 'Kubernetes (helm)',
  oc: 'OpenShift (oc)',
  terraform: 'Terraform (terraform)',
  pulumi: 'Pulumi (pulumi)',
  serverless: 'Serverless (serverless)',
  sls: 'Serverless (sls)',
};

/** PowerShell modules that sign in to a platform or act on it, by the cmdlet's name. */
const CMDLETS: Array<[RegExp, string]> = [
  [/^(?:connect|disconnect)-azaccount$|^[A-Za-z]+-Az[A-Z]\w*$/, 'Azure (Az PowerShell)'],
  [/^(?:connect|disconnect)-azuread$|^[A-Za-z]+-AzureAD\w*$/, 'Azure AD (AzureAD PowerShell)'],
  [/^(?:connect|disconnect)-mggraph$|^[A-Za-z]+-Mg[A-Z]\w*$/, 'Microsoft Graph (PowerShell)'],
  [/^(?:connect|disconnect)-exchangeonline$|^(?:connect|disconnect)-ippssession$/, 'Exchange Online (PowerShell)'],
  [/^(?:connect|disconnect)-pnponline$|^[A-Za-z]+-PnP[A-Z]\w*$/, 'SharePoint (PnP PowerShell)'],
  [/^(?:connect|disconnect)-microsoftteams$/, 'Microsoft Teams (PowerShell)'],
  [/^(?:connect|disconnect)-msolservice$/, 'Microsoft Online (MSOnline PowerShell)'],
  [/^(?:set|initialize)-awsdefault\w*$|^set-awscredential$/, 'AWS (AWS Tools for PowerShell)'],
];

/** Package registries and image registries, written to: publishing, signing in, removing. */
const REGISTRIES: Array<[RegExp, string]> = [
  [/(?:^|[\s;|&(])(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?\s+(?:[^\s;|&]+\s+)*?(?:publish|unpublish|deprecate|login|adduser|logout|owner|token|dist-tag|access)\b/i, 'the npm registry'],
  [/(?:^|[\s;|&(])(?:docker|podman)(?:\.exe)?\s+(?:login|push|logout)\b/i, 'a container registry'],
  [/(?:^|[\s;|&(])dotnet(?:\.exe)?\s+nuget\s+(?:push|delete)\b|(?:^|[\s;|&(])nuget(?:\.exe)?\s+(?:push|delete)\b/i, 'NuGet'],
  [/(?:^|[\s;|&(])twine(?:\.exe)?\s+upload\b/i, 'PyPI (twine)'],
  [/(?:^|[\s;|&(])gem\s+(?:push|yank|signin)\b/i, 'RubyGems'],
  [/(?:^|[\s;|&(])cargo(?:\.exe)?\s+(?:publish|yank|login)\b/i, 'crates.io'],
];

/** The platform tools, by program, as the card names each (for Settings' list of programs, 2026-10-26). */
export function platformTools(): Record<string, string> {
  return { ...TOOLS };
}

/** The platform a program reaches, as the card names it, or null. */
export function platformOf(program: string): string | null {
  return TOOLS[program.toLowerCase()] ?? null;
}

/**
 * The platform a command reaches with the operator's access, as the card names it, or null. `Connect-AzAccount` is
 * Azure; `npm publish` the npm registry; `az login; gh repo list` the first one met. `reading`: programs set to read
 * only whose every command on this line only reads (`readOnly.ts`), which are not asked about.
 */
export function platformReason(command: string, shell?: string, reading?: ReadonlySet<string>): string | null {
  for (const head of commandHeads(command, shell)) {
    const program = externalProgram(head);
    if (program && reading?.has(program.toLowerCase())) continue;
    if (program && TOOLS[program.toLowerCase()]) return TOOLS[program.toLowerCase()]!;
    const bare = head.replace(/^.*[\\/]/, '').replace(/^['"]|['"]$/g, '');
    // Cmdlets are matched as written (`Get-AzVM`, not `get-azvm`, keeps Az apart from words that start so), and
    // case-insensitively for the verbs that sign in.
    for (const [pattern, name] of CMDLETS) if (pattern.test(bare) || pattern.test(bare.toLowerCase())) return name;
  }
  /*
   * What a package runner or Start-Process starts (audit, 2026-10-27): `npx vercel deploy`, `npm exec -- vercel`,
   * `pnpm dlx netlify deploy`, `Start-Process gh -ArgumentList …` reach the platform as the program itself does.
   */
  for (const program of startedPrograms(command, shell)) {
    if (reading?.has(program)) continue;
    if (TOOLS[program]) return TOOLS[program]!;
  }
  for (const [pattern, name] of REGISTRIES) if (pattern.test(command)) return name;
  return null;
}

const RUNNERS: Record<string, ReadonlySet<string> | null> = { npx: null, pnpx: null, bunx: null, npm: new Set(['exec', 'x']), pnpm: new Set(['exec', 'dlx']), yarn: new Set(['exec', 'dlx']) };

/** The programs a package runner and Start-Process are given to start, by name. */
function startedPrograms(command: string, shell?: string): string[] {
  const out: string[] = [];
  const name = (word: string): string => word.replace(/^.*[\\/]/, '').replace(/^['"]|['"]$/g, '').replace(/\.(?:exe|cmd|ps1)$/i, '').replace(/@[^@/]*$/, '').toLowerCase();
  for (const call of scanCommandHeads(command, shell ?? 'pwsh').calls) {
    const runner = name(call.head);
    if (!(runner in RUNNERS)) continue;
    let args = call.args.map((a) => a.literal);
    const words = RUNNERS[runner];
    if (words) {
      if (!words.has((args[0] ?? '').toLowerCase())) continue;
      args = args.slice(1);
    }
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '--') continue;
      if (a.startsWith('-')) {
        if (/^(?:-p|--package)$/.test(a)) out.push(name(args[++i] ?? ''));
        continue;
      }
      out.push(name(a));
      break;
    }
  }
  for (const target of startProcessTargets(command)) out.push(name(target));
  return out.filter(Boolean);
}
