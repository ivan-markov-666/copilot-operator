# The web UI and the API

Two local processes on the operator's machine. Neither is reachable from the network.

| Process | Stack | Where | Starts with |
|---|---|---|---|
| API | NestJS, built with `tsc`, runs under Node ESM | `http://127.0.0.1:4000/api` | `npm run api` |
| UI | Next.js 15, app router, client components | `http://localhost:3210` | `npm run web` |

The API is the only thing that touches the browser profile, the file system and the shell.
The UI is a thin client over it. The core in `src/` does not know either exists: the runner
takes an authorizer (who approves steps), a store (where sessions persist) and an event bus
(where progress goes), and the API supplies web-flavoured versions of all three.

## The workbench

**Two chats: a lead and a worker (2026-10-20, the third round).** "Two chats" under the chat's box, for a new
conversation, gives the message to a lead instead of straight to the one who works (`src/orchestrator/leadRunner.ts`,
the contract `prompts/lead1.md`, its replies held by `src/protocol/leadSchema.ts`). The lead runs nothing: its first
reply restates the assignment (`understanding`); then each reply is one decision — `delegate` a subtask, `plan`, `ask`
the operator, `done` with the result in the form asked for, or `blocked`. A subtask goes to the worker, a session of
its own (`Session.workerOf`, hidden from the conversation list) with a conversation of its own in the same Copilot
window, as a task run by `runTask` — commands asked about or not, Pause, Stop, its own photograph of the folder, no
branch or commit; the worker keeps its conversation across subtasks unless the lead asks for a fresh one. The worker's
report goes back to the lead: its summary, the commands it ran with their exit codes, the files it changed, how many
subtasks are left (`limits.maxSubtasks`, default 20). The plan is put to the operator when "Plan mode" is ticked; the
lead's question waits on a card in the conversation (`POST /api/approvals/:id/answer`). The message shows the lead's
understanding, its notes, its plan, each subtask as a fold with the worker's commands, the questions with their
answers, and the result; the panel follows the worker's latest subtask. The worker's model is chosen beside the
lead's (the lead's when none is), and a model chosen by hand is asked on a card that says which of the two it is for.


**Since 2026-10-20 (the second round).** The pages are the chat (`/`), Settings (`/settings`; `/defaults` until 2026-10-22, which goes on to it) and System (`/system`):
the base prompt's page, the presets' page and the Appearance page went. The base prompt is shown in Settings to read,
folded, with what it is said above the fold; it is the one that ships and changes only when the bot is updated (an
edited copy an earlier version kept in the data folder is not read). Each project in Settings has its branch (read
from git each time) and a "Level 2 template (for Kerrigan)", which Kerrigan carries, saved or copied; "Prepare the
folder from the remote main branch" went, with its routes and the sync command before it. Every field of Settings has
an ⓘ, and the fields are one grid. The chat has "Review" under its box, on unless unticked: when Copilot says a message
is done, a conversation of its own reviews the work, told what the message changed from the folder against its
photograph; chosen by hand, the review's model is asked on a card that says plainly it is the review's and why a
different, stronger one is worth it. "New chat" is off while a task runs and on a chat not begun, saying why. "Pause",
"Stop" and "Add to it" are one group. The interface has nine languages (`web/lib/lang/`, one file each, listed with
how to add one in `languages.ts`), chosen from "Language", which reads so in every language, with flags; Arabic turns
the page right to left before its first paint, and what is code or the operator's own text keeps its direction.


The home screen (`/`) is laid out as an IDE with the chat beside it: the operator asked for the app to work like
VS Code with a chat bot at its side, in this app's own design. `web/app/workbench/`. Since 2026-10-20 it is the
chat and Kerrigan only: the Sessions page, the task register and plans from JSON were removed, with their routes,
and so were the explorer's tree of sessions and the task and session tabs. Much of what follows below describes
them as they were, and is kept as the record of why the runner does what it does.

| Part | What it shows | What it does |
|---|---|---|
| Activity bar (far left) | the open folder's files; its git; the chat; how the page looks | switches the explorer, hides or shows the chat; the last icon opens the theme (System — the machine's, the default — Light, Dark), A− and A+, night light and the reading aids |
| Explorer | the open folder's files, each with an icon of its kind; or its git: the changes, staged and not, and the branch's commits | opens a file, or a file's two versions, in a tab |
| Editor | tabs: a file, coloured by its language (found from its name, its extension, its first line, or chosen), with line numbers, editable — saved with Ctrl+S over the version it was opened at, keeping its line endings; a file's two versions side by side | with nothing open: the folder the chat works in, and **Kerrigan** — a persona to save or copy for a chat of one's own, optional — with a short box under her button saying what she is, three things she is for and how to use her (2026-10-22) |
| Panel (below) | Terminal: the commands of the chat's latest message and their output; Problems: what did not go well in the conversation; Output: its events — each with an "i" saying what it shows | a problem brings its message into view in the chat; "Seen" takes it off the list |
| Chat (right) | the conversation, as it happens | a message is a task run in the open folder; "Plan mode" asks for a plan first, approved in the conversation; "Pause", which becomes "Continue" (the work holds at its next message or command; the time held does not count against the time limit); Stop; "New chat"; go back to before a message |
| Status bar | the folder and its branch, what is running, commands or plans waiting for an answer, the model | shows the running conversation in the chat; brings the waiting card into view |

