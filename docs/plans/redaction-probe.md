# The redaction probe

One read-only task, in [`redaction-probe.plan.json`](redaction-probe.plan.json), whose only
purpose is to put secret-shaped strings into a step's output so the runner's built-in redaction
can be read in the two places it matters: the report file the runner uploads, and what the chat
quotes back. Every value is invented; nothing is installed, started or changed.

Run it before the first run on a machine whose Copilot tenant is not yours. The report goes to
that tenant.

## What to read afterwards

- `runs/<runId>/reports/iteration-1.txt`: six lines carry `[REDACTED …]` markers (GitHub token,
  bearer token, `password=`, AWS key, credentials in a URL, JWT) and the seventh, `plain=…`, is
  unchanged.
- The task's summary: the model was told to quote the report as received, so it should quote
  the markers, not the values. If it quotes a value, it did not come from the file.
- `task-log.txt` and the transcript: the `report-redacted` event (a warning) names which shapes
  were redacted and how many of each, before the upload.

## Why a task and not only the unit check

`npm run check:report` proves the function. This proves the path: the step's raw output, the
capture, the report writer, the upload, and the model reading the attachment. The one live thing
the unit check cannot see is whether the redaction runs before the upload rather than after.
