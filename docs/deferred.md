# Deferred: designed, argued, not built

Work that has been thought through and deliberately put off, with the reasoning intact, so
that picking it up later does not start from a blank page and so that "why is this not in
there" has an answer.

---

## Pausing for the operator (`needs-operator`)

**Decided on 2026-09-22: sound, worth building, not yet.** The bot is to be exercised as it is
first; this is taken up once that is stable.

### What it is

Some work cannot be done by the bot at all and is not a failure: a secret or credential only a
person can supply, a `.env` the operator keeps out of the repository, a cloud resource that
needs their account. Today the model's only honest exits are `blocked`, which ends the task, or
doing it itself, which is worse. What is wanted is a **pause**: the task stays alive, the
operator does the thing by hand, presses continue, and the same conversation carries on.

### Why it is sound

The tempting mechanism is to read the chat's prose for "please update the .env" and act on it.
That is the kind of rule this project keeps refusing: a sentence is advice, and inference over
free text is not a mechanism. The design below never infers intent. It stands on two legs, and
the second is the one that does not depend on the model's cooperation.

**1. A declared status in the reply schema.** The reply is already JSON validated by zod, with
`continue`, `done` and `blocked`. A fourth — `needs-operator` — carries required fields: what
the person must do, why the bot cannot, and **a check the runner will run to decide whether it
was done**. That is the same shape as `tried` on `blocked`, `why` on a deviation, `evidence` on
a dispute. The runner does not guess; the model declares. The evidence that a declared channel
gets used is in the register: `deviations` and `disputed` were each used five times in the
2026-09-21 run.

**2. Refusals in the policy gate.** This is the certain leg. A command is not prose, so a
regular expression over one is reliable — that is how the git rules already work. Today nothing
stops the bot doing any of it; checked on 2026-09-22, every one of these is allowed:

    az webapp config appsettings set …      dotnet user-secrets set …
    Set-Content .env "KEY=…"                kubectl apply -f …
    terraform apply                         aws s3 cp …

Each should be refused with a reason that names the channel: do not do this, ask the operator.
Then a model that never learned the status is pushed into it by its own refused attempt, and
the easy way round disappears. **These refusals are worth having on their own,** before any of
the rest exists, and are where the work should start.

### How it resumes

A pause must **release the browser**. The Edge profile is single-writer, so a task sitting in a
wait loop holds up every other session. So the pause ends the run and leaves the task in a
waiting state; "continue" starts a new run that re-enters the same conversation through the
chat pointer, exactly as a session already resumes today. No new machinery for that part.

When the operator says it is done, the runner **runs the check the model declared** rather than
taking the word for it. If it still fails, the operator is told what is missing, instead of the
task running on into a failure three steps later.

### What could go wrong, honestly

- **Asked for needlessly.** The model requests a pause for something it could do itself. Costs
  one round trip, not correctness; the operator answers "do it yourself" and continues.
- **Never used.** The model blocks instead. That is exactly today's behaviour, so nothing is
  lost, and the refusals in leg 2 push against it.
- **Worked around silently.** A fake key written to get past the wall. The dangerous one, and
  the same class as making a check pass by destroying what it measures: the refusals and the
  independent review are what stand against it.

### Scope

Comparable to the independent review: the reply schema, the task loop, the task and session
model, the API, a UI card with the instruction and a Done button, both contracts, and a field
in the plan format so a task can say up front that it will need a secret.

### Order to build it in

1. The deny-list refusals for secrets and cloud commands, with the reason that names the
   channel. Useful alone, on a work machine especially.
2. The `needs-operator` status, its required fields and its check.
3. The pause, the waiting state and the resume.
4. The UI card, the contracts, the plan field.