**The chat** (2026-10-17, "like Windsurf"): the right panel is the chat of the open project folder (Settings →
project folder; "Open a folder" in the explorer changes it), not of a task. A message is sent to Copilot; the
commands it answers with run in the folder and their output goes back, round after round, until it says it is
done — shown as the conversation: the message, what Copilot says it is doing, a card per command with its exit
code and output, the summary, and the files it changed (each opens in the editor; "See the changes" shows the
diff). A command waiting for an answer is asked about in the conversation (and not in the banner, on this
screen). The next message goes on in the same Copilot conversation and on the same branch; one written while it
works is added to what it is doing. Enter sends, Shift+Enter is a new line; under the box are the model (with ↻ to
read the latest ones from Copilot) and whether commands wait for you. Each conversation is a session of kind
`chat` — no version control of the bot's own, no review, plan mode off — and each message a task of it, so every
rule of a task holds. Nothing is asked about branches (operator's rule, 2026-10-17): it works on the branch the
folder is on, with the operator's uncommitted work, and commits nothing; git is the operator's there (switching,
committing, stashing and pulling are allowed to the chat's commands; push, reset, rebase, clean and history
rewriting are not — `chatDenyPatterns`). Before each message the folder is photographed into a commit no branch
points at (`refs/copilot-operator/checkpoints/<task>`), and after it again (`…/after/<task>`), which is where its
changed files come from. ↶ on a message puts the folder back exactly as it was before it — branch, commit,
uncommitted changes — after photographing it as it is (`…/safety/<time>`), takes that message and the ones after
it out of the conversation (kept in `Session.rewound`), puts the message back in the box, and the next message
tells Copilot what was undone. `POST /chat/:id/rewind { taskId }`; `session/checkpoint.ts`. The explorer's
Files view and the editor read the folder as it is on disk. `GET /workspace`, `/workspace/files`,
`/workspace/file?path=`, `GET /chat/threads`, `POST /chat { text, threadId? }`; checked by `npm run check:e2e-chat`.
A task's own box (note, continue, new prompt) and its conversation are in its tab.

Ctrl+K (or Ctrl+Shift+P) opens a palette that finds any task, session, page or command; Ctrl+B hides the
explorer, Ctrl+J the panel, Ctrl+L puts the keyboard in the chat box. The chosen task is in the address
(`/?s=…&t=…`); the panels' sizes and which are open are kept in the browser. The list of sessions with the
run panel that used to be `/` is `/sessions`, one click away.

**Undo a task** (2026-10-14). "Undo only this task": in a session on one branch, the runner's own commits of
the task are reverted in one new commit on the session's branch, the tasks after it kept; a revert that
conflicts with later work is given up whole (`git revert --abort`) and says so. In per-task mode the folder
goes back to the task's start and its branch is kept. "Go back to before this task" is "Run again from here"
without the run: the line back at the task's start on a branch of its own, it and the tasks after it queued.
Both queue the task again and start nothing; nothing in git is deleted; the archived attempt records
`undone`. `GET|POST /sessions/:id/tasks/:taskId/undo`. **Accept as done**: a task that did not end done is
marked done by the operator, with what it was and why (`Task.accepted`). **Notes**: `Task.notes`, sent with
the task's next message — its opening, or the next report while it runs.

**Keep going until done** (2026-10-14): a task a limit stopped — messages, minutes, the reply wait, replies in
the wrong shape, rounds of fixing checks or review findings — is carried on at once in its own chat, from where
it got to, up to `limits.autoContinue` times (3; Settings → Execution → "Keep going after a limit"), so the
limits still bound it at (autoContinue + 1) × each. A task that blocked goes to a fresh chat, then waits; one
the operator stopped is never carried on. Events `task-auto-continue`, `task-auto-continue-ended`.

**Kerrigan's changes** (`src/plan/changes.ts`). `POST /kerrigan/report { sessionIds?, taskIds?, note? }` writes
what happened with ids and the answer's form; her answer `{"version":1,"changes":[…]}` — `continue`,
`newPrompt`, `runAgain`, `undo`, `accept`, `addTask`, `editTask`, `removeTask`, `note`, naming sessions and
tasks by id, number or title — is read by `POST /changes/check` against the sessions as they are and applied by
`POST /changes/apply` one by one through the same paths as the buttons, stopping at the first refused. Checked
by `npm run check:e2e-kerrigan`, `check:e2e-undo` and the browser checks.

## Concepts the UI is built around

**Session.** One Copilot conversation. Created with a name; the conversation itself is opened
by the first run and then reused. A session has a project folder, where its commands run, and
an ordered list of tasks. No file of the project is attached to the chat; it reads the project
with commands.

**Task.** One unit of work inside a session, with its own level 2 instructions and its own
prompt. Tasks run in order in the same chat, so a later task can build on what an earlier one
did. When one finishes with a summary, the next queued one starts. A task that ends any
other way stops the run and leaves the rest queued, because a failed task usually leaves the
machine in a state the next one did not expect.

**Level 1.** The base prompt about how the runner works: phases, json format, stop word, final summary,
the rules level 2 cannot override. Shipped in `prompts/level1.md`, shown above the tasks on
every session page, editable on its own page with a reset to the shipped version. Sent once
per conversation, on its own, and acknowledged before the first task goes out.

**Project files.** Per session: the project root, the directories to include and exclude, and
two switches over what is copied. The root can be typed or picked with the machine's own
folder dialog, which the API opens on request because a browser cannot hand a page a real
path. `.gitignore` is respected by default. `.env` files are decided by their own switch and
by nothing else, so a `.gitignore` that lists them cannot overrule it either way; turning it
on is confirmed once, because the copies reach OneDrive and the chat. A directory named in
both the include and the exclude list is refused by the page as it is typed and by the API
when it is saved. "Check what would be copied" lists the exact files without writing anything.

**Model.** Per session, by the exact name the chat's own picker shows. A standing default
lives in `data/settings.json` as `copilot.defaultModel` and is copied onto a session when the
session is created, so changing it later never changes what an existing session does. The list is never
hard-coded: it is read from the live picker on request, cached in `data/models.json`, and the
dropdown offers what came back. Reading it launches the browser and takes the profile lock, so
it is an explicit act by the user and is refused while a session is running. The choice is
applied once per run, right after the conversation is opened, and a model that is gone or out
of quota is reported rather than thrown: the run continues on whatever the chat is on and the
session records that as `modelInUse`. Empty means "leave the chat alone", which is the default
and how every session behaved before this existed.

**Independent review.** On by default, one panel per session: a switch and a model. When a
task finishes and its checks pass, a second conversation is opened that had no part in the work,
shown the task and the files that changed, and made to decide by running them. Its verdict shows
on the task card above the summary — that order is deliberate, since the summary is the
implementer's account of itself and the verdict is what says whether to believe it — and as a
badge on the register's row. Findings are listed with their evidence; one that is about the
task rather than the work, and one that came back after the implementer reported a fix, each
carry a chip saying so. A task can be `done` and still have been through two rounds of somebody
else finding things wrong with it.

**The clock.** Every task card says how long the task took, or, while it runs, for how long it
has been running, ticking once a second; the session page says the same for the session's
latest run under its header, and the register's run headers say it for each run. All of it is
arithmetic over the `startedAt` and `finishedAt` the record already keeps — grouped by the run
the tasks were started under — so nothing new is stored and nothing can disagree with the
timestamps. A finished card never re-renders for the clock; only a live one ticks.

**Not as the task said.** When the model declares it could not follow an instruction as
written — the option was removed in the installed version, the build rewrites the file — the
task card shows those deviations as a block of their own under the summary: the instruction,
what was done instead, and why. It is kept out of the summary on purpose, because it is the one
part of the outcome that is a decision the operator did not make. The register's row carries a
count. Review findings the model disputed — by the id shown in front of each finding, with the
model's evidence — get a block of the same kind, because a dispute is a disagreement between
two conversations that the next reviewer ruled on and a person may want to re-read.

**How a task can end.** `done` is the work finished and verified. `blocked` is the work not
done, reported by the model with what it tried and what is in the way — a result, not a
malfunction, which is why it is amber rather than red and why its reason carries the list of
approaches. `failed`, `aborted` and `limit-reached` are the machine's own words for a command
that died, an operator who stopped the run, and a ceiling that was hit. All four count towards
"did not finish" in the register's counter, and each is its own filter.

**Register.** `/history`: every task of every session in one place. Counters, then what is
running, then the queue in the order it will run with the next one marked, then what has been
done, newest first, each with its summary or the reason it stopped. Filters by session, status
and text, and three views: the flow, a flat table for scanning, and **by run**. Each row links
to the task's details on its session page and to its log.

Every row that has run carries **Restore** and **Run again from here**, the same two actions the
task card on the session page has. They are on the register because the register is where a
failure is noticed, and sending somebody to another page to act on the row they are reading is
the kind of friction that makes a feature go unused. Both share one implementation, so the
sentence that warns an operator what they are about to move exists once.

While anything is running, the register's own button in the header carries a pulsing `live`
badge. It is there rather than on the page because the point is to be visible from wherever you
are standing; it asks `GET /api/activity`, which answers from memory and reads nothing.

**Which tasks went out together.** Every task records the press of a start button it ran under:
an id shared by every task of every session started at the same moment, the time, and how many
sessions that was. A batch lives in memory and does not survive a restart, so the fact is
written onto the tasks as they start, and the register can still draw the line around it a week
later. Each row says `ran with N other task(s)`, and the **by run** view groups them properly —
one section per run, newest first, tasks inside it in the order they ran, and a last section for
tasks still waiting or old enough to predate the record.

**Appearance.** `/appearance`: the theme (warm light, warm dark) and four accessibility
switches — text size, higher contrast, less motion, underlined links, thick focus outline.
They are `data-` attributes on `<html>` that the stylesheet reads, stored in the browser and
applied by a small inline script before the first paint so there is no flash of the wrong
theme. Nothing about them reaches the API.

**Level 2.** The user's instructions for the project, the domain and the team. Written per
task, prefilled from the previous task, and saveable as named presets under `data/level2/`
for reuse across tasks and sessions. Sent with every task. Level 1 states inside itself that
it has priority; the composition only makes the boundary visible.

**Summary.** Copilot's closing explanation of what it did and what the result is. Required
by the schema whenever the status is `done`; a `done` reply without one is sent back. The UI
shows it as the outcome of the task. The stop word alone no longer ends a task.

## What the planning persona knows about these screens

The brief `/import` hands to a chat model carries a written description of every screen here, so
the persona can tell the operator to press **Create the sessions and tasks** rather than "import
the plan". That description lives in `src/plan/systemGuide.ts`: one entry per screen with its
route, and under it every control an operator would ever be told to press or read back, each with
its label in English and in Bulgarian and one sentence saying what it does. `src/plan/brief.ts`
embeds the rendered form of it with `systemGuideSection(lang)`, behind an instruction to quote
those words exactly and to name nothing that is not in the list.

The labels are a second copy of the ones in `web/lib/strings.ts`, because `src/` is the Node
server build and cannot import a browser module out of the Next workspace with no bundler in the
way. `test/guide.check.ts` — `npm run check:guide` — is what keeps the copy honest: it holds every
label and every section heading the guide quotes against that dictionary, key by key, in both
languages, and fails on the first character of difference.

The check goes two steps further, because matching the dictionary turned out not to be enough.
It reads `web/app` and `web/lib` and treats the pages as the authority: a key that is still in the
dictionary but that no page renders any more counts as a failure, since a label can be word for
word correct and belong to a control that was replaced — which is exactly what happened when the
log links became "save the log" buttons and three entries went on describing links that had gone.
And it reads the brief itself, where the phase scripts quote labels in prose (`**"Check it"**`,
`**„Провери“**`) rather than through the guide; every one of those quotes has to be the current
text of something on a screen too.

The contract, then: **a control renamed in `web/lib/strings.ts` is also renamed in
`src/plan/systemGuide.ts`**, and the check names the key when it is not. A new control the
operator would ever be told to press has to be added there too, or the persona does not know it
exists and will send them looking for something else. A control that disappears comes out — of the
guide and of the brief's prose alike.

## What a task keeps

Everything is under `runs/<runId>/` and the UI links to it:

| File | What |
|---|---|
| `task-log.txt` | the whole task as one text: the opening message, every iteration's report, the closing summary |
| `reports/iteration-N.txt` | exactly what was sent to Copilot after each iteration |
| `artifacts/` | files Copilot generated and the runner downloaded |
| `replies/NN-*.md` | every reply as received, plus the on-screen code blocks for comparison |
| `steps/` | the raw stream of each command |
| `transcript.jsonl` | every event |

The session's JSON under `data/sessions/` holds the task's first message, summary, final
reply, status and timings, so the UI can show them without reading the run folder.

## Approvals

In confirm mode the runner does not execute a step until someone says so. From the terminal
that is a keypress. From the web it is a pending approval: the API keeps it in memory, the
session page shows a sticky bar with the command and Run / Skip / Abort, and the runner waits
on a promise until one is clicked. Stopping the session aborts every pending approval at
once. A run that ends for any reason aborts whatever was still pending.

Unattended mode skips the question entirely and is behind a confirmation dialog in the UI. For the chat it is chosen
in Settings → Execution → "How commands run" and nowhere else (2026-10-23: the menu under the chat's box removed):
"Run commands without asking" asks once to confirm there, and every message reads it as it is sent.

**Plan first** (plan mode, 2026-10-13). Settings → Execution → "Plan first", and per session on its page
("As in Settings" by default; `planMode` in a plan's session): off, on with the plan approved by the
runner, or on with the plan approved by the operator. With it on, a task opens with a phase of its own:
the chat reads the project — what is already there, what is missing, what a change would affect — and
replies with status "plan" (`existing`, `approach`, `steps`, `files`, `verification`, `risks`). Nothing
changes in that phase: on the task's own branch whatever a round changed is put back and the chat told,
and a "done" before a plan is sent back. The plan is recorded on the task (`plan`, with its version,
who approved it and why, and the comments that asked for earlier versions to change) and shown on the
task's card. "I approve the plan" puts it on a card in the approvals banner — the plan in full, a note
for the chat, "Approve and start the work", "Ask for another plan" (the note says what to change, so it
is required) and "Stop the task" — only in a run that asks before each command; a run that does not
ask approves it itself and records why, so an unattended run never waits on a plan. The independent
review is given the approved plan and checks that the work followed it: an undeclared departure is a
finding. A task carried on (a limit, a new prompt) plans no more and keeps its plan. See
`src/orchestrator/planMode.ts`; verified by `npm run check:e2e-planmode`.

## Version control

On by default, per session, and the runner does the git itself. A step written by Copilot goes
through improvisation, the approval gate and an output pipeline already observed to mangle
text; branching and committing have to be exact, so they are not left to it. Level 1 carries a
section, composed only when this is on, telling Copilot the repository is already on a branch
made for the task, that the runner will commit, and that it must not branch, commit, stash,
reset or push. Read-only git is explicitly allowed.

Around every task:

| When | What happens |
|---|---|
| Before | The repository is checked, the base commit recorded, and a branch created |
| After | Everything the task changed is committed on that branch, whatever the outcome |

Two branch modes. `per-task` cuts every task's branch from the same session base commit, so a
task never sees what the task before it changed. `per-session` keeps the whole queue on one
branch, so each task builds on the last.

**Going back is additive.** Re-running a task does not reset anything: the attempt recorded
the commit it started from, and the new attempt branches from exactly that commit. The old
branch keeps everything the first attempt did, and the tree is back to the state the task
began with. There is no `reset --hard`, no forced checkout and no branch deletion anywhere in
this project.

**Nothing is ever pushed.** That is the operator's decision, made by hand, after reading the
branch. Two more refusals: a repository with uncommitted changes refuses the task, with an
explanation, because that work is the operator's, and a folder that is not a repository is
reported rather than initialised.

**Uncommitted changes can be a starting snapshot instead.** Version control → "Uncommitted
changes" → "Take them as a starting snapshot" (or tracked changes only; in a plan,
`"dirtyWorktree": { "policy": "snapshot" }`). Before the first task the page lists every
uncommitted file, each set to "Include in the starting snapshot" or "Leave out of the run";
"Take the starting snapshot" commits the included ones as "Capture operator baseline before
run" on `cop/baseline/<session id>`, and the session's branches are cut from that commit. The
operator's own branch is not moved. Secrets (`.env*`), tool output and files outside the project
folder are never included; an ignored file only when a task's scope names it and it is ticked. A
left-out file goes into the repository's `.git/info/exclude` (local, never committed,
`.gitignore` untouched), because a file left loose would be swept into the first task's commit or
removed by a scope. Until the snapshot is taken, a run of the session is refused and nothing
changes. With "Show me the list to approve first" unticked, it is taken when the first task
starts, and refused if anything would have to be left out. Not available when carrying on an
existing branch. Verified by `npm run check:snapshot`.

**Input files and artifacts.** Version control → "Input files" names, one pattern per line, the
files the operator provides for the work (in a plan, `"userInputs": { "paths": [...] }`). New,
changed or ignored ones are listed with their size and git status in the snapshot list and go
into the starting commit as "Capture user-provided inputs" once approved; a later session whose
start lacks them — `startFrom: "branch"` after a session that captured them — has them committed
on top of that start on `cop/input/<session id>`, from where they were last committed, without
touching the working tree. Their SHA-256 sums go on the session's start and into the work export.
"Read-only while the tasks run" (on by default) puts back a changed, deleted or added input after
every round of steps and tells the chat; a task that ends with one that could not be put back
fails. The comparison is by git's blob id, so `core.autocrlf` does not make untouched files look
changed. "Artifacts" names the evidence the work writes (`"artifacts": { "paths": [...] }`): the
patterns go into `.git/info/exclude`, so it is never committed and `.gitignore` is untouched, and
when each task ends the files are copied to `runs/<run>/artifacts/project/` with their sums.

**A chain needs one branch to continue.** `startFrom: "previous-session"` after a session that
ran per task with several done tasks is refused at the start, naming the tasks whose work is not
on the branch it would continue — each task's work is on its own branch — and the plan import
warns about it. Verified by `npm run check:inputs` and `npm run check:e2e-inputs`.

**With version control on, a task is done only when its work is committed** (from the feedback
on 0.1.18, 2026-10-02). A commit that fails — another git holding the index, the repository moved
to another branch mid-task, files left uncommitted after it — ends the task failed with why, its
work left in the working tree. Version control that is on but cannot work — a dirty tree, a starting
branch that is not there, a predecessor that has not finished — refuses the task before anything is
sent, instead of running it without branches. The session before a `previous-session` chain must
have finished; it is continued from its final commit, or, when its result is artifacts only, from
where it started. Input files changed or added after a session started are listed under "Uncommitted
changes" and, once approved, committed on its line of work ("Capture user-provided inputs"); the guard
holds each task to the inputs of its own starting commit and never removes a file that was there
before the task. Artifacts kept with a run are only the files a task created or changed, inside its
scope, or under its declared `outputs`; an artifacts pattern that covers the input files is refused.
Every export and attempt record says which copilot-operator made it (`botVersion`), and the System page
shows it. A session's start is recorded only when its first task gets past the whole preparation:
a task refused before that (input files not there yet) leaves nothing behind, so its retry starts
afresh, with the starting snapshot offered for approval (reported on 0.1.18, run 20261002-175647).
Verified by `npm run check:e2e-commit`, `check:e2e-retry-inputs`, `check:inputs` and `check:e2e-inputs`.

**Prepare version control for this run** (feedback of 2026-10-02: version control should be light,
offer its fixes in the UI, and be settled before the browser opens). On the Sessions page the ticked
sessions are grouped by repository; a repository that is not ready shows one box: the repository,
its current branch and HEAD, the base branch the plan asked for and its HEAD, the sessions and how
each starts, the input patterns, the matched input files with status and size, and any other
uncommitted files apart. Each fix says exactly what it does before it is pressed: "Review input
files"; "Create starting snapshot on <baseBranch>" (recommended when the plan names a base branch the
repository is not on) — the base branch's tree plus the approved inputs only, made with a temporary
index, no branch switched and the checkout untouched, shared by every session of the run starting
from that branch and carried on by the chained ones; "Create starting snapshot on <current>"; "Use the
current branch instead"; "Take uncommitted changes as a starting snapshot"; "Cancel". The run buttons
stay off while a box is open, and a start — of one session or of several — is refused before the
browser opens, with nothing sent. The work export's `baseline` names the commit, the target base, the
approved inputs with their sums, the approval, the sessions, and whether a session inherited it. A
task refused before it ran keeps no artifacts. Verified by `npm run check:e2e-run-vcs`.

