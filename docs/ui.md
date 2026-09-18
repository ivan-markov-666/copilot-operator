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

**Level 1.** The contract with the runner: phases, json format, stop word, final summary,
the rules level 2 cannot override. Shipped in `prompts/level1.md`, shown above the tasks on
every session page, editable on its own page with a reset to the shipped version. Sent once
per conversation, on its own, and acknowledged before the first task goes out.

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
GET    /api/dirs?root=               selectable directories of a project
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

`scripts/dev.mjs` is the starter. It builds first because Nest needs the decorator metadata
only `tsc` emits, prefixes each process's output with `[api]` or `[web]`, and stops both when
either exits or on Ctrl+C. On Windows it does that with `taskkill /T`, because a plain kill
reaches only the npm wrapper and leaves the real server holding its port.

The API is bound to `127.0.0.1` and the UI to `localhost`. They must stay that way: this
process drives the operator's own signed-in browser and runs commands on this machine.
