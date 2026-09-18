# Testing it for the first time

Nine steps, ordered so that each one only starts if the previous one worked. The early ones
cost nothing and need no account; the risk climbs slowly. Do them in order, on the Windows
machine that will actually run the bot.

Nothing here runs unattended. Confirm mode is on throughout, so every command is shown and
waits for you before it runs.

---

## 1. Get the code running (no account, no browser)

```bash
git clone https://github.com/ivan-markov-666/copilot-operator.git
cd copilot-operator
npm install
```

`npm install` also downloads Playwright's own Chromium, a few hundred megabytes, which this
project does not use because it drives the installed Edge. To skip it:

```bash
set PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 && npm install
```

Then:

```bash
npm run check
```

**Expect:** seven blocks of output, each printing what it exercised: the parser against
eleven reply shapes, the report writer and redaction, the deny list against eight commands,
the runner's two timeouts, the project mirror, chat naming, pacing.

**If it fails:** the failure is in this repository, not in your setup. Nothing has touched a
browser or an account yet.

---

## 2. Check the machine

```bash
npx tsx src/cli.ts doctor
```

**Expect:** `ok` for Node 20 or newer, Microsoft Edge, PowerShell, and the Desktop, then
`Ready.`

The Desktop line may say it is not backed up by OneDrive. That is a note, not a failure. It
only matters if you want the project mirror to reach the cloud.

---

## 3. Sign in once

```bash
npx tsx src/cli.ts login
```

An Edge window opens on the Copilot chat, in a profile that belongs to the bot and is
separate from your own Edge. Sign in there yourself. The bot never types credentials; it
waits for the chat composer to appear and then exits.

**Edge may sign you in as the wrong account without asking.** On a Windows machine it will
happily reuse whatever account the operating system knows about, so the chat can end up
belonging to someone other than the user you meant to test with. Name the account you want:

```bash
npx tsx src/cli.ts login --account 155676@365kit.org
```

That signs the browser out first, clears its cookies, then asks Microsoft for that specific
account and refuses to report success if a different one ends up signed in. If Edge still
insists, wipe the profile and start clean:

```bash
npx tsx src/cli.ts login --account 155676@365kit.org --fresh
```

`--fresh` deletes only the bot's own profile folder and asks before doing it. Your normal
Edge is untouched. If even that keeps picking the wrong account, the machine has Edge's
implicit sign-in turned on; an administrator can disable it with the `ImplicitSignInEnabled`
policy, which is a machine-wide setting and therefore their call, not this tool's.

**Expect:** `Signed in. The profile is saved at ...`

**This is the one step that can fail for reasons outside the code.** If your tenant enforces
Conditional Access with a compliant-device or managed-browser requirement, a fresh Edge
profile may be refused. If that happens you will see the sign-in page reject the session
rather than reach the chat. Tell me what it says and we will look at the options; everything
after this point depends on it.

Run it again later whenever the session expires. The bot detects the sign-in page mid-run and
pauses rather than failing.

---

## 4. The first real run: a read-only smoke test

```bash
npx tsx src/cli.ts run run.smoke.yaml
```

The task is deliberately dull: report the Windows edition and the free space on C. Read-only,
two steps at most, four iterations maximum.

Watch for these, in order:

1. Edge opens and lands in a new chat.
2. Three opening messages go out: the persona, the format contract, the task.
3. The chat gets renamed in the sidebar to `op/<runId>/smoke`.
4. The console prints `iteration 1: N step(s)` and then, for each step, the command and a
   prompt: `[Enter] run  [s] skip  [q] abort`.
5. Press Enter. The command runs, the exit code is printed.
6. A report file is written and uploaded, and the console says which file.
7. Copilot answers again, and either asks for more or finishes.
8. The run ends with `done`, and the chat name and link are printed.

**This is the step most likely to surface a bug,** because it is the first time the whole
chain runs against the live UI. See "When something goes wrong" below.

---

## 5. Look at what it produced

```bash
dir runs
```

Inside `runs/<runId>/` you should find:

| File | What it is |
|---|---|
| `transcript.jsonl` | every event, one JSON object per line |
| `reports/iteration-1.txt` | the full terminal output that was attached to the chat |
| `steps/1-1.log` | the raw stream of one step, uncut |
| `chat.json` | the conversation id and name, for reattaching later |
| `failures/` | only if something broke: a screenshot and an HTML dump |

Open `reports/iteration-1.txt`. It should contain the real command output, and the header
should name the run, the iteration and the step count.

Then:

```bash
npx tsx src/cli.ts chat run.smoke.yaml
```

prints the conversation name and a link you can open in your own browser to read the whole
exchange as a human.

---

## 6. Test the download path

This is the part that was expected to be hard. Copy `run.smoke.yaml` to `run.download.yaml`
and replace the task with:

