# copilot-operator

A Windows bot that runs a task loop with Microsoft 365 Copilot.

Copilot decides what to do, the bot does it and reports back, and the two keep going until
Copilot says the task is finished. The bot drives the real Copilot web app in a real Edge
browser, so it needs no API licence and no admin consent.

> **Status: working, every part verified against a live Microsoft 365 Copilot tenant.**
> The loop, chat naming, reply parsing, command execution and the results file are confirmed.
> A step printing for 92 s survived while a silent one was stopped at its idle limit. Unattended
> mode is the one thing still untried, deliberately.

## What it does

1. Opens a conversation and sends **level 1**, the base prompt about how the runner works: phases, json
   format, stop word, the final summary, the rules nothing else can override.
2. Sends **level 2**, the user's instructions for the project and the team, together with
   the **task**.
3. Reads Copilot's reply and parses a strict JSON block out of it. A reply that does not
   match is sent back with the reason.
4. Runs the commands in PowerShell or `cmd`, in order, capturing stdout, stderr and exit codes.
   Commands are the only thing it runs: nothing the chat attaches is fetched, saved or executed.
5. Writes the whole terminal output to a `.txt` file and attaches it to the chat.
6. Repeats until Copilot finishes with a **summary** of what it did and what the result is.
7. Runs the next queued task in the same conversation.

A **session** is one conversation with a queue of tasks. No file of the project is attached to
the chat: it reads the project by running commands in the project folder, like any other step.

There is a web UI for all of this, and a terminal command for a single task.

## Safety

The bot executes commands written by a language model — commands only; it has no way to take a
file from the chat. Confirm mode is on by default: every step is shown and waits for a keypress.
Unattended mode is behind an explicit flag and its own preconditions. There is a deny list, a
per-step timeout and an iteration cap. Everything a step prints goes to the chat as a file, so
secret-shaped strings — tokens, keys, passwords in assignments and URLs, private key blocks —
are redacted from every report before it is uploaded, always, with `report.redactPatterns`
applied on top. Running it in a dedicated Windows account or Windows Sandbox is recommended.

**Where the reports go.** Every report — the terminal output of every step, the check results,
the reviewer's transcripts — are uploaded into the
Copilot chat, which stores them in the signed-in account's OneDrive for Business and in the
Copilot conversation history. They stay inside the company's own Microsoft 365 tenant, under its
Purview DLP policies, sensitivity labels, retention and eDiscovery; nothing goes to any other
service. A company deploying this should tell its data-protection and DLP teams so, and set
`runsRetentionDays` so the local copies under `runs/` follow the same retention rule. The run
log says it at the start of every run.

### What it will not run

Some things are refused whatever the task or the configuration says, because a security team
watching the machine cannot tell this tool's use of them from an attacker's, and would be right
not to try. The list lives in `src/exec/dangerous.ts`, is not part of the configuration schema,
and cannot be edited away; `execution.denyPatterns` is the operator's own list and is applied on
top of it — it can add, never subtract.