**Where the work starts, asked at every start** (2026-10-13). Every start button — the Sessions page's
run buttons, a session's Start, "Run this task", the register's Continue and "Run only this one again"
— opens the start window first ("Where the work starts"), and only its own button starts anything.
For each session it offers a local branch, as it is in the folder (nothing fetched), or a remote
branch — picked from the list as last fetched, or typed, for a branch a colleague has just pushed —
which is fetched when the window's button is pressed, through Git's own password window when the SSH
key has a passphrase ("Get the list of branches from the remote" fetches the whole remote); for a
session after another in the same repository, the session before it. "Work directly on this branch"
makes it carry on the branch itself instead of a branch of the bot's own cut from it; from a remote
branch the local branch is made from it or fast-forwarded to it first, and one that went its own way
is refused with nothing changed. The choice is written on the session (`startFrom`, `baseBranch` or
`existingBranch`, and `baseRemote` for a remote branch, which the run reads as
`refs/remotes/<remote>/<branch>` and never fetches again), every session's choice is checked before
any branch moves. A session that has run is shown where it started — its branch and commit then and
now, the branch's commit on the remote as last fetched, and a warning when the repository is on another
branch — with "Keep: carry on <branch>" chosen first, "The branch checked out now: <branch> (<commit>)",
and every other choice beside them; the window's button names the branch and commit the work starts on.
Another start for it (`rechoose`) is recorded as `startRechosenAt`: the tasks that run next — a task run
again too — start from it, not from where their first attempt started, a session on one branch gets a
fresh branch name, and what already ran stays on its branches. A session with a task carried on from an
earlier attempt keeps its start ("Fix the prompt and queue it again" starts that task over). "Read the
branches again" reads the repository afresh after a checkout made outside the bot. A repository not ready only
because of where a session starts keeps the run buttons on: the window settles it. See
`src/vcs/startChoice.ts`; verified by `npm run check:startbranch` and the browser checks.

