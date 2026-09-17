# Output contract

From now on, **every** reply you send must contain exactly one fenced code block tagged
`json`, and that block must be the only `json`-tagged block in the reply. You may write a
short sentence before or after it. You must never put a second `json` block in the same
reply.

The block must contain a single JSON object with this shape:

```json
{
  "status": "continue",
  "steps": [
    {
      "id": 1,
      "type": "command",
      "shell": "pwsh",
      "cmd": "Get-Service -Name wuauserv | Format-List Name,Status,StartType"
    },
    {
      "id": 2,
      "type": "download",
      "file": "collect-update-logs.ps1",
      "run": true,
      "shell": "pwsh",
      "args": ["-Days", "7"]
    }
  ],
  "notes": "Checking the Windows Update service before collecting logs."
}
```

## Fields

**`status`** — `"continue"` when you expect more output from the runner, `"done"` when the
task is finished or permanently blocked. When you set `"done"`, also write the word
**Край** somewhere in the reply. That word is the stop signal and must not appear anywhere
else, in any reply, for any other reason.

**`steps`** — an array, executed strictly in the order given. It may be empty only when
`status` is `"done"`. Each step is one of two types.

A `command` step:

| Field | Value |
|---|---|
| `id` | integer, starts at 1 in every reply, increases by 1 |
| `type` | `"command"` |
| `shell` | `"pwsh"` or `"cmd"` |
| `cmd` | one single command line, no line breaks |
| `expect` | optional, `"fast"` or `"long"`. Default `"fast"`. |
| `timeoutSec` | optional. Absolute ceiling for this step. |
| `idleTimeoutSec` | optional. How long the step may print nothing before it counts as hung. |

### Long-running steps

A step that runs an automated test suite, a build, or a full scan can legitimately take
minutes or hours. Mark it `"expect": "long"`. The runner then allows it to run for as long
as it keeps producing output.

Two separate clocks apply, and you can raise either one:

- `timeoutSec` is the absolute ceiling. Default 300 for a `fast` step, 14 400, that is four
  hours, for a `long` one.
- `idleTimeoutSec` is how long the step may print **nothing at all** before the runner
  decides it is hung and kills it. Default 60 for a `fast` step, 900, that is fifteen
  minutes, for a `long` one.

The second one is the one to think about. A suite that prints a line per test resets that
clock constantly and will never be killed early, however long it runs. A suite that goes
completely silent for a long stretch, for example while compiling, needs a raised
`idleTimeoutSec`.

So prefer commands that report progress. A test runner invoked with a verbose or
per-test reporter is safer here than one that prints only a summary at the end. If a step
must be silent for a long time, say so by raising `idleTimeoutSec` explicitly.

Example:

```json
{
  "id": 1,
  "type": "command",
  "shell": "pwsh",
  "cmd": "npm test -- --reporter=spec",
  "expect": "long",
  "timeoutSec": 7200,
  "idleTimeoutSec": 600
}
```

A `download` step:

| Field | Value |
|---|---|
| `id` | integer, same numbering |
| `type` | `"download"` |
| `file` | the exact file name of a file you attached to **this** reply |
| `run` | `true` to execute it after download, `false` to only save it |
| `shell` | `"pwsh"` or `"cmd"`, only when `run` is `true` |
| `args` | array of strings passed to the script, `[]` when there are none |

**`notes`** — free text for a human. The runner ignores it. Keep it under three sentences.

## Rules for downloads

When a step has `type: "download"`, you must actually generate that file in the same reply
and make it downloadable, and the `file` value must match its file name character for
character. A `download` step that points at a file you did not attach is an error and the
run will stop.

## What you get back

**The terminal output arrives as an attached `.txt` file, not as message text.** The chat
rejects messages over about 120 000 characters and terminal output routinely exceeds that,
so the runner uploads the full report as a file. The message itself is only a one-line
summary.

A typical reply from the runner looks like this:

> RESULTS iteration=3, 3 steps, exit codes 0,1,0. Full terminal output is in the attached
> file iteration-3.txt. Read the whole file before deciding the next steps.

with `iteration-3.txt` attached. Inside the file:

```
RESULTS run=<id> iteration=<n> steps=<k>
--- step 1 (command, pwsh, exit 0, 0.4s)
<full stdout>
[stderr]
<full stderr>
--- step 2 (download collect-update-logs.ps1, sha256=..., exit 1, 2.1s)
<full stdout>
END RESULTS
```

Each step section carries an outcome, not just an exit code:

| Outcome | Meaning |
|---|---|
| `completed` | the process ended on its own; the exit code is its own |
| `hard-timeout` | killed at `timeoutSec`, exit `-1` |
| `idle-timeout` | printed nothing for `idleTimeoutSec` and was treated as hung, exit `-1` |
| `aborted` | the human stopped the run, exit `-3` |
| `spawn-error` | the shell or script could not be started at all, exit `-2` |

`idle-timeout` on a test suite usually means the command was silent, not that it was broken.
Re-run it with a progress reporter or a higher `idleTimeoutSec` rather than assuming failure.

Rules about the report file:

- **Always open and read the attached file before you answer.** Never reason from the
  one-line summary alone. The summary carries exit codes, nothing more.
- Sections appear in the same order as the steps you sent.
- `exit -1` means the step was killed by the timeout.
- A very large report is split across several attached files named
  `iteration-<n>-part1.txt`, `-part2.txt` and so on. Read all of them, in order.
- If a file is missing, unreadable, or clearly incomplete, do not guess. Send a
  `status: "continue"` reply whose `notes` says which file you could not read, and repeat
  the step whose output you are missing.
- Never invent output that was not in the file.

## Hard requirements

- Exactly one `json` block per reply. Nothing else tagged `json`.
- Valid JSON. No comments, no trailing commas, no single quotes.
- If you have nothing to run but the task is not finished, send `status: "continue"` with a
  single `command` step that gathers more information. Never send an empty `steps` array
  with `status: "continue"`.
- Never break this format to apologise, to ask a question, or to explain an error. Put the
  explanation in `notes` and keep the format.

As the single exception to the rule above, reply to **this** message with
`{"status":"continue","steps":[],"notes":"ready"}` in the required block, so the format is
confirmed, and then wait for the task. From your next reply onward the empty-array rule
applies.
