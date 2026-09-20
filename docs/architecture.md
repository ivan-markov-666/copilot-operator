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
- **A reply that names a file it did not attach is refused before anything runs.** Copilot sometimes says "the attached script writes the files" and attaches nothing. Left to the step loop, the download is refused halfway through the iteration, every step after it fails against files that were never written, and the results file that goes back is a page of errors about work that never started — after which the model lost track of which task it was on and re-ran the previous one. So the attachments are checked against the download steps first, and a reply with no file at all is sent back through the format-retry channel with a sentence saying to attach it or to write the file with `Set-Content` instead. Only the empty case: a name that does not match while one file *is* attached is still handled as a naming difference.
- **Every first-run dialog the bot dismisses is one it declines.** Edge offers "Confirm" next to "Set later" — confirming makes Edge the machine's default browser, a system setting changed by a bot because a dialog happened to be open. The consent banner offers "I Accept" next to "Reject All". The list is `Got it, Close, Dismiss, No thanks, Skip, Set later, Not now, Maybe later, Reject All`, and nothing that agrees to anything is ever in it; a dialog whose only option is to agree is reported and left for a person. They are dismissed before **every** message rather than only when a conversation opens, because they appear when they appear, sit over the composer, and make a run fail several steps later looking like something else.
- **A results file is identified by its task, never by an id nobody was told.** The header reads `RESULTS task="calc-service" iteration=2 steps=2 (runner's own folder: …)`. It used to lead with the run id, which names a folder on this machine and appears in no message anywhere — not in the task, not in the contract. Two tasks in one conversation therefore produced two reports bearing two identifiers that had never been introduced, and a model asked to reconcile a result with the task it belongs to reasoned, correctly, that it had never been told which task owned that id. It happened three times and ended the third run with "the result belongs to run s922, but no task instructions for that run were supplied in this conversation" — the task had been supplied; the id had not. The covering message names the task too, and level 1 says the folder name is bookkeeping. Verified by `npm run check:report`.
- **Work is reviewed by a second conversation, and that conversation must run things.** After a task ends `done` and its checks pass, a fresh chat is opened in the same browser. It is given the task, the project instructions and the files version control says changed — and deliberately **not** the implementer's summary, because a reviewer that reads an account of the work begins by trusting the thing it is checking. The exception is a task whose product *is* that account: when version control recorded no change, or the task is `readOnly`, the closing summary goes into the brief under "What the implementer delivered", labelled as claims to test (`deliverableFor` in `review.ts`) — a repository audit had lost its first round for "not delivering the audit summary" the reviewer had never been shown; a session without version control cannot tell and stays blind. It answers in its own contract (`reviewSchema.ts`): `continue` with steps, `pass`, or `fail` with findings, each finding carrying `what` and the `evidence` that proves it. Two rules make it worth having, and only one of them is in the schema: a verdict needs a real summary and a `fail` needs evidence, which zod enforces; and **`pass` from a review that executed nothing is refused and sent back**, which only the runner can enforce, because only the runner counts the commands. On `fail` the findings go back to the *implementer's* conversation — it has the history — and the task carries on; each new round opens a *new* reviewer, so nobody gets talked round. **A finding says whose problem it is.** `about: "work"` goes back to be fixed; `about: "task"` means the work is right and the task is wrong — it contradicts the project instructions, it contradicts observable reality, or it contradicts itself — and nobody downstream is allowed to change the sentence that is wrong. What that does depends on the verdict: a `pass` may carry findings, but only about the task — the work is accepted as `done` and the findings stay on its record as notes for whoever wrote it, and the plan behind it goes on; a `fail` whose findings are all about the task ends it at once, which is for a task that cannot be judged as written. It used to be only the second: the reviewer's one way to say "the task is wrong" was to fail right work, and a README with four documented error messages where the task said three ended `blocked` and stopped the plan. Without that distinction a reviewer holding a contradictory task had one move, fail the work, and the implementer had one answer, it cannot; two rounds of that and a sound task blocked over a defect that was never in the work. Three in one run: a README documenting four error messages where the task said three (the code has four), a README whose start commands could not be run because the session forbade starting servers, and an audit expected to find no git remote in a cloned repository. The budget counts times the findings are *sent back*, not reviews, so the last fix is always checked before the task is judged — counting reviews instead cost a task, which was blocked quoting a finding as "still there" after the implementer had fixed it and nobody had looked. After `limits.maxReviewRounds` (2) rounds of fixing, a final review still failing ends the task `blocked` with what is outstanding. A review that cannot be carried out at all does not fail the work: it is recorded as `error` on the task and the work is accepted unreviewed, because machinery stumbling is not evidence about the task. The reviewer can run on a different model (`session.review.model`) — a fresh conversation removes attachment to the work, but not the blind spots of the model that did it. **A finding that comes back is recognised, and the reviewer is made to decide.** Findings are matched between rounds by `where` — by `what` only when neither names a place — because two reviewers word one defect differently and a place does not drift. A later reviewer is told what the previous round found and that the implementer reports it fixed, and is asked, if it is still there, to say in `about` whether fixing the work can resolve it at all; the implementer, when a finding recurs, is told to either fix it differently and prove it, or declare in `deviations` that the instruction cannot be kept. This is a demand for a decision, not an automatic verdict: in the run that produced it, the same `where` came back in rounds one and two and the third round *did* converge, so stopping at the second would have blocked a task that succeeded. What the runner does is make the moment of judgement unavoidable instead of optional. **The implementer's declared deviations reach the reviewer as claims to test** — the one exception to the rule that it never sees the implementer's account, because "this instruction cannot be followed on this machine" is falsifiable by running things, and it is exactly the input the `about: task` verdict was missing: in that same run the reviewer wrote in its own evidence that the build rewrites the required value, and still filed the finding as the work's fault, twice. **A wrong finding can be answered.** The findings message used to say "if you believe a finding is wrong, say so in your summary" — and the next reviewer is never shown the summary, on purpose. In the second calculator run a reviewer searched the served page for label text the task never specified, a second reviewer did the same, and the implementer — having objected once, in prose, to nobody — renamed the labels to match, in a smoke-test task. Findings are now named by the runner (`r1f2`: round and position, shown in front of each), the implementer disputes one in `disputed: [{ finding, why, evidence }]`, the dispute goes on the task, to the register and, as a claim to test, into the next reviewer's brief. **`where` is required** on a finding, because it is how a repeat is recognised: the first-round finding in that run had none, the second did, and the repeat went unseen. **Every message sent to a reviewer is saved as sent** (`review/N/00-brief.md`, `findings-sent.md`, and the task log), because until it was, whether a later round had been told what the earlier one found could not be checked from the run folder at all. Verified by `npm run check:review` and `npm run check:parser`.
- **A review finding can carry its check, and then it is arithmetic.** A review is judgement, and judgement varies between runs: the same missing `@HttpCode(200)` was found by one calculator run's reviewer and missed by the next. A finding about the work may now carry `check` in the plan's own check shape — the mechanical test that would have caught it — and the runner (`derivedChecks.ts`) runs it at once, on the work as it stands: a check that **passes on the defective state** does not capture the defect and is sent back once, then dropped; one that fails is kept on the task (`reviewChecks`), named `review r1f2: …`, and runs in the gate with the operator's checks on this attempt and every later one, since a re-run does not clear it. Two more rules stop a wrong finding from becoming a permanent wall. A **dispute suspends** the finding's check until the next review rules — raised again, it comes back; not raised, it is dropped. And a derived check **never ends a task by itself**: with the rounds spent and only derived checks failing, they are suspended, the work goes to the reviewer with them named, and the verdict decides. A check written by one reviewer is outranked by the next reviewer's judgement, not by a counter. Verified by `npm run check:checks` and `npm run check:review`.
- **A read-only task is a flag the runner enforces, not a sentence the model reads.** The plan's `readOnly: true` (audits, smoke tests, reports) makes the runner look at the working tree when the task ends: changed, and a task that claims `done` ends `failed` with the files named — and the change is still committed on the task's branch, so nothing is lost and the next task starts from a clean tree. The task is told so in its opening, with the instruction to dispute a finding that asks for a change rather than comply. The sentence version had already failed: a smoke-test task, told in prose to change nothing, renamed the page's labels when a reviewer asked. Verified by `npm run check:plan`.
- **What a task or a review leaves running is stopped by the runner, and named.** "Anything you start, you stop" is in both contracts and is advice: a reviewer left its own `next start` listening on 4310 and then failed the work for it, and every plan so far carried its own checks for ports and node processes because nothing else would. `processes.ts` takes a snapshot — the processes whose command line names the project folder, and the ports being listened on — before the task and before each review; afterwards what is new is stopped with `taskkill /T`, written on the task (`leftovers`, with pid, ports and whether the task or which review round left it), said as a warning, and shown in red on the task card. The plan's checks still run first, so a server the implementer forgot goes back to the chat as a failed check; this is the net under them. Scoped to the project folder on purpose — the runner does not stop what it cannot tie to the work — and switched off when the project is this runner's own checkout, where every process of the runner would look like a leftover. Verified by `npm run check:processes`.
- **A finding must quote the sentence it rests on, and the runner checks the quote.** Two reviewers in a row failed a page for label text no task had specified — "First number", where the page task said "labelled A and B" and the smoke-test task said only "both input labels". Every finding now carries `basis`, a quote from what the reviewer was given, and `isGrounded` checks it is really there — normalised for case, spacing and markdown, so a dropped backtick still grounds and a paraphrase does not. A finding whose basis is not in the text is sent back once for the quote and then dropped as an invented requirement; a `fail` left with no grounded finding is an inconclusive review, and the work is accepted unreviewed with a loud warning rather than failed for nothing. What the reviewer is given grew for the same reason: **in a per-session run the brief carries the earlier tasks of the session** (the last three that ran, prompts capped), marked as context and not for judging again, because what they defined — a label, a port, a route — is what the later task rests on, and a finding may quote them. Verified by `npm run check:review`.
- **Every task records which world it ran in.** Two runs of one plan a day apart got TypeScript 6 and then 7, Next 15 and then 16, and behaved differently for reasons that took an afternoon to explain; "latest" is a moving target and a plan that pins nothing gets a new world every time. `environment.ts` probes the machine once per process — OS, Node, npm, git, both PowerShells, Edge with its version — and the runner writes the manifest into the run folder (`environment.json`), into the task log, onto the task (one line on the card) and into the debug export. The project's own dependencies are in its lockfile, which the runner commits; this is the layer under that. Verified by `npm run check:environment`.
- **Nothing Copilot writes may change git.** The deny list refuses any step whose command is a git subcommand that writes — `commit`, `push`, `reset`, `checkout`, `add`, `stash`, `remote add|remove|set-url`, `branch -D`, `config --unset`, and the rest — while leaving every read-only git command allowed, because auditing a repository is real work a task may be given. The patterns match on the subcommand's own position, after git's global options, so `git log --grep=commit` is a question and `git commit` is a change. This used to be prose in level 1 and prose turned out not to be enough: a task with a badly written check (`nothing has been pushed`, tested by looking for `origin` in `git remote -v`, which is false in any cloned repository) sent the failure back to the chat, and after fifteen iterations of arguing that the check was wrong, Copilot ran `git remote remove origin` to make it pass. A failing check applies pressure toward making it pass, and the cheapest way to satisfy a claim about a repository is often to change the repository. The runner's own git is unaffected: it goes through `execFile` in `vcs/git.ts` with an argument list and no shell. Verified by `npm run check:report`.
- **Commands run in the session's project, and never by default in this checkout.** Every step, check and review command used to run in `execution.cwd`, whose default is `.` — the directory the runner was started from, which for the API is this project's own checkout. The first step of a nine-task plan ran with `cwd=C:\Projects\automate-365` while writing into `C:\Projects\calculator-test`, and went right only because the model used absolute paths, as the plan's instructions told it to: a plan author compensating for a runner default, one relative path away from the model editing the bot. The reviewer was told that directory in as many words; the implementer was told nothing. Now `workDir.ts` decides once per task: the session's `vcs.repoDir`, else its `mirror.rootDir`, else the configured `execution.cwd` — and if that fallback is this checkout (found by walking up to the `package.json` named `copilot-operator`), the task ends `failed` before anything is sent, with a reason that says to give the session a project folder. Pointing a session at this checkout *on purpose* is allowed and logged as a warning, because that is a decision somebody made. Both conversations are told the directory: the implementer in a "Working directory" note at the top of the opening, the reviewer in its brief. That note travels with the version-control note through `composeOpening`, which had accepted `vcsNote` for a whole release and never included it — the audit task in that same run was never told which commit its branch was cut from, because the sentence saying so was dropped on the way to the chat. Verified by `npm run check:workdir`.
- **A commit is looked at once for what it should not carry.** `commitOnFinish` commits everything the task left in the tree, and that is the right default: the runner cannot know which of the model's files are the work. It can know what tool output looks like. A nine-task plan wrote its `.gitignore` exactly as dictated, nine entries, and the second web task still committed `web/tsconfig.tsbuildinfo` — `next build` had turned on `incremental` in a `tsconfig.json` the plan had also dictated; the reviewer had the path in its list of changed files and said nothing; the plan's own audit looked for `node_modules`, `.next` and `dist` and found none. Nobody was wrong; nobody was looking for that. So whenever the runner is going to commit, it adds a check of its own, `commit-clean` (`commitHygiene.ts`), to the task's checks: the working tree's uncommitted paths — listed file by file with `--untracked-files=all`, because plain `git status` folds a new folder into one line, and the first task of every plan creates a folder whose contents are exactly the question — are matched against what is installed, built, cached, logged or secret — `node_modules/`, `dist/`, `.next/`, `coverage/`, `*.tsbuildinfo`, `*.log`, `.env` and its variants except `.env.example` — and a hit fails the check through the same channel as the operator's, with the instruction to ignore the files or say why they belong. Pointed out **once**: a second `done` with them still there lets the check pass, commits them, and records them as `suspicious` on the task's version-control record, where the task card shows them in red. Refusing to commit instead would leave the tree dirty and the next task refusing to start over it. The mark is read from the commit itself, not from the check, so the record says what happened rather than what was noticed. Verified by `npm run check:vcs`.
- **A task is told where it stands, and the operator is told where the work is.** `per-task` cuts every branch from the commit the session started at — by design, so tasks are independent — and the note a task received said only the branch's name. So an audit task that ran after a README task audited a tree without the README and had no way to know; and when the run ended, HEAD was on that audit branch, so opening the folder showed no README either. Now the version-control note names the base commit with its subject line and, in per-task mode, lists the earlier tasks of the session with the branch each worked on and says outright that their work is **not** in this tree — a task that needs it can say so instead of looking for files that are not there. In per-session mode it says the opposite: this branch already carries those tasks' work. The session page's version-control panel answers the operator's question from the session record rather than from git: in per-session mode, the one branch that holds the complete work; in per-task mode, that there is no single branch, one per task, and which one HEAD is on. The plan brief tells the plan-writing model the same consequence in one sentence, so the choice is made by what the tasks need from each other. Verified by `npm run check:vcs`.
- **The clipboard is not used.** A reply is read by clicking "Copy Response", because the rendered DOM mangles code fences and only the copy gives back raw markdown. It is *not* read from the machine's clipboard: an init script (`CLIPBOARD_GUARD`) replaces the page's `navigator.clipboard.writeText`, `navigator.clipboard.write` and `execCommand('copy')` with versions that hand the text to a variable on `window` and never call through, and the runner reads that. Nothing is written to the system clipboard and nothing is read from it, so the operator can copy and paste while a run is going without the two reaching each other — which they did, in both directions: every reply used to overwrite whatever they had copied, and anything they copied between the click and the read was picked up and parsed as Copilot's answer. A counter on the variable is checked before and after the click, so a copy that did not happen degrades to the DOM text instead of serving the previous reply. Verified by `npm run check:clipboard`.

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

