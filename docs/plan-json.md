# Plans: importing sessions and tasks as JSON

Writing a queue of tasks by hand in the UI is fine for two tasks and tedious for twelve. A
plan is the other way in: the operator describes the work to whatever chat model they already
use, that model interviews them and answers with one JSON document, and this system turns the
document into sessions and queued tasks.

The model that writes the plan is not the model that runs it. It has no connection to this
process, no tools and no access to the machine — it is a person's chat window, and the only
thing crossing the gap is text the operator pastes. Everything in this feature follows from
that: the format is validated rather than trusted, refusals are written to be handed back to
a chat, and an import never starts anything.

## The three steps

1. **Take the brief.** `Plan from JSON` in the UI builds a brief and copies it. It says what
   this runner is, tells the model to interview the operator before writing anything, and
   pins the format with a filled-in example.
2. **Bring the answer back.** Paste it, drop a `.json` file on the box, or pick one. Prose
   and code fences around the JSON are stripped. `Check it` validates without creating
   anything; `Create the sessions and tasks` validates and then creates.
3. **Start it yourself.** The import ends with a queue and an untouched Start button. That is
   the point at which someone reads what a chat model decided on their behalf.

## The brief asks; the page does not

The brief is a persona with three jobs, in order: turn the operator's assignment into a plan
(the JSON below), help them through the run when a task does not end done, and check the
finished work against the assignment. It takes the assignment in whatever form it comes — a
ticket, a work item, a bug report, a pasted document — reads it into a goal and acceptance
criteria, and searches the organisation's sources before asking. For the run it knows the
register's three exports (plan, work, runner), what `whyItFailed` holds, and the failure words
(`blocked`, `failed`, `limit-reached`, `aborted`), and it says whose problem a failure is — the
plan's, the work's or the machine's — and which button fixes it. For the end it maps every
acceptance criterion to evidence in the work export and proposes a read-only task for anything
only claimed.

The persona is called **Kerrigan**, and it has two levels. The **software level** is this
project's and does not change: what the bot is, the format, the exports, the failure words,
how to validate. The **organisation level** is the operator's: where tickets come from, which
company sources to search (OneDrive, SharePoint, Teams, the wiki, the ticket system), how the
machine is laid out (the Desktop mirror and its file names), the team's conventions — branch
naming, how a pull request is made, standards, templates. It starts **empty**: while it is,
the brief carries an interview phase before everything else, in which Kerrigan asks about all
of that, writes the text, and asks the operator to paste it into "Organisation level (yours)"
on the import page and save. `prompts/organisation.<lang>.md` is the example shown inside that
interview, not the default; the saved text lives in `data/organisation.md` in whatever language
it is written in, travels with every later copy, and the questions stop. Delete it and they
come back. The copy button takes both parts; the page shows each on its own so it is clear
which is which. `GET /api/plan/brief?lang=bg` returns the whole and the parts;
`GET|PUT|DELETE /api/organisation` is the operator's text.

There is nothing else to configure on the import page. The brief used to be assembled from two
answers given there — version control on or off, and which folder — and both have moved into
the conversation, because that is where they can actually be answered: nobody can sensibly say
whether work should be committed before they have described the work.

So the brief tells the model to ask, in those words, and to refuse to write a plan until it has
an answer. The answers then travel in the JSON **per session**, which is the other half of the
reason: a plan where one session builds a feature on a branch and another only audits the
repository is a normal plan, and a single switch on a form could not express it.

The brief is served in the language the UI is in.

## The format

