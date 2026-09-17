# Architecture

Date: 2026-09-17. Supersedes the "three approaches" discussion in `tech-stack-research.md`:
the decision is **browser automation only** (Playwright driving a real, installed Edge).
No mouse/keyboard OS automation, no Copilot API for v1.

## 1. Principles

- **One surface: the Copilot web app.** `https://m365.cloud.microsoft/chat` (Microsoft is consolidating to `https://copilot.cloud.microsoft`). Everything the bot does is DOM interaction through Playwright.
- **Real browser, real profile.** Playwright launches the Edge that is already installed on the laptop (`channel: 'msedge'`) with a persistent profile directory owned by the bot. Playwright does not inject custom HTTP headers; the only automation signal is `navigator.webdriver === true`, which we do not hide. See 2.9 for what pacing does and does not change about that.
- **The human signs in, the bot never touches credentials.** First run opens the browser headed; the user completes the Entra login + MFA. Cookies and tokens live in the profile folder, so later runs are automatic until the tenant expires the session. When that happens the bot detects the login page, pauses, and asks the user to sign in again.
- **Copilot is the brain, the bot is the hands.** The bot does not interpret free text. Copilot is instructed (by the user's opening messages) to answer in a strict machine-readable format. The bot parses that format, executes, reports back, and loops.
- **Safe by default.** Confirm mode is on unless the user passes `--unattended`.

## 2. Component overview

```
                +----------------------------------------------------------+
   run.yaml --->| Orchestrator (state machine, one run = one Copilot chat) |
                +---+--------------+---------------+--------------+--------+
                    |              |               |              |
          +---------v--------+ +---v----------+ +--v----------+ +-v-------------+
          | CopilotTransport | | ReplyParser  | | Downloader  | | CommandRunner |
          | (Playwright/Edge)| | (format ctr.)| | (dl events) | | (pwsh spawn)  |
          +---------+--------+ +--------------+ +--+----------+ +-+-------------+
                    |                              |              |
              Edge profile dir              artifacts/<run>/  stdout/stderr/exit
                    |
          +---------v--------+
          | SessionManager   |  login detection, "please sign in" pause, session health
          +------------------+

   Everything writes to: RunLog (pino + JSONL transcript per run)
```

### 2.1 CopilotTransport (Playwright)

Responsibilities:

- `open()`: `chromium.launchPersistentContext(profileDir, { channel: 'msedge', headless: false, acceptDownloads: true, downloadsPath })`. The profile dir is **not** Edge's default `User Data` folder (Playwright hangs on it), it is e.g. `%LOCALAPPDATA%\copilot-operator\edge-profile`.
- `ensureSignedIn()`: navigate to the chat URL; if the page lands on `login.microsoftonline.com` or shows the sign-in UI, emit `SIGN_IN_REQUIRED` and wait (headed) until the chat textbox appears. No timeout in confirm mode; configurable timeout in unattended mode.
- `newChat()`: navigate to the chat URL, which is what the "New chat" anchor does, so every run starts with a clean context.
- `nameChat(name)`: after the first exchange, rename the conversation through the sidebar row's "More" menu -> "Rename" -> input -> **Save**. Enter does not submit that dialog.
- `reattach(pointer)`: reopen the bot's own conversation after a lost session. See 2.2.
- `send(text)`: fill the composer (`getByRole('textbox')`), press Enter or click Send. Long messages go in via `fill`, not keystrokes.
- `waitForReply()`: wait until (a) a new assistant message appears after the last one we recorded, (b) streaming has finished. Streaming end is detected by the Stop button disappearing **and** the message text being unchanged for a quiet period (e.g. 1.5 s). Returns a `Reply` object: raw text, list of code blocks (`pre > code` innerText + language), list of attachment cards (locator handles).
- `clickAttachment(handle)`: used by Downloader; wraps the click in `page.waitForEvent('download')` registered **before** the click.
- `attach(paths)`: `setInputFiles` on the hidden `#upload-file-button`, then wait for the attachment chip to appear in the composer before sending. This is how every results report goes back to Copilot.
- Locators live in one file (`locators.ts`) because Microsoft changes the UI; nothing else in the code knows about CSS/ARIA details. Prefer `getByRole` / `getByLabel`; fall back to `data-testid`; never coordinates.

### 2.2 SessionManager

#### Owning a named chat

Implemented in `src/transport/chatSession.ts`. The bot works in one conversation per run and
must be able to find it again after the session expires and the user signs in a second time.
Two handles are kept, because they fail differently:

| Handle | What it is | Why both |
|---|---|---|
| conversation id | the uuid in `/chat/conversation/<uuid>` | exact, survives renames, reopens directly |
| chat name | set by the bot right after the first message | findable by a human, works when the id does not |

The id alone is not enough, because a sidebar full of chats called "You are Operator, a
Windows systems engineer worki" tells a person nothing. The name alone is not enough either,
because names are not unique and the sidebar truncates them.

Name shape, capped at the UI's 50-character limit:

```
op/<runId>/<label>        e.g.  op/20260917-1912/windows-update
```

The `op/` prefix makes every bot chat greppable and separates it from the user's own
chats. The run id ties the chat to the transcript on disk. The label absorbs the truncation,
because prefix and run id are the parts that make the chat findable. Labels are
Unicode-aware, so a Cyrillic task name survives: `op/20260917-1912/тест-на-кирилица`.

Both handles are written to `runs/<runId>/chat.json` as soon as the conversation exists, and
also to a stable `runs/last-chat.json` pointer.

**Reattach order** after a lost session. Each step runs only when the previous one fails:

1. Navigate to the saved conversation URL. Normal path.
2. Click the sidebar row whose `aria-label` equals the saved name exactly.
3. Search the full chat list at `/chat/all` for the name.
4. Fail. **Never silently open a new chat.** A fresh chat has neither the persona nor the
   format contract, so the run would keep going while quietly misbehaving. The bot stops and
   names the chat it could not find, and the human decides.

A caveat worth recording: `document.title` still showed the old title after a successful
rename, so the sidebar row's `aria-label` is the only trustworthy read of the current name.

#### Profile and popups

- Owns the profile directory path and a lock file so two bot instances never open the same profile.
- `probe()`: cheap check (is the chat textbox visible?) used at start and after every reply; distinguishes "signed out", "consent/dialog popup", "chat ready".
- Handles first-run popups (privacy, "try the new Copilot") by clicking the dismiss controls listed in `locators.ts`; unknown popups are logged with a screenshot and the bot pauses.

### 2.3 ReplyParser (the format contract)

The user's opening messages must instruct Copilot to answer **only** with one fenced ```json block of this shape:

```json
{
  "status": "continue",
  "steps": [
    { "id": 1, "type": "command",  "shell": "pwsh", "cmd": "Get-Service | Where-Object Status -eq Running" },
    { "id": 2, "type": "download", "file": "cleanup.ps1", "run": true, "shell": "pwsh", "args": ["-WhatIf"] },
    { "id": 3, "type": "command",  "shell": "cmd",  "cmd": "ipconfig /all" }
  ],
  "notes": "free text for humans, ignored by the bot"
}
```

`status` is `continue` or `done`. The literal stop word (`Край` by default) anywhere in the reply also counts as `done`.

Rules:

- Parser reads the code blocks collected by the transport, takes the first block whose language is `json` and that validates against the `zod` schema. Rendered prose is never regexed.
- If no valid block exists the bot sends a fixed "format error" message quoting the validation errors and waits again (max `maxFormatRetries`, default 2).
- `download` steps reference the attachment by file name; the parser matches it to the attachment cards the transport found. Missing attachment = format error.

### 2.4 Downloader

- For each `download` step: register `waitForEvent('download')`, click the card, `download.saveAs(artifacts/<runId>/<id>-<suggestedFilename>)`.
- Computes SHA-256, writes it to the run log, refuses to run the file unless its extension is in `allowedScriptExtensions` (default `.ps1`, `.cmd`, `.bat`).
- Downloads are never taken from the browser's temp folder because Playwright deletes them when the context closes.

### 2.5 CommandRunner

Implemented in `src/exec/runner.ts`.

- `spawn('pwsh.exe' | 'powershell.exe' | 'cmd.exe', args, { cwd, windowsHide: true })`. For `pwsh`: `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>`; for downloaded scripts: `-File <path> <args>`.
- Steps run **sequentially in the order given**; a failing step does not stop the run (Copilot decides), unless `stopOnFailure: true`.
- Policy gate before every step: deny list regexes (`Remove-Item .* -Recurse`, `format `, `reg (add|delete)`, `Stop-Computer`, ...), optional allow list. In confirm mode the user sees the step and presses Enter / `s` to skip / `q` to abort.

#### Long-running steps

A step is often a whole automated test suite, so "slow" is normal and must not be confused
with "hung". The runner keeps **two independent clocks** per step:

| Clock | Meaning | Default fast | Default long |
|---|---|---|---|
| `hardTimeoutMs` | absolute ceiling | 5 min | 4 h |
| `idleTimeoutMs` | no output at all before the step counts as hung | 1 min | 15 min |

The idle clock is the one that does the real work. A suite printing a line per test resets
it constantly and can run for hours untouched, while a genuinely stuck process trips it
within minutes. Copilot can raise either clock per step via `timeoutSec` and
`idleTimeoutSec`, capped by `execution.maxStepTimeoutSec` from the config so a bad reply
cannot pin the machine for a day.

Other properties that matter for long steps:

- **Output streams to disk as it arrives.** A killed step still reports everything it
  printed. Nothing lives only in memory.
- **The whole process tree is killed**, via `taskkill /T /F`. `child.kill()` signals only
  the shell, and a test runner's children (node, dotnet, java) would survive it and keep
  holding the console.
- **Heartbeat every 30 s** with elapsed time, idle time, bytes produced and the last line
  printed, so the human watching the console can see a suite is alive.
- Each step reports an `outcome`: `completed`, `hard-timeout`, `idle-timeout`, `aborted`
  or `spawn-error`. The report file passes this to Copilot, which matters because
  `idle-timeout` on a test suite usually means "it was silent", not "it failed".

Verified behaviour (`npm run check:runner`):

| Case | Result |
|---|---|
| normal command | `completed`, exit 0, output captured |
| failing command | `completed`, exit 1, stderr captured |
| `Start-Sleep 120` with a 3 s idle limit | `idle-timeout`, killed after 4 s |
| 7 s command printing every 0.7 s, 3 s idle limit | `completed`, never killed |
| 30 s command with a 4 s hard limit | `hard-timeout`, killed after 5 s |

#### Session survival across a long step

A multi-hour step can outlive the Copilot session. The orchestrator therefore re-probes the
session **after** every long step, before trying to report:

1. If the page is still signed in, carry on.
2. If it signed out, pause in `WAIT_FOR_HUMAN_LOGIN`. The report file is already written to
   disk, so nothing is lost while waiting.
3. If the chat is gone entirely, the run fails, but the report file and transcript remain.

The browser is left open and idle during a long step; no keep-alive interaction is faked.

### 2.6 Reporter

**The report is always a file, never message text.** The composer rejects messages beyond
roughly 120 000 characters, and a single verbose command can blow through that on its own.
Attachments are not subject to that limit, so the runner writes the whole report to a
`.txt` file and uploads it.

Per iteration the Reporter writes `runs/<runId>/reports/iteration-<n>.txt`:

```
RESULTS run=2026-09-17T14-02-11Z iteration=3 steps=3
--- step 1 (command, pwsh, exit 0, 0.4s)
<full stdout>
[stderr]
<full stderr>
--- step 2 (download cleanup.ps1, sha256=..., exit 1, 2.1s)
<full stdout>
--- step 3 (command, cmd, exit 0, 0.1s)
<full stdout>
END RESULTS
```

Steps appear in the order they were executed. Nothing is truncated in the file: the whole
point of the file transport is that the full output survives.

**A message cannot consist of an attachment alone.** The composer keeps Send disabled until
there is text, so the covering message is mandatory, not decorative. Since text has to be
there anyway, it carries what Copilot needs in order to decide to open the file:

```
Terminal output for iteration 3: 2 step(s), step 1 exit 0; step 2 exit 1. The full output
is in the attached file iteration-3.txt. Read the whole file before deciding the next steps.
```

Built by `buildCoveringMessage` in `src/protocol/reporter.ts`. It states the iteration, the
step count and how each step ended, names every attached file, and adds an explicit note when
a step was stopped by the runner rather than by the command itself, because `idle-timeout` on
a test suite means "it went silent", not "it failed". When the report is split, it lists all
the parts and says to read them in order. It can never return an empty string, and
`assertSendable(text, attachments)` throws right before Send if it somehow would.

Sequence: `attach(reportPath)` -> wait for the attachment chip's id to carry the `SPO_`
prefix, which is the upload-finished signal -> fill the covering text -> assert it is not
empty -> click Send.

**Privacy consequence.** The composer states that uploading from the device sends a copy to
OneDrive for Business, and the chip id confirms it is stored in SharePoint. Every report the
bot sends therefore lands in the user's OneDrive. Terminal output can contain host names,
paths, user names and sometimes secrets, so:

- the README states this plainly,
- confirm mode shows it once at the start of a run,
- `report.redactPatterns` lets the user strip values before upload,
- `report.keepUploads` (default `false`) is a placeholder for a later cleanup pass.

Size handling:

- `maxReportBytes` (default 8 MB). Above it the report is split into
  `iteration-<n>-part1.txt`, `-part2.txt` and so on, split on step boundaries, and all parts
  are attached to the same message. The input accepts multiple files.
- Per-step output is still capped at `maxOutputChars` inside the file, but the cap is high
  (default 200 000) because there is no message limit to respect. The full, uncapped stream
  is always kept on disk next to the report.
- The uploaded file is renamed to `.txt` if a step produced something with a different
  extension. `.ps1` is not in the accept list of the upload input.

Fallback: if the upload fails twice, the Reporter sends the head and tail of the report as
message text, capped at 100 000 characters, and says in the message that the output was
truncated.

### 2.7 The Desktop folder

Implemented in `src/context/contextFiles.ts`.

The bot has to show Copilot the project it is working on, and the human has to stay in
charge of exactly which files that is.

**Everything in this path is the file system, not the browser.** The user names the project
root and the directories to include; the program copies them into **one folder on the
Desktop** that it alone owns, by default `<Desktop>/copilot-operator-context`. OneDrive picks
that folder up on its own. No Playwright, no upload form, no web picker anywhere here. How
the copying and the naming work is section 2.8.

#### Desktop, and OneDrive

`resolveDesktopDir()` tries `<OneDriveCommercial>\Desktop`, then `<OneDrive>\Desktop`, then
`%USERPROFILE%\Desktop`, and takes the first that exists. That ordering is what makes it
correct under OneDrive's Known Folder Move: when Desktop backup is on, the real Desktop lives
inside OneDrive and `%USERPROFILE%\Desktop` may not exist at all. No registry read is needed,
and the result is whatever is true on the machine the bot runs on.

When Desktop backup is on, which is the intended deployment, the mirror folder reaches
OneDrive with no user action at all. `desktopIsSynced()` reports whether that is the case, and
`checkSelection()` surfaces it as a note when it is not, so a machine without Desktop backup
says so instead of silently keeping everything local.

### 2.8 The project mirror

Implemented in `src/context/projectMirror.ts`. This is the piece that gets project code in
front of the chat.

#### The problem it solves

The target folder has to be **flat**: it sits on the Desktop, owned by this program alone, and
the point is that OneDrive picks it up without anyone dragging folders around. But a project
is a tree, and two files called `index.ts` in different folders would collide the moment the
tree is flattened. On top of that the chat's upload input rejects `.ts`, `.java`, `.php` and
most other source extensions outright.

Both are solved by encoding the relative path into the file name and giving everything a
`.txt` tail:

```
src/test/example-test.spec.ts   ->   src--test--example-test.spec.ts.txt
```

`unflattenName()` reverses it, so the original path is recoverable from the name alone.

#### The convention comes from Context Picker

The rules are taken from `copySelectionToDir` in the user's own
[context-picker](https://github.com/ivan-markov-666/context-picker) (MIT), so a folder
produced here and a folder produced by the extension are interchangeable:

- relative path, forward slashes, joined with the separator (`--`)
- collisions get `<sep><n>` appended, starting at 2, compared case-insensitively
- `.txt` appended **after** the collision suffix
- sync writes only files whose bytes differ, and deletes what is no longer selected

`txtMode` allows `append` (the default, `app.ts.txt`, keeps the real extension visible),
`replace` (`app.txt`) and `none`.

#### The input is directories, not files

This is the one deliberate difference from the extension. There the user ticks individual
files in an editor. Here the user names the project root and the directories to include, and
**selecting a directory takes everything beneath it, at any depth**. Directories that are not
selected contribute nothing.

| Setting | Meaning |
|---|---|
| `rootDir` | the project path the user gives |
| `includeDirs` | relative directories to take, recursively; `['.']` is the whole project |
| `excludeDirs` | carved back out after `includeDirs` |
| `respectGitignore` | on by default; the project's root `.gitignore` is honoured |
| `ignoreDirs` | extra names pruned at any depth, on top of the built-in list |
| `includeEnvFiles` | off by default; `.env` and `.env.*` are skipped and reported |
| `maxFileBytes` | 2 MB by default; larger files are skipped and reported |

`node_modules`, `.git`, `bin`, `obj`, `.vs`, `dist`, `build`, `out`, `coverage`,
`__pycache__`, `.venv`, `venv` and `target` are pruned at any depth even with no
`.gitignore`. `listSelectableDirs()` returns the directories worth offering, pruned by the
same rules, so a picker only ever shows what can actually be copied.

#### Incremental by construction

`mirrorProject()` writes a file only when its bytes differ from what is already in the target,
deletes target files that are no longer selected, and leaves everything else untouched. That
is what stops OneDrive from re-uploading a whole project because one file changed. Comparison
is by content, not mtime, because a rebuild can rewrite a byte-identical file.

Verified behaviour (`npm run check:mirror`), on a sample project:

| Case | Result |
|---|---|
| naming | `src/test/example-test.spec.ts` -> `src--test--example-test.spec.ts.txt`, round-trips back |
| collision | a real `a--b.ts` next to `a/b.ts` becomes `a--b.ts--2.txt` |
| first run, `src` + `docs` | 4 added |
| second run, no edits | 0 added, 0 updated, 0 deleted, 4 unchanged |
| edit one, add one, delete one | 1 added, 1 updated, 1 deleted, 2 unchanged |
| select another directory | 1 added, the rest untouched |
| `.gitignore`, `node_modules`, `dist` | never copied |
| `.env`, `.env.production` | skipped, and named in `skipped` with the reason |

#### Two ways to produce the folder

**Built in, the default.** `mirrorProject()` does the whole thing from the project path and a
list of directories. Nothing else has to be installed.

**Context Picker, for per-file control.** When the user wants to tick individual files rather
than whole directories, the extension writes the same folder, with the same naming, through
its own `copyfiles` bridge. `exportSelection()` drives that. Either tool can maintain the
folder; the bot only reads it.

#### Guard rails before anything is used

`checkSelection()` refuses early rather than half-way, because a partial context makes
Copilot answer confidently about files it never saw. It reports:

- an empty export folder,
- more than `maxFiles` (default 20) or more than `maxTotalBytes` (default 25 MB),
- any file whose extension the chat would reject, naming them and pointing at the
  "append .txt" option,
- anything that looks like an env file, which is refused outright,
Separately from those, it returns non-blocking `notes`, currently one: that the export folder
is not inside OneDrive, so the copies stay on this machine only. That is a fact about backup,
not a fault, so it never stops a run.

#### Licence

`context-picker` is MIT licensed (`LICENSE.txt` at its repository root, and `"license":
"MIT"` in its `package.json`, both confirmed on 2026-09-17). Same licence as this project, so
`copilot-operator` can depend on it and recommend it without any friction.

#### Open question

How the chat consumes those files is not settled. The composer's "+" menu offers
"Attach cloud files", but it opens a cross-origin iframe picker, which is expensive to
automate and brittle. Two cheaper options to test first: whether Copilot's enterprise
grounding finds the folder by name once OneDrive has indexed it, and whether pointing the
chat at the folder in the prompt is enough. This needs one experiment before any code.

### 2.9 Pacer

Implemented in `src/util/pacing.ts`. Three things only:

- **`settle()`** — a fixed 1 s pause after an action. It is a cushion, not the mechanism.
  What actually prevents flaky clicks is waiting on conditions in the transport: the
  `Stop generating` button gone, the `SPO_` prefix on the attachment chip, the Send button
  present.
- **`throttleSend()`** — a hard cap of `maxMessagesPerHour`, default 60, enforced by waiting
  out the oldest message in the window. This is the one part that protects against
  service-side throttling on a long run.
- **`backoffFor(attempt)`** — exponential backoff with jitter, capped at 60 s, so a failing
  step cannot become a tight retry loop.

`enabled: false` removes the settle pause. The send cap and backoff always apply.

#### What was removed, and why

An earlier version drew every delay from a log-normal distribution and occasionally took a
20 to 90 second pause, to make the traffic look less mechanical. That was dropped after
measuring what it bought.

The setup already sends entirely ordinary traffic: a real installed Edge, a real profile, a
real user agent, and no injected headers, because Playwright adds none. The one technical
marker is `navigator.webdriver === true`, which the browser sets whenever it is under
automation control, and no amount of timing changes it. Meanwhile, with the default limits
(30 iterations against a 60 messages per hour cap) the cap never binds, so the randomness
only added a few minutes per run.

So the randomness bought nothing measurable and was removed. Masking the webdriver flag is a
different goal from automation, it is an arms race against fingerprinting that a small
open-source project will lose, and whether to hide automation from your own tenant is a
question about that tenant's acceptable-use policy rather than about code. The project leaves
the flag alone and documents it, so anyone running this can explain to their admin what it
does.

### 2.10 Orchestrator (state machine)

```
INIT -> OPEN_BROWSER -> ENSURE_SESSION --(signed out)--> WAIT_FOR_HUMAN_LOGIN --+
                              ^                                                |
                              +------------------------------------------------+
                              |
                          NEW_CHAT
                              |
                    SEND_OPENING_MESSAGES   (for each message in config: send, waitForReply,
                              |              log; only the LAST reply is parsed)
                              v
                 +------->  PARSE_REPLY --(invalid)--> SEND_FORMAT_ERROR --+
                 |             |                                           |
                 |          (done) --> FINISHED                            |
                 |             |                                           |
                 |        DOWNLOAD_STEPS -> EXECUTE_STEPS -> SEND_REPORT <-+
                 |                                              |
                 +--------------- WAIT_REPLY <------------------+

Guards on every transition: iteration < maxIterations, elapsed < maxRunMinutes,
session still signed in, user has not pressed Ctrl+C.
```

Every state change is appended to `runs/<runId>/transcript.jsonl` so a crashed run can be inspected and, in a later version, resumed.

## 3. Configuration (`run.yaml`)

```yaml
copilot:
  url: https://m365.cloud.microsoft/chat
  profileDir: ~/AppData/Local/copilot-operator/edge-profile
  stopMarker: "Край"

openingMessages:            # sent in order; last reply starts the loop
  - file: prompts/01-persona.md
  - file: prompts/02-format.md
  - text: |
      Задача: провери състоянието на Windows Update на тази машина и предложи поправки.

execution:
  mode: confirm             # confirm | unattended
  defaultShell: pwsh
  cwd: ~/copilot-operator-work
  # "fast" steps, the default
  commandTimeoutSec: 300
  idleTimeoutSec: 60
  # steps Copilot marks "expect": "long", e.g. a test suite
  longCommandTimeoutSec: 14400
  longIdleTimeoutSec: 900
  # ceiling on whatever Copilot asks for, so one bad reply cannot pin the machine
  maxStepTimeoutSec: 28800
  heartbeatSec: 30
  stopOnFailure: false
  allowedScriptExtensions: ['.ps1', '.cmd', '.bat']
  denyPatterns:
    - 'Remove-Item.*-Recurse'
    - '\bformat\b'
    - 'Stop-Computer|Restart-Computer'

projectMirror:
  # The project the user points at.
  rootDir: C:/Projects/my-app
  # Directories to include, relative to rootDir. Selecting one takes everything beneath it.
  includeDirs:
    - src
    - tests
  excludeDirs:
    - src/generated
  # One folder on the Desktop that only this program owns, updated incrementally.
  # OneDrive picks it up by itself when Desktop backup is on.
  targetDir: ~/Desktop/copilot-operator-context
  separator: '--'            # src/test/a.spec.ts -> src--test--a.spec.ts.txt
  txtMode: append            # append | replace | none
  respectGitignore: true
  ignoreDirs: []             # on top of node_modules, .git, bin, obj, dist, ...
  includeEnvFiles: false     # .env and .env.* are skipped and reported
  maxFileBytes: 2097152

contextPicker:               # optional: per-file selection instead of whole directories
  bridgePath: null           # .../context-picker/dist-cli/scan-selection.js
  maxFiles: 20
  maxTotalBytes: 26214400

report:
  transport: file          # file | text  (file is the default and the supported path)
  fileName: 'iteration-{n}.txt'
  maxReportBytes: 8388608  # split into several attached parts above this
  maxOutputChars: 200000   # per step, inside the file
  uploadRetries: 2
  redactPatterns: []       # regexes replaced with [REDACTED] before upload
  keepUploads: false       # reserved: clean up report files in OneDrive after a run

pacing:
  enabled: true
  settleMs: 1000
  maxMessagesPerHour: 60

limits:
  maxIterations: 30
  maxRunMinutes: 120
  maxFormatRetries: 2
  # Hard ceiling of the composer. Only the short covering message is ever measured
  # against it; the terminal output travels as an attachment.
  maxMessageChars: 100000
```

`prompts/02-format.md` is shipped with the project: it is the canonical instruction that teaches Copilot the JSON contract from section 2.3. Users customize persona and task, not the format.

## 4. Repository layout

```
copilot-operator/
  package.json            TypeScript, Node LTS, ESM
  src/
    cli.ts                commander entry: `cop run run.yaml`, `cop login`, `cop doctor`
    config/schema.ts      zod schema for run.yaml
    transport/
      copilotTransport.ts
      locators.ts         the ONLY file with selectors
      session.ts
      chatSession.ts      chat naming, pointer file, reattach order
    protocol/
      replySchema.ts      zod schema of the JSON contract
      parser.ts
      reporter.ts         covering message; attachments can never be sent alone
    exec/
      runner.ts
      policy.ts           allow/deny + confirm prompt
      downloader.ts
      reportFile.ts       writes iteration-<n>.txt, splits oversized reports
    orchestrator/
      machine.ts
      states.ts
    context/
      contextFiles.ts     Desktop folder resolution, hash manifest, guard rails
      projectMirror.ts    directory selection, flattened names, incremental sync
    util/pacing.ts        settle pause, hourly send cap, backoff
    log/runLog.ts
  prompts/02-format.md
  docs/
  test/                   vitest unit tests + a Playwright test against a saved DOM fixture
```

CLI commands:

- `cop login`: opens Edge with the bot profile, waits for the user to sign in, verifies the chat loads, exits. Run once.
- `cop doctor`: checks Edge is installed, profile exists, session is valid, `pwsh` is available.
- `cop run <run.yaml>`: the loop.

## 5. Failure handling

| Situation | Behaviour |
|---|---|
| Session expired mid-run | Pause in `WAIT_FOR_HUMAN_LOGIN`, print instructions, resume the same chat if still open, else fail the run. |
| UI changed, locator not found | Screenshot + HTML dump to `runs/<id>/`, fail fast with a message naming the locator key in `locators.ts`. |
| Copilot reply never finishes | `replyTimeoutSec` (default 600), then send "please resend the last answer in the required format" once, then fail. |
| Invalid format | up to `maxFormatRetries`, then fail. |
| Command hangs | killed at `commandTimeoutSec`, reported as exit code -1 with `timeout: true`. |
| Report upload fails | retry `uploadRetries` times, then fall back to head+tail as message text and say so in the message. |
| Copilot ignores the attached file | the covering message repeats the instruction to read it; if two consecutive replies show no sign of the output, fail the run rather than loop blindly. |
| Two runs at once | lock file on the profile dir; second run refuses to start. |

## 6. Out of scope for v1 (kept possible by the design)

- Copilot Chat API / Work IQ transport (text-only). `CopilotTransport` is an interface, an API implementation can be added without touching the orchestrator.
- Resume of a crashed run from the transcript.
- Headless mode (Copilot may behave differently; headed is the default and is fine on a laptop).
- Parallel runs (would need separate profiles and accounts).

## 7. Open questions to settle during the first spike

1. Does the tenant's Conditional Access accept a Playwright-launched Edge profile? (Blocking.)
2. Exact locators for composer, send, stop, message list, code blocks, attachment cards.
3. How long the session lives in the bot profile without user interaction (drives how often `cop login` is needed).
4. Whether Copilot reliably keeps the JSON contract over 20+ turns, or needs a reminder appended to every report message.
