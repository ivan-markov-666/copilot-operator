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

1. Sends the opening messages the user configured: a persona, an output contract and the task.
2. Reads Copilot's reply and parses a strict JSON block out of it.
3. Downloads any script Copilot attached to the chat.
4. Runs the commands in PowerShell or `cmd`, in order, capturing stdout, stderr and exit codes.
5. Writes the whole terminal output to a `.txt` file and attaches it to the chat.
6. Repeats until Copilot reports it is done.

Selected parts of a project can be mirrored to a Desktop folder that OneDrive syncs, so the
chat can see the code it is being asked about.

## Safety

The bot executes commands and scripts written by a language model. Confirm mode is on by
default: every step is shown and waits for a keypress. Unattended mode is behind an explicit
flag. There is a deny list, a per-step timeout, an iteration cap, and every downloaded file
is hashed into the run log. Running it in a dedicated Windows account or Windows Sandbox is
recommended.

## Requirements

- Windows 10 or 11
- Node.js 20 or newer
- Microsoft Edge, already installed
- A Microsoft 365 Copilot account, signed in once by the user

## Getting started

```bash
npm install
npx tsx src/cli.ts login                    # sign in once; the Edge profile is reused
npx tsx src/cli.ts doctor run.yaml          # check the machine
cp run.example.yaml run.yaml                # then edit it
npx tsx src/cli.ts run run.yaml
```

The bot never types credentials. `login` opens Edge, waits for the chat to appear, and stores
nothing but the browser profile.

### Commands

| Command | What it does |
|---|---|
| `cop login` | opens Edge with the bot profile and waits for you to sign in |
| `cop doctor [run.yaml]` | checks Node, Edge, PowerShell, the Desktop, the config |
| `cop dirs <projectRoot>` | lists the directories you can select for the mirror |
| `cop mirror <run.yaml>` | refreshes the Desktop folder without touching the chat |
| `cop run <run.yaml>` | the loop; `--unattended` skips the per-step prompt |
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
| The loop | `src/orchestrator/machine.ts` | implemented, run live end to end |
| CLI | `src/cli.ts` | implemented |

Design and findings:

- [`docs/testing.md`](docs/testing.md) — how to test it the first time, step by step
- [`docs/architecture.md`](docs/architecture.md) — the whole design
- [`docs/locators-findings.md`](docs/locators-findings.md) — what the live Copilot DOM looks like and why
- [`docs/tech-stack-research.md`](docs/tech-stack-research.md) — why Playwright and not the alternatives

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