**A start that did not happen** is said with where it stopped — not let in, the chosen branch, the
version control check, the browser, the run before its first task, a later session at its turn, or
the bot itself — the error, and two downloads: "Download what happened (error, run record and
terminal)", a text file with the run's own record, the sessions' events and every line the bot's
console printed from the press until a few seconds after; and "Download what the terminal showed"
(also on the System page). The console of the API process is copied, line by line with its time, to
`<data>/logs/terminal.log` (rolled over at 5 MB) and kept in memory for the downloads; secret-shaped
text is taken out of them. A refusal is the answer to the press, in the start window and under the
run buttons; a run accepted and then unable to begin — Edge or its profile would not open — is shown
on every page until it is closed. See `src/session/startFailure.ts` and `src/log/terminal.ts`.

## One chain, or independent tasks

A queue can be either, and the runner cannot guess which. The choice sits above the tasks and
belongs to the session:

| Setting | What the queue does |
|---|---|
| Stop at the first failure (default) | A task that does not end with a summary stops the run; the rest stay queued |
| Carry on with the next task | Every queued task runs, and the failures are read afterwards in the register |

Stopping is the default because a suite is usually a chain: a later task builds on what an
earlier one did, and running it against a machine in an unplanned state is worse than not
running it. Carrying on is for a set of independent checks that merely share a conversation.
Either way the decision is announced in the event stream when it is taken, so the log says why
the run stopped or why it did not. It cannot be changed while the session is running, and
`execution.continueOnFailure` is the value a session created from the terminal starts with.