```jsonc
{
  "version": 1,
  "plan": "a name for the whole document",
  "notes": "assumptions, open questions, why the order is what it is",
  "onFailure": "stop",                  // a failed SESSION: stop the rest, or carry on
  "sessions": [
    {
      "name": "invoice-export",          // short; part of every branch name
      "goal": "what this session is for", // opens the level-2 instructions
      "model": "",                        // the picker's exact name, or "" for the default
      "onFailure": "stop",                // "stop" = one chain | "continue" = independent
      "level2": "project and team instructions for every task here",
      "vcs": {                              // required on every session; see below
        "enabled": true,
        "repoDir": "C:\\Projects\\billing",
        "branchMode": "per-task",         // or "per-session"
        "commitOnFinish": true,
        "branchPrefix": "cop/",
        "branchName": ""                  // per-session mode only: the one branch
      },
      "mirror": {
        "enabled": true,
        "rootDir": "C:\\Projects\\billing",
        "includeDirs": ["src/invoices"],
        "excludeDirs": [],
        "respectGitignore": true,
        "includeEnvFiles": false
      },
      "tasks": [
        {
          "title": "csv-writer",
          "prompt": "what Copilot is asked to do",
          "expected": "what must be true when it is done",
          "level2": "",                   // overrides the session's, "" inherits
          "vcs": {
            "branch": "invoice-csv-writer",
            "commitMessage": "Add a CSV writer for invoices"
          }
        }
      ]
    }
  ]
}
```

`onFailure` appears twice, at two levels, and they are different questions. On a **session**
it decides what happens to the rest of its **tasks** when one of them fails. At the **top of
the document** it decides what happens to the rest of the **sessions** when one of them fails;
it seeds the run panel's own choice after an import, and the radio there is what actually
decides at the moment of running.

Two fields are composed rather than stored as they arrive:

- `expected` is appended to the prompt under `### Expected result`, so Copilot receives one
  text and the record still shows which half was the instruction and which was the bar.
- `goal` opens the session's `level2` under `## Goal of this session`, and each task inherits
  that unless it carries a `level2` of its own.

### Version control is the one question with no default

`vcs` is required on every session, and `repoDir` is required whenever `enabled` is true. Every
other field in this format either has a sensible default or is optional; this one does not,
because the two answers produce different work and one of them cannot be undone. A plan that
leaves it out is refused as a whole, with the question in the refusal:

```
- sessions[0].vcs: Every session needs a "vcs" object saying whether the runner does version
  control for it and, when it does, which git repository to work in. Ask the user both
  questions and write the answers here.
```

A session that should not touch git says so in full — `{ "enabled": false, "repoDir": "", … }` —
rather than staying silent. Silence used to mean "off", which is exactly the failure this
guards against: a plan written by a model that never thought about it reads identically to one
written by a model that decided against it.

### What version control takes from a plan

`vcs.branch` and `vcs.commitMessage` on a task are names for work that has not happened yet,
which is the one thing a plan is genuinely good at: the model writing it knows what each task
is for, so `cop/invoice-csv-writer` and an imperative commit subject read better in `git log`
than a branch named after a title typed into a form.

Neither is trusted. A planned branch name goes through the same slug as a derived one, keeps
the session's prefix (and does not double it if the model already added it), and still cannot
overwrite an existing branch — a re-run gets `-a2`, as it always did. A planned commit message
supplies the subject and, if it has more lines, the first paragraph of the body; Copilot's
summary, how the task ended and the `Committed by copilot-operator. Not pushed.` trailer are
added underneath either way, because none of that can be known in advance.

In `per-session` mode the task-level `branch` is ignored and the session's `vcs.branchName`
names the single branch the whole queue works on.

Choose the mode by what the tasks need from each other, not by taste. In `per-task` mode every
branch is cut from the commit the session started at, so a task never sees what an earlier task
of the same session produced — an audit task that ran after a README task was auditing a tree
without the README, and HEAD was left on that audit branch when the run ended. A task that
reads, checks or documents earlier work belongs in a `per-session` session. Either way each task
is told, in its opening message, which commit its branch was cut from and which earlier tasks'
work is or is not in its tree, and the session page says which branch holds the complete work.

### The second opinion

`review` on a session turns the independent review on or off and names the model it runs on;
`review: false` on a task skips it for that one. Left out entirely, it is on — which is the
point of leaving it out.

```jsonc
"review": { "enabled": true, "model": "" }   // empty model = the session's own
```

Naming a different model is worth doing. A fresh conversation removes attachment to the work,
which is most of the value, but it does not remove the blind spots of the model that did it: the
reviewer can be wrong about exactly the thing the implementer was wrong about, for exactly the
same reason.

The reviewer is not shown the implementer's summary, with one exception: a task whose product
*is* the summary. When version control recorded no change, or the task is `readOnly`, the
closing account goes into the brief under "What the implementer delivered", labelled as claims to
test. A repository audit once lost its first round for "not delivering the audit summary" that
the reviewer had simply not been given. A session without version control cannot tell whether
files changed, so its reviewer stays blind.