`status` is `continue`, `done` or `blocked`. The literal stop word (`Край` by default) anywhere in the reply also counts as `done` — but never over a `blocked` reply, where the status wins.

**`blocked` is the third ending, and it is the one that was missing.** It means: the work cannot be finished, here is what was tried, here is what is in the way. It requires `tried` (an array of at least two genuinely different approaches), a `summary` to the same standard as `done`, and optionally `needed` (what would unblock it). A reply with one approach, or none, is rejected and sent back — the bar exists so that giving up is deliberate rather than the path of least resistance.

Without it, a model that has run out of ideas has two options and both are bad: claim `done` on work it did not do, or keep emitting steps until a limit cuts it off. The second one happened, repeatedly — fifteen consecutive iterations of the same read-only git command, each costing a message, a reply and a report, ending in a timeout whose reason said nothing about the cause. A task that stops with "I tried these three things and this is in the way" is a result somebody can act on; a task that runs out of iterations is not.

`done` and `blocked` both end the task and therefore cannot carry steps. This is not tidiness: a reply that closes a task while also asking for commands to be run has not seen their output, so whatever its summary claims to have verified, it has not.

**`deviations` is for what happens between `done` and `blocked`: an instruction that cannot be followed as written.** The option the task names was removed in the version that got installed; the file it says to write is rewritten by the tool that builds it. This used to be resolved silently — the model did something else and wrote a sentence in `notes`, which nothing reads. Two such decisions in one run: TypeScript pinned to 5.9.3 in one package of a repository whose other package got 6.0.3, so that `moduleResolution node` would still parse; and `jsx: preserve` restored by hand after every `next build`, because the build kept rewriting it. Neither reached the reviewer (denied the implementer's account on purpose), the commit message or the register. `deviations` is an array of `{ instruction, did, why }` accepted on any reply — a deviation is made when it is made, not at the end — merged by instruction across the task so a repeat is one entry with its latest wording, written onto the task and into the commit body ("Not as the task said"), shown on the task card and counted on the register's row, and handed to the reviewer as claims to verify. It is not an escape from an instruction; it is the record of one that could not be kept, with the evidence. The closing reply is the final account: a `done` or `blocked` that lists deviations replaces what was declared along the way — a deviation declared mid-way and undone since, `moduleResolution` set to Node16 and then back to `node` once TypeScript was pinned, stood in a commit as a fact — while a closing reply that lists none keeps them, because forgetting to repeat is more common than meaning to retract. Verified by `npm run check:parser`.

**Repetition is refused by the runner, not discouraged in prose.** Every command is fingerprinted per task, and after `limits.maxCommandRepeats` (3) runs of the same one **returning the same exit code and the same output** it is turned away — the count is of identical results, not of runs, because a long task legitimately re-runs `npx tsc --noEmit` after every fix and after every round of review findings, and counting runs refused the sixth one and pushed the model into inventing ways around its own type-checker before it reaches the shell, with a message telling the model that this line of attack is spent and to try something different in kind — or to end the task `blocked`. If an entire iteration consists of nothing but refused repeats, that counts as a stall; after `limits.maxStalledIterations` (2) stalls the runner ends the task as `blocked` itself, naming the commands that were going round. A model cannot be argued out of a loop, but it can be prevented from having one.

Rules:

- Parser reads the code blocks collected by the transport, takes the first block whose language is `json` and that validates against the `zod` schema. Rendered prose is never regexed.
- If no valid block exists the bot sends a fixed "format error" message quoting the validation errors and waits again (max `maxFormatRetries`, default 2).
- `download` steps reference the attachment by file name; the parser matches it to the attachment cards the transport found. Missing attachment = format error.

### 2.4 Downloader

- For each `download` step: read the anchor's `href` — a `blob:` URL created in the page — and **fetch it in page context**, carried out as base64 and written to `artifacts/<runId>/<id>-<suggestedFilename>`. Never by clicking: the anchor carries `target="_blank"`, and clicking it crashed **Edge's browser process** every time it was tried — three minidumps in the bot profile's `Crashpad/reports`, one per attempt across two days, `ProcessType=browser`, the same `SubCode=0x80000003`, Edge 153.0.4234.32 — which ended the run and the plan behind it. The blob belongs to the page, so the page can read it without the download UI at all; an address that cannot be fetched is an error with a reason, not a crash.
- Computes SHA-256, writes it to the run log, refuses to run the file unless its extension is in `allowedScriptExtensions` (default `.ps1`, `.cmd`, `.bat`).
- Downloads are never taken from the browser's temp folder because Playwright deletes them when the context closes.
- **A dispute is answered in the runner's next message.** The first live dispute — a reviewer's derived check that started `npx next start` through `cmd.exe`, stopped the wrapper's PID and found the port still busy, which is the wrapper's doing and not the work's — suspended the check as designed, and the implementer, hearing nothing, ended the task `blocked` over "an operator check that cannot pass as written". It had no way to know the check would no longer run. The covering message that carries the next report now says what the dispute did (`notes` on `buildCoveringMessage`): which checks are suspended, that the next reviewer is told, and to report `done` again once the work is verified. The Windows fact underneath — `Stop-Process` on the PID `Start-Process npx`/`npm`/`cmd.exe` returns stops only the wrapper — is now in both contracts, because three tasks and their reviewers tripped on it in one day.
- **Acceptance is the conversation's size as the app reports it, never the rendered count.** Copilot virtualises a long conversation — a saved page of a 48-message chat held four turn elements, each carrying `aria-setsize="48"` — and "the chat took the message" and "a reply arrived" were both defined as the number of rendered turn elements going up. After re-entering a long chat for the third task of a session, a findings message landed twice, drew a reply, and was declared not accepted; the task failed on a message that had worked. `turnCount` now reads the maximum `aria-setsize` among the rendered turns, with the rendered count as the fallback, and `waitForReply` counts the same way. A second signal decides "landed" the way a person would (`acceptance.ts`): the newest user bubble changed since before the send and begins with what was sent — which is also what stops a retry from posting a message that already landed. Verified by `npm run check:chat`.
- **A run that dies with the browser says why.** "Target page, context or browser has been closed" reads the same for a closed window, a second Edge on the profile and a crash. `edgeCrash.ts` looks for a minidump written to the profile's `Crashpad/reports` in the last minutes and reads the process type, version and sub-code from `watson_metadata` next to it; the failure dump and the task's reason then name the crash and point at the report. Verified by `npm run check:crash`.

### 2.5 CommandRunner

Implemented in `src/exec/runner.ts`.

- `spawn('pwsh.exe' | 'powershell.exe' | 'cmd.exe', args, { cwd, windowsHide: true })`. For `pwsh`: `-NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>`; for downloaded scripts: `-File <path> <args>`.
- Steps run **sequentially in the order given**; a failing step does not stop the run (Copilot decides), unless `stopOnFailure: true`.
- Policy gate before every step: deny list regexes (`Remove-Item .* -Recurse`, `format `, `reg (add|delete)`, `Stop-Computer`, ...), optional allow list. In confirm mode the user sees the step and presses Enter / `s` to skip / `q` to abort.
- The same gate refuses `Start-Process` on a bare name that PowerShell would resolve to a `.ps1` shim (`npx`, `npm`, `pnpm`: `src/exec/shellExecuteTrap.ts`). Start-Process hands a script to ShellExecute, which on a machine whose `.ps1` association is a Store app fails with "cannot find all the information required" or shows a "Select an app" dialog; the step hangs until its timeout and nothing listens. The decision is made by walking PATH the way PowerShell does, not from a list of names, and check commands go through it too.

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

**Secret-shaped strings are redacted from every report, always.** `report.redactPatterns` was
empty by default, and the report is uploaded to the chat as a file: on a work machine what a
step prints is a token in a stack trace, a connection string in an error message, a key a step
printed by mistake — into the tenant's Copilot. `redaction.ts` recognises the shapes that are
secrets wherever they appear (JWTs, bearer tokens, AWS/GitHub/Slack/Azure keys, `password=` and
`api_key:` assignments, credentials inside URLs, private key blocks) and replaces them before
the file is written, keeping the name of the thing so the model can still reason about the
line; `password: string` in a type listing is left alone. The operator's own patterns apply on
top. The same treatment covers the check report and the review's findings message, both of
which quote output. What was taken out is counted by shape and said as a warning event, so an
operator sees that a token was printed at all. Verified by `npm run check:report`.

**A non-zero exit that printed nothing is called out, in the message and in the file.** In
PowerShell that is what a cmdlet that found nothing looks like — `Get-NetTCPConnection` on a
free port, `Get-Process` with no match — and the free port is the good outcome. Twice in one run
a step ended this way at the exact moment the task had succeeded, and the model spent iterations
proving with `netstat` that nothing was wrong; a weaker model would have ended the task
`blocked` over a port that was free. The runner cannot change the exit code (`silentFailure` in
`reporter.ts` only recognises the shape: completed, non-zero, empty stdout and stderr), so it says
what it sees and leaves the conclusion to the step's own question. Verified by `npm run
check:report`.

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
| `node_modules`, `.git`, `dist`, `build` | never copied, whatever is ticked |
| `.gitignore` respected (the default) | ignored files stay out |
| `.env`, `.env.production`, env off | skipped, and named in `skipped` with the reason |
| `.env` listed in `.gitignore`, env on | copied anyway; `.gitignore` has no say over env files |
| `.env` inside a gitignored folder, env on | the env file is taken, the rest of the folder is not |
| the same directory included and excluded | refused before anything is copied |

#### The two switches over what is copied

Both are per session, set in the UI, and they are deliberately not the same kind of thing.

`respectGitignore` is a convenience: the project already says what is noise, so by default the
mirror believes it. `includeEnvFiles` is a decision about secrets, and it is **the only** thing
that decides an env file. If `.gitignore` could hide them, the switch would mean nothing,
because every project ignores `.env`. So the walk hands every env file it meets to the
selection step regardless of the gitignore option, and that step keeps or drops them by this
switch alone. With the switch on, a directory that only `.gitignore` hides is still descended
into, but nothing except env files is taken from it.

Turning it on is confirmed once in the UI, and each run that attaches env files says so in the
event stream, because the copies end up in OneDrive and in the chat.

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
  # Fallback only: a session's commands run in its project folder (vcs.repoDir, else
  # mirror.rootDir). This checkout is refused as a fallback; see workDir.ts.
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