## Running the rest without asking

In confirm mode the approval bar has a fourth button: run this step and stop asking for the
rest of this run. It answers the step on screen with Run and flips the run to unattended from
the next step onward. The deny list is untouched: that gate lives in the policy and runs
before anyone is asked, in both modes. While a run is in that state the header says so and
offers the way back, which applies to every step not yet proposed.

## Running a task again

Any task that has finished can be put back in the queue, one that succeeded included. The
attempt that just ended is archived on the task rather than overwritten: status, timings,
iterations, summary and reason are kept, and each attempt keeps its own folder under `runs/`,
so nothing is overwritten on disk either. The first attempt keeps the original folder name and
later ones get `-a2`, `-a3`. Earlier attempts are listed under the task, each with a link to
its own log. The task is not resumed, only queued again: it ran commands on this machine and
how far it got is unknown.

A finished task can also be **edited**, and saving that edit queues it again, because the two
cannot be separated honestly. The attempt that ran is archived together with the title, prompt
and level 2 it ran with, so its summary keeps standing under the question it actually
answered; only then is the new text applied. Editing in place would leave an old attempt
claiming it was asked something that was written afterwards. A task the runner is inside of is
the only one closed to edits.

**After a failure, which way on** (2026-10-13). A task that failed or blocked on its work offers, on its
register row and its card:

| Button | Where the work starts | The chat |
|---|---|---|
| "Continue with a new prompt" (marked first) | from where it got to: its own branch, the failed attempt's work in the tree | its own conversation, told how the attempt ended and why — the runner's reason, the checks that did not pass, what the review found, its summary — then given the new prompt |
| "Fix the prompt and queue it again" | over, from where the task first started; the failed work stays on its own branch | the session's conversation, sent the rewritten task |
| "Run only this one again" | over, as above | the task sent again as it is |

The new prompt is added to the task's own, never put in its place: the assignment, its checks and its
expected result stand, and the chat is told that where they disagree the new prompt wins. It is kept on
the attempt it was given for (`TaskContinuation.instruction`, with `ended`), shown on the task card, and
a second failure takes a second prompt the same way. "Continue where it stopped" — after a limit, the bot
stopping or the operator — takes an optional new prompt too. A task that contradicted itself never
started its work and is not carried on: its fix is the way on. Verified by `npm run check:continue`,
`check:e2e-continue` and the browser checks.

## Taking the record away

`Download the work` on the session page builds one text file out of the tasks that are ticked,
or all that have run when nothing is ticked. Two shapes:

| Variant | What is in it |
|---|---|
| Expected and actual | Per task: the task as written, the level 2 sent with it, and what came back at the end |
| The whole conversation | The same, plus every message in order: the opening message, each report sent back, each reply received |

The document is built from the session file and the run folders, so a task whose run folder
has been cleaned still exports what the session kept. Nothing leaves the machine: the file is
assembled by the API and saved by the browser.

## Interrupted runs