### Checks: the part the runner can decide for itself

`expected` is a sentence a person reads. `checks` is the same claim written so this runner can
settle it without anyone's opinion — and that is the whole design, because this project drives
a language model and does not have one of its own. A check it could not decide mechanically
would be a check it had to take on trust, which is the thing a check exists to replace.

When a task has checks, Copilot reporting it as done is no longer the end of it. The runner
runs them; if they all pass the task ends as `done`; if any fails, the failures go back into
the chat as a message with the output attached — the same shape as a step report — and the task
carries on. After `limits.maxCheckRounds` rounds (3 by default) the task is closed as `failed`
with the failing checks named in its reason. A check's `cwd` is optional: without it the
command runs in the session's project folder, the same place the model's own steps run.

One check is not written by the plan: whenever the runner is going to commit a task's work, it
adds `commit-clean` itself, which fails once if the working tree holds files that look like tool
output (`node_modules`, `dist`, `.next`, `*.tsbuildinfo`, logs) or secrets (`.env`). The task is
told to ignore them or to say why they belong; a second `done` with them still there commits
them and marks them on the task card. The reason it exists: a plan wrote its `.gitignore` exactly
as dictated, nine entries, and a later build turned on `incremental` in a `tsconfig.json` the
plan had also dictated — so `tsconfig.tsbuildinfo` went into the history, past a reviewer that
had the path in front of it and past an audit that looked only for the three folders the plan
had thought of.

Checks also accumulate from reviews. A reviewer may give, with a finding about the work, the
check that would have caught it, in exactly this shape; the runner keeps it only if it fails on
the work as it stands, and from then on runs it with the plan's checks on every attempt of that
task. So a plan's checks are the floor: what reviews notice is added to them rather than found
again by chance. The task card lists them under "From reviews".

A task that must not change files — an audit, a smoke test, a report — carries `"readOnly":
true`. It is a flag rather than a sentence in the prompt because a sentence is advice: a smoke
test told in prose to change nothing renamed the page's labels when a reviewer asked it to. The
runner fails a read-only task if the working tree has changed when it ends, whatever the summary
says, names the files, and still commits the change on the task's branch so nothing is lost and
the next task starts clean. The task is told so in its opening, with the instruction to dispute a
finding that asks for a change rather than comply with it.

```jsonc
"checks": [
  { "name": "typescript compiles", "expect": "exit-zero", "run": "npx tsc --noEmit", "cwd": "C:\Projects\app" },
  { "name": "the writer exists", "expect": "file-exists", "file": "C:\Projects\app\src\csv.ts" },
  { "name": "node_modules is not tracked", "expect": "output-omits", "run": "git ls-files", "value": "node_modules" }
]
```

| expect | Needs | Passes when |
|---|---|---|
| `exit-zero` | `run` | the command exits 0 |
| `exit-nonzero` | `run` | it exits non-zero — for proving something is refused |
| `output-contains` | `run`, `value` | the output contains the value |
| `output-omits` | `run`, `value` | it does not |
| `output-matches` | `run`, `value` | it matches the value as a regular expression |
| `file-exists` | `file` | the file is there |
| `file-missing` | `file` | it is not |
| `file-contains` | `file`, `value` | the file contains the value |

A check command goes through the same deny list as a step, and a check that cannot be
evaluated — no command where one is needed, a refused command, an unreadable file — **fails**.
A gate that opens when it breaks is worse than no gate.

One check can never pass and the validator warns about it: `output-contains` over `git
ls-files` for a file the task itself writes. The runner commits *after* the task, so during the
task the new file is untracked, and the task may not `git add`. A plan wrote exactly that
("the seed rule set is tracked") and the task ended blocked after three honest attempts with
the work complete. `file-exists` is the check that was meant; the negative form, `output-omits`
on `ls-files` for `node_modules`, is fine.

Checks are editable in the UI like everything else: the task card lists them with how they last
turned out, and the edit form adds, changes and removes them.

### What the validator does

- Refuses the document as a whole, never in part. Half a plan in the session list is harder
  to recognise, and harder to undo, than none of it.
