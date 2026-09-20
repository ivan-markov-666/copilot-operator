# The rules-engine exercise

A plan that works the bot harder than the calculator did, in the shape of the work this bot
is actually for: a service, a UI on it, and a Playwright Test project that tests both. Three
repositories, four sessions, fourteen tasks, sixty-two checks. The plan is
[`rules-engine.plan.json`](rules-engine.plan.json); it is imported as it is, without an
interview, because it was written against this format by hand.

## What it builds

- **`C:\Projects\rules-api`** — a TypeScript rules engine over HTTP. Rule sets are JSON: rules
  with a priority, a condition tree (`all` / `any` groups over leaves with nine operators) and
  actions (`set` a value by path, `tag`, `reject` with a code). Evaluation runs rules by
  priority and stops at the first rejection. Rule sets are files under `data/rulesets/`, every
  evaluation is a line in an audit log, and the README's examples are taken from real calls.
  Port 4400.
- **`C:\Projects\rules-web`** — a Next.js UI that lists rule sets, edits one rule by rule, and
  tries a payload against it. Every element a test would touch carries a `data-testid` whose
  name the plan dictates, so the third repository has a contract to build on. Port 4410.
- **`C:\Projects\rules-tests`** — Playwright Test: an `api` project on the request fixture
  with a rule-set fixture that seeds and cleans up, evaluation cases driven from a JSON file,
  and an `e2e` project through page objects on `getByTestId` only. The config starts both
  applications itself through `webServer` entries with a `cwd` each.
- A last, read-only session audits all three repositories and reports one table.

## What it exercises in the bot

- **Several projects.** Each session works in its own repository; the Settings page lists all
  three, so their folders are offered by name and the plan brief names them by path.
- **Servers, started and stopped.** Every session starts something on a port and has to stop
  it in the same step. The Start-Process shim trap (`Start-Process npx` by bare name) is refused
  by the runner and named in every session's instructions; the wrapper-PID trap is what
  `taskkill /T` is for. Playwright's own `webServer` adds a third way of starting servers, one
  the bot does not control.
- **Long steps.** `next build` and the first `playwright install chromium` take a minute or
  more each; the tests run twice in the audit.
- **Read-only tasks with a deliverable.** `web-smoke`, `suite-audit` and `three-repo-audit` are
  `readOnly`; their product is the closing summary, which goes to the reviewer as the thing
  under review. A tree that changed fails them.
- **A contract between repositories.** The web app's testids are dictated by the plan and
  inventoried by the smoke task; the test project may not change the applications, so a
  missing testid is a finding, not an edit. That is the situation an automation engineer is in.
- **Checks that need a server.** The API and e2e test checks run the whole Playwright project,
  which starts both applications; the gate waits for them.
- **Reviews across a stack.** Reviewers get Express, Next and Playwright work in turn, with the
  earlier tasks of the session for context.

## Running it

1. Restart `npm start` in `C:\Projects\automate-365` (the build picks up the runner changes).
2. The three repositories exist with one commit each and are registered on the Settings page
   (default `rules-tests`, others `rules-api` and `rules-web`). If they are missing:

   ```powershell
   foreach ($r in 'rules-api','rules-web','rules-tests') { git init -b main C:\Projects\$r; Set-Content C:\Projects\$r\README.md "# $r"; git -C C:\Projects\$r add .; git -C C:\Projects\$r commit -m "Initial commit" }
   ```

3. `Plan from JSON` → paste the file → *Check it* → *Create the sessions and tasks*.
4. On the sessions page select the four sessions in order, choose confirm or unattended, and
   start the run. Session order matters: each later repository uses the earlier ones' working
   trees, which after their sessions sit on `cop/rules-api`, `cop/rules-web` and
   `cop/rules-tests`.

Expected wall time on the calculator's pace: two to three hours, most of it in the web and
test sessions.

## What to look at afterwards

- `runs/<runId>/` per task: `task-log.txt`, `review/N/00-brief.md` (the read-only tasks' briefs
  carry "What the implementer delivered"), `checks/`.
- The audit session's summary: one table, three rows. Compare it with `git -C <repo> branch -v`.
- `C:\Projects\rules-tests\playwright-report\index.html` after the suite audit.
- Whether any reviewer edited the applications from the test session, which the instructions
  forbid and the tree-clean checks of the audit would catch.
