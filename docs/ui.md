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

## Concepts the UI is built around

**Session.** One Copilot conversation. Created with a name; the conversation itself is opened
by the first run and then reused. A session has an optional project mirror (which project,
which directories) and an ordered list of tasks.

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

Unattended mode skips the question entirely and is behind a confirmation dialog in the UI.

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
branch. Two more refusals: a repository with uncommitted changes is left alone with an
explanation, because that work is the operator's, and a folder that is not a repository is
reported rather than initialised.

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
GET    /api/health
GET    /api/doctor
GET    /api/settings                 PUT /api/settings
GET    /api/level1                   PUT /api/level1      DELETE /api/level1 (reset)
GET    /api/presets                  PUT /api/presets/:name   DELETE /api/presets/:name
GET    /api/sessions                 POST /api/sessions
GET    /api/sessions/:id             PUT /api/sessions/:id    DELETE /api/sessions/:id
POST   /api/sessions/:id/tasks
PUT    /api/sessions/:id/tasks/:taskId          DELETE (queued only)
GET    /api/sessions/:id/tasks/:taskId/log      text/plain
GET    /api/sessions/:id/tasks/:taskId/files    { reports, artifacts, replies }
GET    /api/sessions/:id/tasks/:taskId/files/:kind/:name
POST   /api/sessions/:id/start       { mode: "confirm" | "unattended" }
POST   /api/sessions/:id/stop
GET    /api/sessions/:id/events      recent history
GET    /api/sessions/:id/stream      server-sent events
GET    /api/approvals?session=       POST /api/approvals/:id { action: run | skip | abort }
GET    /api/tasks                    every task of every session, for the register
GET    /api/activity                 { running, sessions, batch } — in-memory, safe to poll
GET    /api/sessions/:id/tasks/:taskId/restart   what starting again from here would do
POST   /api/sessions/:id/tasks/:taskId/restart   { restore?, start?, mode?, onFailure? }
GET    /api/models                   the cached model list plus the default for new sessions
POST   /api/models/refresh           re-reads the chat's model picker (opens the browser)
PUT    /api/models/default           { model } the model new sessions start on
PUT    /api/sessions/:id              { onFailure, vcs } queue behaviour and version control
GET    /api/sessions/:id/vcs          can version control work here, and on which branch
POST   /api/sessions/:id/tasks/:taskId/rerun    queues a finished task again
POST   /api/sessions/:id/mode        { mode } asks or stops asking, mid-run
GET    /api/sessions/:id/export      ?variant=full|outcome&tasks=id,id  downloads the record
GET    /api/dirs?root=&gitignore=    selectable directories of a project
POST   /api/browse-folder            { start? } -> opens the machine's folder dialog
POST   /api/mirror/preview           what the selection would copy, without writing anything
```

## Settings

`data/settings.json`, same shape as `run.example.yaml`, everything optional. The System page
shows what is saved and what it resolves to. Sign-in stays in the terminal on purpose, so the
bot never handles credentials: `npx tsx src/cli.ts login --account <upn>`.

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
either exits or on Ctrl+C. On Windows it does that with `taskkill /T`, because a plain kill
reaches only the npm wrapper and leaves the real server holding its port.

The API is bound to `127.0.0.1` and the UI to `localhost`. They must stay that way: this
process drives the operator's own signed-in browser and runs commands on this machine.