- Answers every refusal with a path and a sentence: `sessions[0].tasks[1].prompt: A task
  needs a real instruction…`. The import page has a button that copies the list, because the
  next thing that happens to it is being pasted back into the chat.
- Treats an invented field as a warning, not a failure. A model that adds `"owner"` to a task
  has not misunderstood the format badly enough to send the operator back.
- Strips prose and fences before parsing, so what a chat actually produces can be pasted
  as-is.
- Names what already exists. A session in the store with the same name and exactly the same
  tasks, text for text, is reported before the import and confirmed with a dialog during it.
  The comparison ignores the level 2, the model and the git names, because those are edited on
  a session afterwards and an edited session is still the one the plan describes. Importing
  anyway is allowed: making a second copy of a piece of work is a thing people do on purpose.
  After a successful import the box empties itself, so the commonest version of this mistake —
  pressing the button twice — cannot happen at all.

## The project, and the repository it has to be

The folder being worked on is set once, on the `Settings` page, and stored in
`data/settings.json` under `project.rootDir`. A new session starts with that folder in both its
project-files field and its version-control field; sessions that already exist are untouched and
offer it with a button instead. Every folder field in the app carries a line saying what the
default is and linking to where it is changed, so nobody has to remember the path or hunt for
the setting.

The same page keeps the **other projects** the operator works in — `project.others`, each a
name and an absolute path — because one piece of work is often three repositories: a front end,
a back end, the test suite. They are not defaults and not sessions. Every folder field offers
them by name next to the default, and the plan brief lists all of them under "Projects on this
machine", with whether each is a git repository, so a plan across several repositories is
written with the folders that exist rather than with paths the chat model asked for and the
operator typed from memory. The brief still tells the model to ask which of them the work is
about.

The same page has the switch that keeps every listed project **on the Desktop**
(`project.mirrorToDesktop`): one folder per project under `copilot-operator-context`, each with
its own selection of directories (chosen in a tree or typed), the project's name in front of
every file name, refreshed before each run. Off, the folders are removed. That is the path into
OneDrive and the chat's file picker; a session's own `mirror` (the files attached to its first
message) uses the same per-project folder either way.

The page also holds the model new sessions are **reviewed** by (`copilot.defaultReviewModel`),
next to the one they work on. A plan whose session names no `review.model` gets it, the same way
a session with no `model` gets `copilot.defaultModel`.

Version control is refused where it cannot work. Turning it on for a folder that is not a git
repository is not allowed — not warned about afterwards, refused at the point of choosing —
because version control that is on and inactive is the worst of both: the operator believes
there is a way back, the runner quietly branches nothing, and the first anyone knows of it is a
task card an hour later. The same rule applies to a plan: a document that asks for version
control in a folder with no `.git` is refused on import, with a message naming the folder and
saying to run `git init` there. A folder that is not a repository can still be the **project**;
it just cannot carry branches and commits, and the page says so.

## Going back to before a task

Every task records the commit it started from, and the task card carries a **Restore** button
that puts the repository back to it. Additively, like everything else here: a new branch is cut
at that commit and checked out. Nothing is reset, nothing is deleted, no history is rewritten.

What the operator is told before they agree matters more than the button. The preview names the
commit, the branch that would be created, and — when the tasks were chained on one branch — the
commits that the restored branch **will not have**, with the branch they stay on. The work after
that point is not lost; it is on the branch it was made on, one checkout away. What is true is
that the working tree no longer has it, and anything built from it needs building again. The
dialog says exactly that.