A task's status is on disk; the approval it waits for is in the memory of the process that
asked for it. So a restart, a Ctrl+C or a crash used to leave the task saying "waiting for
approval" with nothing left to answer it: not queued, so no run would pick it up, and the
session looking busy when it was not. The API now closes them as it starts, before it serves
anything: every task found running or waiting for approval is marked aborted with the reason,
and its session is set back to idle. They are not re-queued, because the task ran commands on
this machine and how far it got is unknown; re-running it could repeat them. Copying the
prompt into a new task is the operator's decision.

A task can be deleted unless the runner is inside it. That covers queued tasks, finished ones
the user wants out of the register, and the recovered ones. The run folder under `runs/` is
never touched by a deletion, so what was executed stays on record.

## Live updates

The API streams every event of a session as server-sent events at
`/api/sessions/:id/stream`, replaying the recent history first so a page opened mid-run
catches up. The page shows them in a log and refetches the session whenever something
arrives, so statuses, approvals and summaries stay current. There is also an 8 s poll as a
fallback.

## Endpoints

```
GET    /api/health                   GET /api/doctor
GET    /api/settings                 PUT /api/settings
GET    /api/level1                   the base prompt as it ships, to read (not edited since 2026-10-20)
GET    /api/kerrigan?lang=           the persona: limits, projects with their branch and level 2; ⟦key⟧ names outside en/bg
GET    /api/project                  PUT /api/project     the projects: folder, branch, level 2 (for Kerrigan)
GET    /api/sessions                 GET|PUT /api/sessions/:id     (the chat's conversations)
GET    /api/sessions/:id/tasks/:taskId/story | changes | changes/file | exchange
GET    /api/sessions/:id/events      recent history
POST   /api/sessions/:id/start       { mode: "confirm" | "unattended" }
POST   /api/sessions/:id/stop        POST /api/sessions/:id/pause    POST /api/sessions/:id/resume
GET    /api/start/failures           GET /api/start/failures/:id/report
GET    /api/terminal
GET    /api/workspace                GET /api/workspace/files   GET|PUT /api/workspace/file
GET    /api/workspace/git            GET /api/workspace/git/commit   GET /api/workspace/git/file
GET    /api/chat/threads             POST /api/chat { text, threadId?, model?, manualModel?, lang?, planMode?, review?, lead?, workerModel?, workerManualModel? }
POST   /api/chat/:id/rewind
GET    /api/approvals                POST /api/approvals/:id   POST /api/approvals/:id/plan   POST /api/approvals/:id/answer
GET    /api/activity                 running, starting, acting (who is at work), paused
GET    /api/models                   POST /api/models/refresh   PUT /api/models/default   PUT /api/models/review-default
POST   /api/login                    POST /api/browse-folder   PUT /api/home (the bot's folder from the next start)
```

## Settings

**Go to File, Search, Markdown (2026-10-21).** As in VS Code: Ctrl+P opens "Go to File" (`quickOpen.tsx`, the
letters matched by `lib/fuzzy.ts`; `name:42` opens at line 42); Ctrl+Shift+F, or the magnifier in the column of icons,
the Search view (`searchView.tsx`): Match Case, Match Whole Word, a regular expression (PCRE), the files to include and
to exclude as globs, results by file with their counts and the matches marked; a result opens its file at the line
with the match chosen. The server searches with `git grep` in a process of its own with a time limit
(`session/workspaceSearch.ts`, `GET /api/workspace/search`): what .gitignore leaves out and files that are not text are
not searched, files not committed yet are. A Markdown file opens as it reads (`markdownView.tsx`, our own renderer):
"Code", "Side by side" and "Preview" above it, Ctrl+Shift+V; ```mermaid blocks are drawn by the `mermaid` package
(12.2.0, bundled, loaded only by a page with a diagram, strict security). HTML in the file is shown as text; a picture
of the folder comes through `GET /api/workspace/raw`, which serves only pictures; one from the internet is not fetched.

**Skills (2026-10-21).** Settings → Skills keeps instructions for a kind of task that comes back — a new test, a
new entity, a migration: a name to call it by (`new-test`, lowercase with hyphens), a line on what it is for, the
project it is for or every project, and the instructions (`skills` in the settings, `GET`/`PUT /api/skills`). A
message is sent with one chosen under the chat's box (`#cs-skill`, only the skills for the open folder and for every
project) or by starting with `/its-name`; the task keeps the skill as it read then (`Task.skill`), and its opening
carries it right before the task under "## Skill: <name>" (`skillBlock` in `session/compose.ts`). With two chats the
lead is given it with the assignment and the worker with every subtask. Kerrigan lists the skills.
Under the chat's box a skill is listed by its name alone (`/new-test`), what it is for on hover; beside them, always —
with none yet too — **+ Skills** opens `/settings#skills` (2026-10-23). A section of Settings reached by its address is
brought into view, given the focus and lit up for a moment, a ring that pulses three times (`useSpotlight`, `.spotlight`).

**The panels (2026-10-21).** The explorer, the editor with its panel and the chat sit in three places; the grip ⠿ in
each one's head drags onto another to swap the two, or opens a menu of the places (`web/app/workbench/panelGrip.tsx`).
The order is kept with the layout in this browser; "Put the panels back where they were" (Ctrl+K) undoes it. The
left and right places keep their widths, the middle takes the rest.

**Appearance, cursors, scroll bars (2026-10-21).** "Appearance" sits in the bar on top, after System and before the language (between Settings and System until 2026-10-22),
on every page. The page draws its own cursors, in the theme's colours (`--cur-*` in globals.css), with "The system's
cursor" among the reading aids to put Windows' back (`data-cursor`); scroll bars are thin and rounded, in the theme's
muted colour. The arrow is close to Windows' own, its corners rounded and a light stroke along its edge, so as not to
bother; over what can be clicked, a pointing hand, its fingertip the spot.

**The editor of VS Code (2026-10-22).** A file opens in Monaco, the editor of VS Code (`monaco-editor` 0.57.0, MIT;
`codeEditor.tsx`): colours and line numbers, find and replace, several cursors, folding, the minimap, IntelliSense
for TypeScript, JavaScript, JSON, CSS and HTML from its workers (`workbench/monaco/*.worker.ts`, modules of the page's
own), VS Code's keys. No problem is underlined (2026-10-23): the services check a file alone, without the project's
`node_modules` or settings, and marked mostly what was not so — their validation is off and
`renderValidationDecorations: 'off'`; colours, completion and hover stay. It is bundled with the page and loaded only when a file is opened; nothing is fetched from the
internet. Its theme follows the page's, and its size the text size; it keeps a file's line endings. The file view
keeps the text: what is typed is handed up, and a text set from outside — read again from disk, "Revert my changes" —
comes with a new `reset` and replaces the editor's (a value merely handed back is never put back: that scrambled fast
typing). Save is an editor action, not a command: Monaco keeps a command for the page, and Ctrl+S saved the file opened
last. The language picker still chooses its language. DOMPurify, which Monaco brings, is held at 3.4.17 by
`overrides` in package.json (`npm ls` calls that "invalid" in a workspace; it is not). The package carries
`dist/web/third-party-notices.txt`: the licences of everything the interface is built from
(`scripts/thirdPartyNotices.mjs`).