```yaml
  - text: |
      Task: generate a PowerShell script named hello.ps1 that prints the current date and
      the computer name, attach it to the chat as a downloadable file, and give me a
      download step that runs it. Then finish.
```

**Expect:** the console prints `downloaded hello.ps1 (sha256 ...)`, the file appears in
`runs/<runId>/artifacts/`, and the step runs it.

If Copilot answers with the script as text instead of a file, the tenant may not have the
code interpreter enabled. Say so and we will adjust the contract to inline scripts instead.

---

## 7. Test a long-running step

Copy the smoke config again and use a task like:

```yaml
  - text: |
      Task: run a command that prints one line per second for about ninety seconds, so I can
      confirm long-running steps work. Mark it "expect": "long". Then finish.
```

**Expect:** the console prints a heartbeat roughly every 30 seconds, saying how long the step
has been running, how long since it last printed, and the last line it printed. The step is
**not** killed, because it keeps producing output.

To see the other half of the behaviour, ask for a step that sleeps silently for longer than
`idleTimeoutSec`. It should be killed and reported as `idle-timeout`, not as a failure of the
command itself.

---

## 8. Test the project mirror

```bash
npx tsx src/cli.ts dirs C:\Projects\your-app
```

Pick the directories you want the chat to see, put them in a config under `projectMirror`,
then:

```bash
npx tsx src/cli.ts mirror run.yaml
```

**Expect:** a folder on your Desktop with flattened names like
`src--test--example-test.spec.ts.txt`, and a summary line saying how many were added.

Run it a second time without editing anything: it should say `0 added, 0 updated, 0 deleted`
and the rest unchanged. Edit one file and run again: exactly one `updated`.

Only then set `attachToFirstMessage: true` and do a run that hands those files to the chat.

---

## 9. Only now, consider unattended

```bash
npx tsx src/cli.ts run run.yaml --unattended
```

Commands run without asking. Do this only after a task has already worked in confirm mode,
and preferably in a dedicated Windows account or Windows Sandbox. The deny list and the
timeouts still apply, but they are a guard against the ordinary mistake, not a security
boundary.

---

## When something goes wrong

**`Target page, context or browser has been closed`.** Almost always another Edge process is
already using the bot profile, so the new launch hands off to it and exits. Chromium profiles
are single-writer. `cop doctor` now checks for this and prints the exact `Stop-Process` line.
Close every Edge window on the bot profile and run again.

**A "Verify you are human" box appears, or "Your request couldn't be completed".** The run
pauses, records a screenshot in `runs/<runId>/failures/`, and prints what matched and why.
Complete the check yourself in the open Edge window. The message that triggered it was never
delivered, so the bot sends it again afterwards rather than waiting for a reply that cannot
come. It never attempts the challenge itself.

If this happens on every send, find out whether it is the automation or the browser profile:

```bash
npx tsx src/cli.ts open
```

That opens the bot's own Edge and profile and hands it to you, with nothing automated. Type
a long message by hand and send it.

- It fails for you too: the challenge is attached to that browser profile or that session,
  not to how the bot types. Signing in again, or using the profile normally for a while,
  sometimes settles it.
- It works for you: the difference is in the automation, and the transcript now records what
  the detector matched, which is where to start.

**The chat looks wrong: `Shop`, `Play`, a different composer.** That is the **consumer**
Copilot, not Microsoft 365 Copilot. `m365.cloud.microsoft` redirects there when the profile is
not signed in with a work or school account, and the consumer surface runs bot protection that
the work surface does not. So this looks exactly like being detected as a bot while really
being a sign-in problem. `cop login` now refuses to report success unless it actually lands on
the work chat. Sign in with the work account.

**It hangs waiting for a reply.** The wait needs the `Stop generating` button to disappear
and the copy button to appear on the newest answer. If Microsoft has changed either, this is
where it shows. Look at `runs/<runId>/failures/` for the screenshot, then at
`src/transport/locators.ts`.

**It says the reply did not match the contract.** Open the chat and read what Copilot
actually sent. Usually it wrote prose around a second json block, or dropped the block
entirely. It retries twice, then stops. The fix is normally a sentence in
`prompts/02-format.md`, not code.

**A step was skipped with "matches deny pattern".** Working as intended. If the command was
genuinely safe, relax `denyPatterns` in your config, but read the command first.

**The upload never finishes.** The bot waits for the attachment chip's id to carry the `SPO_`
prefix, which means the file reached SharePoint. A slow or broken OneDrive can stall this. It
retries, then falls back to sending truncated output as text.

**Everything worked but the answers are poor.** That is the prompt, not the bot.
`prompts/01-persona.md` is meant to be edited.

## What to send me if you need help

`runs/<runId>/transcript.jsonl` and anything in `runs/<runId>/failures/`. Between them they
say exactly what the bot saw and did. Redact first if the output contains anything sensitive:
the transcript records command output.