Restore refuses when there is nothing to go back to (version control was off or inactive when
the task ran), when the tree is dirty (switching would carry the changes along or lose them, and
neither is this tool's decision), and while the session or a batch is running.

## Starting the run again from the task that broke

**Run again from here** is restore and re-run as one action, and it is scoped to the run rather
than to the task. It puts the code back to before the chosen task, queues that task and every
one after it, and starts them — the rest of that session, and every session the run had not
reached yet.

That last part is why the run records itself. A task is stamped with its run when it starts, so
after a failure in the second task of the first session, the seven tasks that never got a turn
carry nothing and the two sessions that were never reached carry nothing either. Asking the
tasks would give back only the half of the run that already happened, which is the opposite of
what is wanted. So when a run starts it writes onto **every** session it selected: the run's id,
where that session sat in the order, which of its tasks were queued at that moment, and how the
run was started. Running it again then means running it the way it was run.

Repositories are taken back **once each**, not once per session: three sessions sharing one
repository go back to before the earliest affected task, which is the state the whole re-run
starts from. A run spanning two repositories takes each back to before its own earliest affected
task, which is the same rule rather than a second one.

The dialog lists all of it before anything happens — the repositories and the commits, the tasks
by name with the sessions they belong to, and how the run will be started — because this is the
most far-reaching button in the application: it moves repositories, it throws finished work back
into the queue, and then it starts a run.

Finished attempts are archived, not erased: a task queued again keeps the summary and the reason
of the attempt that failed, under the text it actually ran with. Tasks already waiting are left
alone rather than reset, since that is where a restart would put them anyway.

| Endpoint | What it does |
|---|---|
| `GET /api/sessions/:id/tasks/:taskId/restart` | The plan: what would be queued, and what each repository would do. Changes nothing. |
| `POST /api/sessions/:id/tasks/:taskId/restart` | Does it. `{ restore?, start?, mode?, onFailure? }` — `restore: false` skips moving the code, `start: false` stops after queueing and leaves the Start button to a person. |

## Running several sessions in turn

The sessions list has a checkbox per session and one button for all of them. Selected sessions
run **one after another**, never at once: the Edge profile is single-writer, so two
conversations at the same time is not faster, it is a failure with a message about a closed
browser.

**One browser for the whole run.** The window is opened once, handed to each session in turn,
and closed when the last one is done; between sessions only the conversation on screen changes.
Every session used to open and close its own, which meant a launch, a sign-in check and a grab
at the profile lock each time — minutes of nothing, and another chance to meet the failure where
a leftover Edge process still holds the profile.

**One conversation, when the work is one piece.** A plan's `conversation: "shared"` (or a
`conversationGroup` typed on a session) puts several sessions in the same chat: the first to run
opens it, the rest join it and inherit its history, and the level-1 contract is not sent twice
into the same conversation. The default stays one conversation per session, because sessions
that have nothing to do with each other should not inherit each other's context.

The order is shown before the run starts, oldest session first — which for an imported plan is
the order the plan asked for — and can be rearranged. "Oldest" is read from `createdAt`, to the
millisecond, and not from the session id: an id is only accurate to the second and ends in four
random characters, so sorting by it put the sessions of an imported plan in a random order. That
is not cosmetic — it once ran the session that audits a repository before the two sessions that
were supposed to fill it. `If a session fails` is the same question
the task queue already asks, one level up: **stop** treats the sessions as one piece of work in
order, **continue** treats them as separate work that happens to have been started together.

A session is judged on the tasks it was given when the batch reached it, not on anything it
held from last week: every one of them `done` is `done`, one of them failed is `failed`, and a
session that was stopped, or never reached, is neither.

| Endpoint | What it does |
|---|---|
| `GET /api/batch` | The batch in progress, or the last one that ran. |
| `POST /api/batch/start` | `{ sessionIds, mode, onFailure, model?, reviewModel? }`. Refuses if one of them is already running on its own. Both models are written onto every selected session before the run, so what a session says it uses and what it used stay the same thing. `reviewModel` sets only which model reviews — it never switches the review on or off, because that is a property of the session rather than of one run. |
| `POST /api/batch/stop` | Stops the session running now; the rest stay as they are. |

A batch lives in memory, not on disk. After a restart there is no browser, no conversation and
no consent to carry on, so there is nothing to resume.

## What the record says about git

The downloadable record of a task (`Export` on a session) carries a **VERSION CONTROL** block
per task: the branch, the commit it was cut from, the commit it produced, how many commits are
on that branch since it was cut and their subjects, and the branches of any earlier attempts.
The session header names the repository and the branch mode. A task where version control was
on but could not run says so, with the reason, rather than saying nothing.

## What is verified

`npm run check:plan` covers the schema, both variants of the brief and its example, the
extraction of JSON from a chat's prose, the refusals, the warnings, the import, and the branch
name and commit message a plan produces. The batch endpoints' refusals are checked by hand
against a running API. **The batch loop itself has not yet been run against a live tenant.**