| Refused | The ordinary way instead |
|---|---|
| `certutil`, `bitsadmin` | read or convert files with PowerShell in a step of their own |
| `wscript`, `cscript`, `mshta` | run the tool itself; never `.js`, `.vbs` or `.hta` as code |
| `regsvr32`, `rundll32`, `installutil`, `forfiles` | call the program directly |
| `-EncodedCommand`, base64 decoded into code, `Invoke-Expression` | write the command out in full |
| fetching code and running it in one line (`iwr … \| iex`) | write the commands as steps |
| running anything out of `%TEMP%` | work inside the project folder |
| antivirus exclusions, scheduled tasks, Run keys, new services | nothing here should outlive the run |
| opening a file or URL through its registered handler (`Invoke-Item`, `Start-Process` on a document) | start the program by name |
| writing under `.git\`, or `git config <key> <value>` | the runner owns the repository; read history with git |
| reaching the runner itself (its ports, its data folder, its key) | nothing: the bot is not part of the task |

Every step is a command and every command is read in full before it runs, so there is nowhere for
any of this to arrive unread. A name hidden rather than written — a caret or empty quotes inside a
word, a name assembled from pieces, one resolved by wildcard — is refused as the hiding it is. A
script a step runs with `pwsh -File` is read from disk at the gate and held to the same rules; a
step that writes a script and runs it in the same line is refused, so that the file read is the
file run. What `Start-Process` is asked to start is judged like any other program on the line.

**Nothing is downloaded on the bot's own account.** A step that fetches from the internet —
`Invoke-WebRequest`, `Invoke-RestMethod`, `curl`, `wget`, `Start-BitsTransfer`, the .NET web
clients, `ftp`/`scp`, a package named by URL or git address, `npx` of a tool not installed in the
project, `docker pull` — is neither refused nor run: it waits on the approval screen, in every
mode, unattended included, and "run the rest without asking" does not answer it. That is the
default, and the one stop an unattended run still makes; `execution.networkFetch` (Settings →
Execution) may instead **refuse** it back to the chat with the reason, so the run never waits, or
**run** it unread on a machine where that is acceptable. The choice applies only to unattended
runs, and each task's policy manifest records which was in force. A check that
fetches is refused, since a check runs with nobody asked. Requests to this machine (`localhost`,
`127.0.0.1`) and the project's own package managers are not held. `npm install` runs with
`ignore-scripts`: a package's install script is code fetched and executed unread, and it does not
run here.

**A step sees a named environment, not the bot's.** Commands are given the variables Windows and
the toolchains need (`src/exec/stepEnv.ts`) plus whatever `execution.passEnv` names — never the
API token, never whatever else the operator's shell held. The runner's own git runs with hooks,
fsmonitor and optional locks off, so nothing a task placed in the repository runs as the runner.

### How a run is regulated

Six rules decide what a step may do, and each is recorded with the run that it governed:

- **Say where the bot runs, and an unattended run needs an answer.** `execution.isolation` is what
  you have arranged — `none`, `separate-account`, `sandbox` or `vm` — and it defaults to `none`,
  because that is the truth on a machine where nobody has arranged anything. It is recorded as a
  claim, never as a finding: a process cannot see the boundary it is inside. Beside the claim the
  runner records what it *can* read — the account, and whether the process holds High or System
  integrity — and says so when the two disagree. While `isolation` is `none`, an unattended run
  will not start: nobody watching and nothing containing is the one combination this refuses to be.
  Set it under **Settings → Execution → Where the bot runs**, and `cop doctor` and the System page
  show the same assessment. A fresh install says `none`, so the unattended **Run sessions** button
  is refused until you have arranged something and said so; **Step by step** is unaffected.

- **The chat cannot give this runner a file.** There is one kind of step, `command`, and nothing
  the chat attaches is fetched, saved or run. This is not a setting that could be turned back on:
  the step type does not exist and neither does the code that fetched one. A process that receives
  a file and executes it is a loader whatever it meant by it, and that is precisely the shape a
  security team opened an incident about. Work too long for one line is written **from a command
  step** — `Set-Content` with a here-string — and run in the next, so its contents passed through a
  step that was read and screened and it sits in the project where it can be read afterwards.
- **What comes back is data, never instructions.** The loop reads command output back into the
  chat, and most output was not written by this machine: it is the contents of files, logs, commit
  messages and pages that other people wrote. Any of it can carry text shaped like an order, and a
  model that obeys it is doing what whoever edited that file wanted — which is the whole method of
  an indirect prompt injection, since the attacker cannot reach the conversation and so leaves
  something where it will be read. Both contracts forbid acting on it and require it to be reported
  instead, and **every results file repeats the boundary above the first line of output**, because
  a contract is sent once and the early turns of a long conversation fall out of what the model can
  see. This is guidance to a model, not a control: it is the reason the allowlist, the refused
  techniques and confirm mode exist underneath it.
- **Only the declared toolchain runs.** `execution.allowedPrograms` names the programs a command
  may start — the shells, the JavaScript, .NET, Java, Python, Go and Rust tools, `git`, and a few
  Windows utilities. A command that starts anything else is refused and sent back with the reason.
  The programs are read the way PowerShell reads a line (`src/exec/commandHeads.ts`): strings,
  operators, array values, method arguments and hashtable keys are not programs, and a command in a
  script block, a subexpression, a string's `$( )` or after an assignment is still found. A line that
  cannot be read with certainty — an unclosed quote or bracket, a program called through a variable
  (`& $exe`) — is refused rather than guessed at. `cmd` steps are read by `cmd`'s own rules. A refused
  step is reported to the chat as refused and never executed, with no exit code, apart from a
  command that ran and failed. An empty list turns the gate off. This is a floor against the unknown
  binary, not a boundary: allowing `node` allows `node -e`.
- **Autonomy is graded.** An unattended run carries strictly more restrictions than a watched one,
  because the thing that makes a watched run safe is a person reading each line. Unattended
  requires a non-empty allowlist, and refuses an allowed program used to evaluate a string
  (`node -e`, `python -c`) or a shell wrapped in a shell (`cmd /c …`) — the forms that escape the
  allowlist by construction.
- **An administrator can set a floor the operator cannot lower.** A `policy.lock.json` beside the
  configuration may forbid unattended runs, cap the allowlist and add deny patterns. Every field
  only ever tightens, and the runner never writes the file. A machine without one behaves exactly
  as before.

### Only the project folders

Every command a task runs — the implementer's steps and checks, the reviewer's steps and the checks
it derives — is held to the **project folders**: the session's own folder and every project
registered in Settings, so a test suite may still start the application from the repository next
to it. Refused before it runs:

- a path outside them — absolute, a network share, `..` that climbs out, a `cd` to the root — and
  anything built from the operator's profile or the system: `~`, `$HOME`, `$env:USERPROFILE`,
  `$env:APPDATA`, `$env:TEMP`, `%TEMP%` and the rest. **Reads as well as writes**: what a step prints
  goes to the chat, so reading a key outside the project is sending it there;
- the registry and the other drives that are not files (`HKLM:`, `HKCU:`, `Cert:`);
- managing the computer: services, the network and firewall, local users, the clock, Windows
  features, disks, machine-wide PowerShell modules;
- installs that land outside the project — `npm -g`, `dotnet tool -g`, `cargo install`,
  `go install`, `pip install` into the machine's Python. The same tools installed into the project
  (`npm install -D`, a local tool manifest, a `.venv`) stay open.

A check's own folder and the file a file check reads are held to the same folders, and a relative
file path is read from the project rather than from wherever the runner was started. A check the
reviewer derives that reaches outside is dropped rather than kept: the finding stands, the check
does not. Every run records the folders it was confined to in its `policy.json`.

**What this cannot do.** It reads what a step *says*, which is exactly the point — whatever the chat
proposes that reaches outside the project is not run. It cannot see what a program does once it is
running: `node build.js`, `npm run x` and a test suite can read and write anywhere the account can,
and so can a path assembled from variables at run time. That confinement is the operating system's
to give, and it is the real one:

1. Create a **standard** (not administrator) local Windows account for the bot, and sign it in to
   Copilot once with `cop login`.
2. Give it modify rights on the project folders and nothing else:
   `icacls "C:\Projects\my-app" /grant botuser:(OI)(CI)M`.
3. **Check what it already has.** Folders created directly under `C:\` usually let every signed-in
   user modify them by default, which would hand the bot every project there, not just yours to
   give. Look with `icacls C:\Projects` and remove the broad grant where it should not be.
4. Your own profile — `.ssh`, the browser, OneDrive — is private to you by default; confirm the bot
   account cannot open `C:\Users\<you>`.
5. Run the bot as that account, and set **Settings → Execution → Where the bot runs** to
   *A separate low-privilege Windows account*.

Windows Sandbox, with only the project folders mapped in, gives the same guarantee with less to set
up and nothing left behind.

### The local API is not open to everything on the machine

The API binds `127.0.0.1` only, and that was once taken to mean it needed no authentication. It
did. Two callers were always reachable: any page the operator has open in their ordinary browser,
which can issue requests to `127.0.0.1:4000` — CORS stops it reading the reply, which is no comfort
once a request has started a session — and any other process on the machine. So every request is
checked three ways before it reaches a route:

- the **`Host`** header must name this loopback port, which is what catches DNS rebinding — the
  attacker's domain made to resolve to `127.0.0.1` is same-origin to the browser but still carries
  its own name here;
- a present **`Origin`** must be the configured UI, since only a browser sets it and a page cannot
  forge it;
- a per-install **token**, generated on first start into `data/api-token` (git-ignored), sent as
  `Authorization: Bearer`, `x-cop-token`, or a `token` query parameter for the two cases that
  cannot carry a header — `EventSource` and a plain `<a download>`.

`npm start` creates the token before either process starts and hands it to the web process only —
not to the API, whose environment command steps used to inherit, so a step never sees it; a step
that names the API's or the UI's port is refused. The web server binds `127.0.0.1` only. `GET /api/health` stays open so that "is it up yet" is still
answerable. To rotate the token, delete the file and restart.

The `data` folder — token, settings, sessions, the level-1 contract — is narrowed at start to the
operator's account and SYSTEM, and the API refuses to start while any other account can open it:
under `C:\Projects` a folder otherwise inherits *Authenticated Users: Modify*, which is every
account on the machine. A step never sees the token (see above) and is refused for naming the API's
ports or the data folder.

This does not contain a process already running as the operator — nothing at this layer can, since
that process can read the file. It moves the API from "anything on this machine, and several things
off it" to "the operator's own account, through a browser that was handed the key".

Every task writes `policy.json` into its run folder and a `POLICY` block into its log: the mode,
the allowlist and its digest, that the chat cannot supply files, digests of the deny list and of the
built-in refusals, whether a lock was in force and what it changed, and the account the run used.
So "what was this permitted to do at the time" is answered from the run folder rather than from a
configuration file that has been edited since.

### Before a company deploys it

A compliance review against the common frameworks (CIS Controls v8, NIST SP 800-53, ISO/IEC
27001 Annex A, the Microsoft baselines) was run on 2026-09-27. Nothing in the software is a
hidden mechanism; what follows is what a company has to decide, approve or configure before it
runs this on managed laptops, because no code change can decide it for them.

**Approvals to obtain.**

- *Identity and licensing.* The bot drives a licensed person's Microsoft 365 Copilot through
  Edge, not through the API. Microsoft documents the API as the supported way to automate
  Copilot; driving the web client is not documented as supported, and a per-user licence is
  not meant to be shared or driven by a service identity. Ask the Microsoft contact whether the
  intended use is acceptable under the licence, and decide which person's identity signs in —
  one licensed identity per operator, never a shared one. Every prompt, upload and Purview
  record is attributed to that identity.
- *Conditional Access.* The bot's Edge runs a profile of its own under
  `%LOCALAPPDATA%\copilot-operator`, started by `node.exe` with Playwright's debugging channel.
  A tenant's sign-in frequency, compliant-device and managed-browser policies may refuse it or
  pause it for sign-in; and an Edge policy that forbids remote debugging or forces extensions
  stops it outright. Test on one managed device before rolling out; where the baseline cannot
  be relaxed, run it in a VM or Windows Sandbox outside the baseline's scope.
- *Data protection.* See "Where the reports go" above. Where the law requires it, record the
  processing (a DPIA where automated tooling that stores every command's output and sends it to
  an AI service triggers one; works-council consultation where tooling that records employees'
  actions requires it). Command output can carry personal data from fixtures and exports.
- *AI-use policy.* Commands written by a language model execute on the endpoint. Confirm mode
  keeps a person on every line; unattended mode removes that person and is the decision most
  AI-governance policies want recorded. `policy.lock.json` can forbid it machine-wide.
- *Security operations.* Tell the SOC what to expect: `node.exe` starting PowerShell (every
  step, as `-Command` text, which PowerShell logging records verbatim) and `taskkill`; Edge
  started by `node.exe` over a debugging pipe; updates pulled from a git remote. Register the
  install so the process chain is known rather than investigated.

**Configuration to set** — as an administrator, in `%ProgramData%\copilot-operator\policy.lock.json`,
which the operator cannot edit (the same file beside the install is honoured too):

```json
{
  "maxMode": "confirm",
  "requireIsolation": true,
  "passEnv": [],
  "allowedPrograms": ["pwsh", "powershell", "cmd", "node", "npm", "npx", "git", "dotnet"],
  "update": { "requireSigned": true, "remote": "https://git.example.com/tools/copilot-operator.git" }
}
```

Every field only tightens; `update` makes `npm run update` insist on signed commits and refuse
any other remote. Keep `data/` and `runs/` on a local disk (`COP_DATA_DIR`, `runsDir`), set
`runsRetentionDays`, and fork the repository internally so updates come from a remote the
company controls.

**Keeping it patched.** Dependencies are pinned in `package-lock.json`; `npm audit` reports
known vulnerabilities in them, and `npm run update` brings in whatever the remote has fixed.
Node.js and Edge are patched by the machine's own update process. Nothing here watches for
end-of-support runtimes — that is the deploying company's asset management.

**Stopping it.** "Stop" on a session cuts in after the current step and ends the task
`aborted`; "Pause" lets the task in flight finish and holds the queue. Ctrl+C in the `npm start`
terminal stops the API and the UI; processes a step started are stopped with the task (asked
first, forced after a few seconds), and the run log names any it could not. To end the bot's
access: `cop logout` signs its profile out, deleting `data/api-token` and restarting rotates the
API key, `cop login --fresh` deletes the profile.

**Where it does not fit.** On a fleet that enforces PowerShell Constrained Language Mode the
bot's own probes degrade gracefully (permissions are read through `Get-Acl`; elevation reads as
unknown), but the model's steps themselves run constrained, and most builds will not. That is a
fleet to run the bot outside of, in a VM, not one to request exceptions on.

### What an update trusts

`npm run update` fetches commits, fast-forwards onto them, installs what the lockfile names and
builds the result — and that result is the thing that runs commands on this machine. Its trust
boundary is one sentence: **whoever controls the remote controls this bot.** Three things make that
checkable rather than implied.

- **The remote is pinned.** The address a checkout last updated from is recorded in
  `data/update-remote`. If `origin` now points somewhere else the update stops before anything is
  fetched, prints both addresses, and asks. Trust on first use — the first update records what is
  there. Accept a deliberate move with `npm run update -- --accept-remote`.
- **Signatures, if your fork has them.** `npm run update -- --require-signed` refuses a HEAD that
  git cannot verify, and tells an unsigned commit apart from a bad signature. Off by default,
  because this project does not sign its commits and a check that always fails is a check that gets
  removed; it is here so an organisation whose fork *is* signed can make it mean something.
- **Every update is written down.** A line in `data/update-log.jsonl`: when, from which remote,
  which commit to which, how many came in, and whether a signature was demanded. `data/` is
  git-ignored, so the record survives the pull it describes.

None of this verifies what the code *does*. A signed commit from a compromised maintainer is a
signed commit. It narrows "anything that can reach the network" to "whoever holds the remote this
checkout was installed from", and says so out loud.

**The honest limit.** Everything above except the first rule is pattern matching and configuration.
It raises the cost of the ordinary accident and the ordinary injected instruction; it is not a
security boundary, and a determined attacker with a language model to write for them will find a
phrasing none of it anticipated. The boundary is the first rule — a separate low-privilege Windows
account, Windows Sandbox or a VM — and the runner can record whether you have arranged one, refuse
to run unwatched until you have, and never do it for you.

## Requirements

- Windows 10 or 11
- Node.js 20 or newer
- Microsoft Edge, already installed
- A Microsoft 365 Copilot account, signed in once by the user

## Installing it in a project

```bash
npm install --save-dev copilot-operator
npx cop login --account you@tenant.org   # sign in once; the Edge profile is reused across projects
npx cop start --open                     # the API and the interface, on http://127.0.0.1:4000/
```

Installed this way, the bot belongs to the project it is installed in. Its records — settings,
sessions, the API key, every run's logs — go to `.copilot-operator/` in the project, which carries
its own `.gitignore`, so the project's git never sees it and the bot's version control finds a
clean tree. The interface ships prebuilt and is served by the same process on one port; there is no
second server and nothing is compiled on the machine. `npx cop start --port 4100` picks another
port. `npm update copilot-operator` updates it; `npm run update` is for a clone.

**Keeping it out of the project's repository.** A dev dependency is recorded in `package.json`
and the lock file, which are committed. To leave the project untouched, install it globally and
start it from the project's folder — the folder it is started from is the project:

```bash
npm install --global copilot-operator
cd C:\path\to\your-project
cop start --open
```

Nothing in the project changes except `.copilot-operator/`, which git does not see. The bot's own
code is then outside the folders its steps may write, which is the safer of the two.

The bot is then inside the folders its own steps may write, so a step that reaches for
`node_modules/copilot-operator`, for `.copilot-operator`, or that installs, updates or removes the
bot as a package is refused. What no rule can see is a step that rewrites the project's
`package.json` with a different version of the bot for a later `npm install` to fetch; the commit
the bot makes after the task shows such a change, and it is worth a look before the next install.

## Releasing a new version

Publishing is done by GitHub Actions (`.github/workflows/publish.yml`), not from a laptop:

```bash
npm version patch          # or minor / major: updates package.json, commits, tags vX.Y.Z
git push --follow-tags     # the tag starts the workflow: typecheck, checks, build, publish
```

The workflow publishes with npm's Trusted Publishing — no npm token is stored anywhere; npm accepts
the package because it comes from this repository's `publish.yml` — and with provenance, so the
package page on npm says which commit and which run built it. Set up once, after the first manual
`npm publish`: on npmjs.com, the package's **Settings → Trusted Publisher → GitHub Actions**, with
repository `ivan-markov-666/copilot-operator` and workflow `publish.yml`. A tag whose version does
not match `package.json` stops the workflow before anything is built.

## Working on it from a clone

```bash
npm install                                          # root and the web workspace
npx tsx src/cli.ts login --account you@tenant.org    # sign in once; the Edge profile is reused
npx tsx src/cli.ts doctor                            # check the machine
```

The bot never types credentials. `login` opens Edge, waits for the chat to appear, checks
that the right account is signed in, and stores nothing but the browser profile.

### The web UI

```bash
npm start        # builds the API, then runs it and the UI together; Ctrl+C stops both
```

Then open http://localhost:3210. `npm run dev` does the same and opens the browser for you.
The two can also run separately: `npm run api` (NestJS on 127.0.0.1:4000) and `npm run web`
(Next.js on localhost:3210).

Create a session, add tasks with their level 2 instructions, press Run, approve each step
from the page, read the summary when it finishes. See [`docs/ui.md`](docs/ui.md).

### Removing it from a machine

Nothing is installed system-wide, nothing runs at start-up, no service and no scheduled task
exist. What the software leaves, and where:

| What | Where | Remove |
|---|---|---|
| settings, sessions, the API token, level-1 and context texts | `data/` in the checkout | delete the folder |
| every run's logs, reports and failure screenshots | `runs/` in the checkout | delete the folder (or set `runsRetentionDays`) |
| backups taken by `npm run update` | `data-backups/` in the checkout | delete the folder |
| the bot's own Edge profile, with its Microsoft 365 session | `%LOCALAPPDATA%\copilot-operator\edge-profile` | sign out in that window (`cop login --fresh` deletes it) and delete the folder |
| the API key the browser was handed | the browser's storage for `localhost:3210` | clear site data for that origin |
| logs saved on request | `Desktop\copilot-operator-logs` | delete them; they may already be in OneDrive |
| the project copies of versions before 0.1.14 | `Desktop\copilot-operator-context` | delete the folder; nothing writes to it any more |
| the reports uploaded to Copilot | the account's OneDrive and Copilot chat history | delete the conversations, or let the tenant's retention run |
| a machine-wide policy lock, if an administrator placed one | `%ProgramData%\copilot-operator\policy.lock.json` | the administrator removes it |

The permissions the API set on `data/` and `runs/` (owner and SYSTEM only) go with the folders.

### Updating a machine that has been used

```bash
npm run update              # back up, pull, install, build
npm run update -- --check   # say what would happen, change nothing
```

**A pull cannot lose what you have entered.** Everything this program records lives in `data/`
(settings, sessions, level 2 presets, a customised level 1, the organisation and work texts, the
model list) and `runs/` (every log, report and artifact of every task). Both are in `.gitignore`,
every write in `src/` goes to one of them or to the Desktop, and git does not know they exist.

What a pull *can* do is refuse to start. `npm run update` deals with each reason in turn: it
copies `data/` to `data-backups/<timestamp>/` before touching anything, refuses to run while the
bot is (swapping the code under a run in flight is the one thing here that could really break
something), puts any local edits to tracked files into a named stash and tells you the command to
get them back, pulls **fast-forward only** so no merge is ever made on your behalf, and then
reinstalls and rebuilds — because a `dist/` older than its `src/` runs the previous version and
reports the previous version's bugs.

Run it with `--check` first if you want to see what it would do. When nothing has come in it
installs and builds nothing; `--rebuild` forces both. It uses `npm ci`, and only when the pull
actually moved a dependency: `npm install` may rewrite `package-lock.json`, and a rewritten
lockfile is a tracked file that differs from the commit — which is one of the phantom local
changes this is here to stop.

**`npm warn allow-scripts ... esbuild`** on a machine whose npm requires install scripts to be
approved is expected and usually harmless. esbuild gets its Windows binary from an optional
dependency (`@esbuild/win32-x64`), which installs without any script; the blocked `postinstall`
only revalidates it. Check with `npx tsx --version` — if that answers, `npm run check` will run.
If it does not, `npm approve-scripts esbuild` and install again.

If files looked modified that you never edited, that was line endings: two Windows machines, one
with `core.autocrlf` set and one without. `.gitattributes` settles it.

### The terminal, for one task

```bash
cp run.example.yaml run.yaml                # then edit it
npx tsx src/cli.ts run run.yaml
```

### Commands

| Command | What it does |
|---|---|
| `cop login` | opens Edge with the bot profile and waits for you to sign in |
| `cop doctor [run.yaml]` | checks Node, Edge, PowerShell, the Desktop, the config |
| `cop run <run.yaml>` | one task as a new session; `--unattended` skips the per-step prompt |
| `cop chat [run.yaml]` | prints the last run's conversation name and link |

Before it is built, run them as `npx tsx src/cli.ts <command>`.

**Testing it for the first time:** follow [`docs/testing.md`](docs/testing.md). Nine steps,
ordered so the risk climbs slowly, starting with checks that need no account at all.
`run.smoke.yaml` is a ready-made read-only first run.

## How it works

| Piece | File | State |
|---|---|---|
| DOM locators for the Copilot web app | `src/transport/locators.ts` | captured from the live app |
| Command runner, dual timeouts, process-tree kill | `src/exec/runner.ts` | implemented, checked |
| Chat naming and reattach after re-login | `src/transport/chatSession.ts` | implemented, checked |
| Covering message for the results file | `src/protocol/reporter.ts` | implemented, checked |
| Desktop folder resolution (for saved logs) | `src/context/desktopDir.ts` | implemented |
| Pacing, send cap, backoff | `src/util/pacing.ts` | implemented, checked |
| Playwright transport | `src/transport/copilotTransport.ts` | implemented; selectors verified live |
| Reply parser and the JSON contract | `src/protocol/parser.ts`, `replySchema.ts` | implemented, checked |
| Report file, splitting, redaction | `src/exec/reportFile.ts` | implemented, checked |
| Deny list and the confirm gate | `src/exec/policy.ts` | implemented, checked |
| Config schema and loader | `src/config/schema.ts` | implemented |
| The loop, per task and per session | `src/orchestrator/taskRunner.ts` | run live end to end |
| Sessions, tasks, level 2 presets on disk | `src/session/` | implemented, checked |
| API | `src/api/` (NestJS) | implemented, exercised over HTTP |
| Web UI | `web/` (Next.js) | implemented |
| CLI | `src/cli.ts` | implemented |

Design and findings:

- [`docs/ui.md`](docs/ui.md) — the web UI, the API and the session model
- [`docs/testing.md`](docs/testing.md) — how to test it the first time, step by step
- [`docs/architecture.md`](docs/architecture.md) — the whole design
- [`docs/locators-findings.md`](docs/locators-findings.md) — what the live Copilot DOM looks like and why
- [`docs/tech-stack-research.md`](docs/tech-stack-research.md) — why Playwright and not the alternatives
- [`docs/deferred.md`](docs/deferred.md) — designed, argued and deliberately not built yet, with the reasoning kept

### What the planning persona knows

The brief the UI hands to a chat model — the Kerrigan persona — carries the names of this
application's own screens and controls, so it can tell the operator to press "Create the sessions
and tasks" rather than "import the plan". They live in `src/plan/systemGuide.ts` and are embedded
in the brief by `src/plan/brief.ts`, and `test/guide.check.ts` pins every one of them to
`web/lib/strings.ts` in both languages. Renaming a control in the interface therefore breaks that
check by name, and a new control the operator would ever be told to press has to be added to the
guide as well, or the persona does not know it exists. The same check reads the pages themselves,
so a label that is still in the dictionary but that nothing renders any more fails too, and it
holds the labels the brief quotes in its own prose to the same standard.

## Notable findings

These cost real investigation and are worth knowing before touching the code.

- **Code blocks cannot be read from the DOM.** They are virtualized and interleave line
  numbers with the code. A valid JSON reply came back from `innerText` with a chunk missing.
  The message-level "Copy Response" button plus clipboard access is the only safe read.
- **Downloads are plain anchors** with a `blob:` href and a `download` attribute, which is
  why nothing useful appears on hover. Playwright's download event handles them.
- **Enter does not send.** The composer is a contenteditable span; the Send button must be
  clicked.
- **A message cannot be only an attachment.** Text is mandatory, so the covering message is
  part of the protocol rather than decoration.
- **Uploads go through the user's OneDrive.** The chat says so, and the attachment id carries
  an `SPO_` prefix. That prefix is also the most reliable "upload finished" signal.
- **Copilot destroys `[name]:` in its own output.** `[math]::Round($x, 2)` reaches the
  runner as `:Round($x, 2)`, even inside a fenced code block, because `[label]:` is markdown
  for a link reference. `[pscustomobject]` and `[double]$x` survive, since the damage needs
  the colon. The prompts forbid that form and the runner refuses a command that arrives
  wrecked rather than executing something nobody wrote.
- **`lastChatMessage` is not the whole answer.** It is the answer body; the copy button is
  its sibling. A wait built on `[data-testid="lastChatMessage"] [data-testid="CopyButtonTestId"]`
  never completes. The anchor is the last `copilot-message-div`.

## Checks

```bash
npm run check          # all of them
```

Each one prints what it exercised rather than asserting silently, so a failure is readable.
There is no live-tenant test: that is the part that needs a human and a signed-in browser.

## Related

[context-picker](https://github.com/ivan-markov-666/context-picker) (MIT) — the same author's
VS Code and Visual Studio extension for picking which project files an LLM should see. This
project follows its file-naming convention, so the two produce interchangeable folders, and
can drive it directly for per-file selection.

## Licence

MIT. See [`LICENSE`](LICENSE).