**On this branch (2026-10-22).** At the top of the git view, every file the branch changed, as a pull request shows
them (`branchChanges` in `session/workspaceGit.ts`, `GET /api/workspace/git/branch`, `branchChanges.tsx`): against the
branch it would go into — the remote's default, else main or master, or one chosen in "Compared with", kept for the
folder — from where it left it (`git merge-base`), its commits and what is not committed together, the files git does
not track among them. Each file has its letter and lines, and a dot when something of it is not committed (staged, not
staged, not tracked, or staged and changed since); "All", "Committed" and "Not committed" filter them. A file opens as
the pull request shows it: where the branch began against the file as it is now (`area: 'branch'`). The branch's own
commits are marked in "Commits", with a line where it left the base. The base asked for must be one of the branches
listed; nothing else of the request reaches git.

**The clock stops while paused (2026-10-21).** `Hold` keeps each pause from "Pause" pressed to "Continue" — from
the press, not from the point the work holds at a little later — and the runner takes them off a task's minutes
against `maxRunMinutes`; the task keeps how long it was paused (`pausedMs`). A running session's pauses come with it
from the API (`pauses`), and the status bar takes them off the minutes it shows (`web/lib/paused.ts`), so they stand
still while paused.

**The lead's list of subtasks (2026-10-21).** "1 of 20 subtasks" read as if twenty were planned, when twenty is only
the most the lead may give. The lead now sends its whole list (`todo` in `protocol/leadSchema.ts`, required with every
plan and every subtask): each subtask "done" (once it has accepted the report), "running" (the one given now — exactly
one, the runner makes sure), "planned", "blocked" or "failed", each in a phase if the plan has phases. The runner keeps
it as `LeadRecord.ledger` (`orchestrator/leadLedger.ts`), its version going up when subtasks are added, dropped or
reordered, and gives it back to the lead with every report. Under the message (`leadPlan.tsx`): "Phase 2 of 4:
Diagnosis", "Subtask 3 of 8 planned", "5 to go · at most 20 allowed", the list by phase under a fold; where the list
was made or changed, the conversation says so ("The plan was updated (version 2): +1 new"). While the worker works,
it is named by the subtask's title; "#2" in the list is the order it was given in. A message without a list says
"Subtasks used: 1 of at most 20".

**Who works, and who asks (2026-10-22).** Four actors (`Actor` in `session/model.ts`): plan mode (the chat writing its
plan; nothing changes yet), the lead (of two chats), the worker (the chat that does the work — the worker of two chats,
or the one chat), and the reviewer. The runner says who is at work as it passes from one to another
(`Task.acting`, the `acting` event; `actingNow` in `taskRunner.ts` and `leadRunner.ts`), and `/api/activity` answers it
from memory with `acting` and `paused`. Every card carries who asks (`PendingApproval.actor`): a command while
planning is plan mode's, after the plan the worker's, in the review the reviewer's; a model card is the conversation's
(`actorOfSession`: worker, lead, plan mode first, else the worker); a plan is plan mode's or the lead's; a question is
the lead's. Shown as one coloured mark (`web/app/actor.tsx`, words in `web/lib/actors.ts`): "Asked by: Reviewer" on
the cards, the name on the line "Working…" and along the bottom. While the bot works, **LIVE** sits beside "Chat"
(red; amber while paused; on hover who is at work), and the browser tab reads "● Worker at work — copilot-operator" —
"(1) waiting for you" first when something waits for the operator.

**The tab's title, and the export (2026-10-23).** The browser tab says what stage the bot is at, in English whatever
the page's language (as the operator asked): "Working." "Working.." "Working..." round again while it works,
"Starting...", "Paused", "Waiting for you (n)" first when something waits; when it stops, how the last message ended —
"Done", "Error" (failed), "Stopped", "Blocked", "Limit reached" (`tabTitle`, `OUTCOME_WORDS` in `web/lib/actors.ts`;
`/api/activity` gives `last`) — until the operator has had the page in front of them for 12 s. System → "Export
everything the bot keeps" downloads one .zip (`GET /api/home/export`, `?runs=1` for every run's records;
`config/exportHome.ts`, `util/zip.ts`, written with `zlib` alone): `data/` and a `manifest.json`; never the API's key,
nor the Edge profile with the Microsoft 365 sign-in.

**Platforms, questions with answers to click (2026-10-23).** A command that reaches a platform with the operator's
access — Azure (`az`, Az PowerShell), AWS, Google Cloud, GitHub (`gh`), GitLab, Jira, Vercel, Netlify, Heroku,
Cloudflare, Kubernetes, Terraform, Microsoft Graph, Exchange Online, publishing to npm, a container registry, NuGet,
PyPI and the like (`exec/platforms.ts`, read by the programs and cmdlets a line starts) — waits for the operator in
every mode, an unattended one too, and is never "run the rest" (`HeldFor.platform`, `PendingApproval.platform`; the
card says which platform). The chat may ask the operator with `"status": "ask"` (`question`, `why`, at least two
`options`, its recommended first; `replySchema.ts`, `prompts/level1.md`): a card in the conversation with its answers
to click, the first highlighted, and a field for another; an answer may carry `run`, a command the runner runs at once
when it is chosen — the click being its permission, the refusing rules still applying — its output going back with the
answer. The lead is told to always give answers too. Settings → Execution → "Questions from the bot":
"Ask me" (default) or "Agree with what the bot proposes" (`execution.questions: agree`, confirmed when chosen):
platform commands run and every question — the chat's, the lead's — takes the first answer, the conversation saying so.

**Three models, and "Saving..." (2026-10-23).** Settings has a model for the worker (`copilot.defaultModel`: the one
chat, or the worker of two chats), for the lead (`copilot.defaultLeadModel`, `PUT /api/models/lead-default`; none
chosen, the worker's) and for the review (`copilot.defaultReviewModel`) — three alike sections (`RoleModelSection`),
each with the same choices, "Clear", "Read the list from Copilot", when it was read, and its own "Choose the model by
hand" (`manualModel`, `leadManualModel`, `reviewManualModel`; the last two as the worker's until set). `effectiveModels`
and `modelByHand` read the part's own; the worker takes its own, else Settings' worker model, else the lead's (as before). Under every section, "saved as
you type" is gone: a write shows "Saving." "Saving.." "Saving..." round and round for at least 1.6 s (`useSaving`,
`SavedNote`), after typing stops, a tick or a choice.

