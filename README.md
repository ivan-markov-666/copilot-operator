# copilot-operator

A Windows bot that runs a task loop with Microsoft 365 Copilot.

Copilot decides what to do, the bot does it and reports back, and the two keep going until
Copilot says the task is finished. The bot drives the real Copilot web app in a real Edge
browser, so it needs no API licence and no admin consent.

> **Status: working, every part verified against a live Microsoft 365 Copilot tenant.**
> The loop, chat naming, reply parsing, command execution and the results file are confirmed.
> A step printing for 92 s survived while a silent one was stopped at its idle limit. A script
> Copilot generated was downloaded, hashed, executed and its output read back. Project files
> mirrored to the Desktop were attached and answered questions from. Unattended mode is the
> one thing still untried, deliberately.

## What it does

1. Opens a conversation and sends **level 1**, the base prompt about how the runner works: phases, json
   format, stop word, the final summary, the rules nothing else can override.
2. Sends **level 2**, the user's instructions for the project and the team, together with
   the **task**.
3. Reads Copilot's reply and parses a strict JSON block out of it. A reply that does not
   match is sent back with the reason.
4. Downloads any script Copilot attached to the chat.
5. Runs the commands in PowerShell or `cmd`, in order, capturing stdout, stderr and exit codes.
6. Writes the whole terminal output to a `.txt` file and attaches it to the chat.
7. Repeats until Copilot finishes with a **summary** of what it did and what the result is.
8. Runs the next queued task in the same conversation.

A **session** is one conversation with a queue of tasks. Selected parts of a project can be
mirrored to a Desktop folder and attached, so the chat can see the code it is asked about.

There is a web UI for all of this, and a terminal command for a single task.

## Safety

The bot executes commands and scripts written by a language model. Confirm mode is on by
default: every step is shown and waits for a keypress. Unattended mode is behind an explicit
flag. There is a deny list, a per-step timeout, an iteration cap, and every downloaded file
is hashed into the run log. Everything a step prints goes to the chat as a file, so
secret-shaped strings — tokens, keys, passwords in assignments and URLs, private key blocks —
are redacted from every report before it is uploaded, always, with `report.redactPatterns`
applied on top. Running it in a dedicated Windows account or Windows Sandbox is recommended.

### What it will not run

Some things are refused whatever the task or the configuration says, because a security team
watching the machine cannot tell this tool's use of them from an attacker's, and would be right
not to try. The list lives in `src/exec/dangerous.ts`, is not part of the configuration schema,
and cannot be edited away; `execution.denyPatterns` is the operator's own list and is applied on
top of it — it can add, never subtract.

| Refused | The ordinary way instead |
|---|---|
| `certutil`, `bitsadmin` | read or convert files with PowerShell; download in a step of its own |
| `wscript`, `cscript`, `mshta` | run the tool itself; never `.js`, `.vbs` or `.hta` as code |
| `regsvr32`, `rundll32`, `installutil`, `forfiles` | call the program directly |
| `-EncodedCommand`, base64 decoded into code, `Invoke-Expression` | write the command out in full |
| fetching code and running it in one line (`iwr … \| iex`) | write the commands as steps |
| running anything out of `%TEMP%` | work inside the project folder |
| antivirus exclusions, scheduled tasks, Run keys, new services | nothing here should outlive the run |

The same screening reads the *contents* of a script before it is started, not only its name, and
a name hidden rather than written — a caret or empty quotes inside a word, a name assembled from
pieces, one resolved by wildcard — is refused as the hiding it is.

### How a run is regulated

Five rules decide what a step may do, and each is recorded with the run that it governed:

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

- **Files are data, not code.** A file the chat attaches is downloaded, hashed and kept. It is
  *not* executed: `execution.allowRunningDownloads` is off by default, and while it is off no
  reply can cause an attachment to run, whatever the step asks for.
- **Only the declared toolchain runs.** `execution.allowedPrograms` names the programs a command
  may start — the shells, the JavaScript, .NET, Java, Python, Go and Rust tools, `git`, and a few
  Windows utilities. A command that starts anything else is refused and sent back with the reason.
  An empty list turns the gate off. This is a floor against the unknown binary, not a boundary:
  allowing `node` allows `node -e`.
- **Autonomy is graded.** An unattended run carries strictly more restrictions than a watched one,
  because the thing that makes a watched run safe is a person reading each line. Unattended
  requires a non-empty allowlist, and refuses an allowed program used to evaluate a string
  (`node -e`, `python -c`) or a shell wrapped in a shell (`cmd /c …`) — the forms that escape the
  allowlist by construction.
- **An administrator can set a floor the operator cannot lower.** A `policy.lock.json` beside the
  configuration may forbid unattended runs, cap the allowlist, force downloads to stay
  unexecutable and add deny patterns. Every field only ever tightens, and the runner never writes
  the file. A machine without one behaves exactly as before.

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

`npm start` creates the token before either process starts and hands it to the UI. `GET
/api/health` stays open so that "is it up yet" is still answerable. To rotate the token, delete the
file and restart.

This does not contain a process already running as the operator — nothing at this layer can, since
that process can read the file. It moves the API from "anything on this machine, and several things
off it" to "something that can read a file in the install".

Every task writes `policy.json` into its run folder and a `POLICY` block into its log: the mode,
the allowlist and its digest, whether downloads could execute, digests of the deny list and of the
built-in refusals, whether a lock was in force and what it changed, and the account the run used.
So "what was this permitted to do at the time" is answered from the run folder rather than from a
configuration file that has been edited since.

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

## Getting started

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
| `cop dirs <projectRoot>` | lists the directories you can select for the mirror |
| `cop mirror <run.yaml>` | refreshes the Desktop folder without touching the chat |
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
| Desktop folder resolution and guard rails | `src/context/contextFiles.ts` | implemented, checked |
| Project mirror, flattened names, incremental | `src/context/projectMirror.ts` | implemented, checked |
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
