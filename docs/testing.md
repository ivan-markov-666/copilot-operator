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
| `replies/NN-*.md` | every Copilot reply exactly as it arrived |
| `replies/NN-*.onscreen.txt` | the same reply's code blocks as rendered on screen |
| `failures/` | only if something broke: a screenshot and an HTML dump |

The two `replies` files are there to be compared. If a command the bot ran does not match
what the chat shows, they say which side lost it.

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

This is the part that was expected to be hard. The config is ready:

```bash
npx tsx src/cli.ts run run.download.yaml
```

**Expect:** the console prints `downloaded hello.ps1 (sha256 ...)`, the file appears in
`runs/<runId>/artifacts/`, and the step runs it.

Verified live once the contract stopped suppressing attachments: a 27-byte `hello.ps1` was
downloaded, hashed, saved to the run's artifacts folder, executed with exit 0, and its output
read back by Copilot from the report file.

**If Copilot says it cannot attach files, the contract is probably the reason.** That is
what happened here, twice, on a surface where a real blob download had been produced the day
before. The saved reply settles it: the message contained the json block and nothing else,
`notes` said `Download file: turn3file1`, which is the code interpreter's internal handle,
and the transcript recorded `attachments: 0`. So Copilot had a file in its sandbox and never
put a link in the message.

The cause was this project's own contract. "Exactly one json block, a short sentence at
most" reads as a ban on the extra content a code-interpreter run produces, so the model kept
the format and dropped the file. The contract now says outright that a download link is not
a json block, that attaching is required rather than optional, and that a name in `notes` is
not a file.

The downloader also stopped being brittle about names: if the reply carries exactly one
downloadable file under a different name, it uses it and says so, rather than failing on a
string mismatch and reporting "nothing attached" when something clearly was.

---

## 7. Test a long-running step

The config is ready, and it asks for both halves in one reply: a talkative step that must
survive, and a silent one that must be stopped.

```bash
npx tsx src/cli.ts run run.long.yaml
```

**Expect:** the console prints a heartbeat roughly every 30 seconds, saying how long the step
has been running, how long since it last printed, and the last line it printed.

Verified live: the talkative step ran for 92.1 s and finished with exit 0, printing `tick 1`
through `tick 90`, with heartbeats at 31 s, 61 s and 91 s and never killed. The silent step
was stopped at 21.1 s as `idle-timeout` with exit -1. Copilot then read the report file and
described both outcomes correctly, including that `idle-timeout` was the runner stopping it
rather than the command failing.

---

## 8. Test the project mirror

`run.mirror.yaml` is ready and deliberately small: it mirrors only the two prompt files, so
nothing private is involved while the mechanism is being proved.

```bash
npx tsx src/cli.ts mirror run.mirror.yaml
npx tsx src/cli.ts mirror run.mirror.yaml
```

**Expect:** the first says `2 added`, the second says `0 added, 0 updated, 0 deleted,
2 unchanged`. That is the incremental behaviour. The folder on the Desktop holds
`prompts--01-persona.md.txt` and `prompts--02-format.md.txt`: the path is in the name and
`.txt` is appended, because the chat rejects most source extensions.

Then hand them to the chat:

```bash
npx tsx src/cli.ts run run.mirror.yaml
```

The task asks Copilot to read the attached files and answer a question only their contents
can answer, so a plausible-sounding guess is not enough to pass.

Verified live: Copilot answered that the end-of-run word is `Край` and named
`prompts--02-format.md.txt` as the file defining it, which is correct and could only come
from reading the attachment. The mirror reported `2 unchanged`, so nothing was re-uploaded.

**Attaching uploads a copy to the user's OneDrive.** That is worth knowing before pointing
this at real code. Use `report.redactPatterns`, or mirror a narrower set of directories.

To see what a project offers before choosing:

```bash
npx tsx src/cli.ts dirs C:\Projects\your-app
```

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

**A command ran mangled.** A live run executed `:Round(...)` where the answer should have
said `[math]::Round(...)`, three times in a row, and Copilot kept blaming its own syntax.
Compare `replies/NN-*.md` (what we received) with `replies/NN-*.onscreen.txt` (what the chat
displayed) for that iteration:

- both mangled: Copilot really wrote it that way, and the prompt is the place to fix it,
- on screen correct, received mangled: the copy path is losing characters, which is a bug in
  this project and worth reporting with both files.

**Everything worked but the answers are poor.** That is the prompt, not the bot.
`prompts/01-persona.md` is meant to be edited.

## What to send me if you need help

`runs/<runId>/transcript.jsonl` and anything in `runs/<runId>/failures/`. Between them they
say exactly what the bot saw and did. Redact first if the output contains anything sensitive:
the transcript records command output.