**The logo and the icon (2026-10-22).** An aeroplane crossing its orbit, drawn once in `web/lib/brand.ts`: beside the
name in the bar on top of every page (`app/logo.tsx`, coloured by the theme from `--logo-plane` and `--logo-orbit`:
dark blue on light, light with a sky-blue orbit on dark), and as files in `docs/brand/` (`logo-light.svg`,
`logo-dark.svg`). The tab's icon (`app/icon.svg`, which Next names in every page's head) is the aeroplane alone,
dark blue with a white edge, so it shows on a light browser and a dark one. `check:brand` holds the files to the
drawing and the icon's colours to WCAG contrast on both.

**The operator's messages (2026-10-22).** Each is headed "You · Your message 3 · 10:42" and filled — white on the
accent (`--you-bg`, `--you-ink`, `--you-soft`) — where everything else in the chat is on the panel; it moves with the
conversation (kept on top for a day, which the operator did not want, 2026-10-23).

**Skills deleted, the review's model in the chat, what each setting is for (2026-10-21).** Each saved skill has its
name and "Delete" (red, with a bin) on top of its card; it asks first. With "Review" ticked under the chat, the review's
model is chosen under the work's (`#cs-review-model`): "As in Settings (…)" is Settings → Model for the review; another
is the conversation's own (`review.model`, `reviewModelSource: 'operator'`), sent with the first message
(`reviewModel` of `POST /api/chat`) or set on an open conversation. Every ⓘ of Settings says what its field does, an
example, and its default; a list's ⓘ says what each of its choices means, a paragraph each.

**Pausing between messages, counting them (2026-10-21).** Settings → Execution → "Pause between messages"
(`pacing.gapEnabled`, `gapSec`), and under it "Random time" (`gapRandom`, `gapMaxSec`): a message to Copilot waits until
that long has passed since the one before, whichever conversation it went to (one clock for every `Pacer`, see
`util/pacing.ts`); the log says how long. With two chats, the lead's message keeps how many messages went to the lead
and to the worker (`LeadRecord.messages`); the status bar and the message show both and their sum.

**Projects for reference only (2026-10-21).** Each project in Settings has "For reference only (no
changes)" (`project.readOnly`, `project.others[].readOnly`). When a task begins, every such project
it can reach is photographed (`src/vcs/referenceGuard.ts`): its files that git does not ignore, its
branches, tags and stash, HEAD and what is staged — in a repository of its own in a temporary
folder, so nothing is written into the project. After every step, the implementer's and the
reviewer's, it is photographed again; whatever changed is put back as its exact bytes, refs and the
index as they were, the step's output says so, and the rest of that round is not run. The chat is
told about these projects before it starts; on the chat's own folder marked so, every message can
only read and report. Files git ignores are not watched.

**Script files (2026-10-21).** A chat's step may run a script file — `.ps1`, `.psm1`, `.cmd`, `.bat`,
`.sh`, `.vbs`, `.wsf` — only when it is the project's own: committed, unchanged, last committed by
someone other than the runner and before the work began (`ownScriptRefusal` in
`src/exec/scriptFiles.ts`); nothing in `.cop-tmp` is run. The operator's own checks are not held to
it. Commands themselves always run as text given to the shell.

`data/settings.json`, same shape as `run.example.yaml`, everything optional. The System page
shows what is saved and what it resolves to. Sign-in stays in the terminal on purpose, so the
bot never handles credentials: `npx tsx src/cli.ts login --account <upn>`.

**The bot's folder (2026-10-22).** Installed from npm, the bot keeps its settings, conversations,
logs, its key and its Edge profile in `%LOCALAPPDATA%\copilot-operator` — never in the project,
unless the operator chooses that. System → **The bot's folder** shows where it is and whether it is
the default, chosen, set by `COP_HOME`, or the clone itself; **Change…** (a field, **Browse…**, and a
checkbox to copy what is there, so the sign-in stays) writes the choice to `location.json` in the
default folder, and the next start uses it (`installLayout`, `chooseHome` in `src/config/home.ts`).
Nothing in the new folder is overwritten. Refused while work goes on, inside the program or
`node_modules`, inside the current folder or holding it, or where it cannot be written. A version
before 0.1.56 kept the records in `<project>\.copilot-operator`: the first newer start copies them
over once (`moveLegacyHome`) and System says from where. Steps are refused when they name the
folder by any spelling, `%LOCALAPPDATA%\copilot-operator` included (`botSelfRefusal`).

**Whose Edge has the profile (2026-10-22).** "Profile in use" says whose Edge it is: the bot's own
for a run, the bot's own chat window (kept open between messages — nothing to do), another Edge
(close it or end its processes: the bot cannot open its browser meanwhile), or free. Until then
any Edge on the profile while no run was going read "a run would fail; close that window" — the
chat's own window too. The bot's own is told by the Edge main process's parent being the API
(`profileHolder` in `src/transport/profileLock.ts`). The Desktop row is gone: it was left from the
Desktop copies removed in 0.1.14.

## Running it

```bash
npm install           # once; installs the web workspace too
npm start             # builds the API, then runs API and UI together; Ctrl+C stops both
npm run dev           # the same, and opens http://localhost:3210 in the browser
```

Separately, if you prefer two terminals: `npm run api` and `npm run web`.

Do not run `npm run web:build` while `npm start` (or `npm run web`) is running. Both use
`web/.next`, and a production build overwrites the chunks the dev server is serving, which
shows up as "Cannot find module './NNN.js'" in the browser. Stop the dev server, build, start
again; or just delete `web/.next` and reload.

`scripts/dev.mjs` is the starter. It builds first because Nest needs the decorator metadata
only `tsc` emits, prefixes each process's output with `[api]` or `[web]`, and stops both when
either exits or on Ctrl+C. It stops the whole tree, because a plain kill reaches only the npm
wrapper and leaves the real server holding its port — `taskkill /T` first, and `taskkill /T /F`
only for what is still running after a few seconds. The API token goes to the web process
only, never to the API's own environment (see `web/lib/api.ts`).

The API is bound to `127.0.0.1` and the UI to `localhost`. They must stay that way: this
process drives the operator's own signed-in browser and runs commands on this machine.
