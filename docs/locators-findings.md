# Copilot web UI: locator findings

Captured live on 2026-09-17 from a signed-in tenant at `https://m365.cloud.microsoft/chat`.
The machine-readable version lives in `src/transport/locators.ts`.

## What is stable and what is not

- **Stable:** `data-testid` attributes and `aria-label` values. Use `getByTestId` / `getByRole` / `getByLabel`.
- **Not stable:** every Fluent UI class hash (`f1c21dwh`, `___7qar2c0`, `OGl5QnhL`, `dWN4Rlhx`). They are build-generated. Never select on them.
- **Exception:** the code-block widget has no test id, so `.scriptor-component-code-block` is the only handle. It is a semantic class name, so it is acceptable.
- The UI text is English in this tenant. A localized tenant would need a locale map for the `aria-label` values.

## Composer and sending

| What | Locator |
|---|---|
| Composer | `#m365-chat-editor-target-element`, role `textbox`, aria-label `Message Copilot` |
| Composer wrapper | `[data-test-id="chat-input-wrapper"]` — note the hyphens, unlike `data-testid` elsewhere |
| Send button | inside the wrapper, `button[type="submit"][aria-label="Send"]` |

**`aria-label="Send"` is not unique on this page.** The Office feedback panel
(`[data-testid^="obf-"]`, e.g. `obf-DxTFormSubmitButton`) has its own Send, and it appears
unannounced over the chat. A page-wide `getByRole('button', { name: 'Send' })` then matches two
elements and Playwright refuses to choose, which ends the run on a strict mode violation with no
obvious connection to the cause. Observed 2026-09-19, mid-batch, between two messages.

So every Send lookup is scoped to the composer wrapper. The two buttons also differ in kind —
the composer's is its form's `type="submit"`, the feedback panel's is a plain `type="button"` —
which is the fallback when the wrapper attribute changes.

The feedback panel is detected and dismissed with **Escape only**. Nothing inside it is ever
clicked: its buttons submit an opinion from the operator's own account.

The composer is a **contenteditable `SPAN`**, not a textarea, part of the Fluent editor. Two consequences:

- `fill()` is preferred over keystrokes for long prompts.
- Pressing Enter did **not** submit in this test; clicking the Send button did. The bot should click Send and treat Enter only as a fallback.
- The Send button does not exist until the composer has content, so wait for it after filling.

## Turn structure

```
[data-testid="MessageListContainer"]
  [data-testid="m365-chat-llm-web-ui-chat-message"]   one turn, id=chatMessageContainer_<hash>
     [data-testid="chatQuestion"]                     the user's message
     [data-testid="chatOutput"]                       the Copilot answer
        [data-testid="copilot-message-div"]           id=chatMessageResponse-<hash>
           [data-testid="copilot-message-reply-div"]
              div[role="article"].fai-CopilotMessage
                 [data-testid="markdown-reply"]       rendered markdown
                 toolbar: Copy Response / feedback / Try Again
  ...
  [data-testid="lastChatMessage"]                     marks the newest answer
```

Counting turns is therefore `getByTestId('m365-chat-llm-web-ui-chat-message').count()`.

## Detecting the end of streaming

- While generating, a `button[aria-label="Stop generating"]` exists. It disappears when the answer is complete.
- When complete, the last message exposes `button[aria-label="Copy Response"]` (`data-testid="CopyButtonTestId"`).
- **`[data-testid="loading-message"]` is a trap.** It stayed in the DOM after generation finished, so it must not be used as a busy flag.

**`lastChatMessage` is not the whole answer.** It is the answer *body*, with a DOM id of
`response-id_...`. The toolbar holding `Copy Response` is its **sibling**, not its child.
Both live inside `copilot-message-div`. So a selector like

```
[data-testid="lastChatMessage"] [data-testid="CopyButtonTestId"]
```

matches nothing, and a wait built on it never completes. This was caught by evaluating the
selector against the live page rather than trusting the earlier DOM walk. The anchor for
anything that needs the whole answer is the last `copilot-message-div`, and since CSS cannot
express "the last element with this test id" across separate containers, the check runs in
JavaScript:

```js
const wrappers = document.querySelectorAll('[data-testid="copilot-message-div"]');
const last = wrappers[wrappers.length - 1];
const done = !stopGeneratingExists && !!last?.querySelector('[data-testid="CopyButtonTestId"]');
```

Recommended wait: turn count increased, then `Stop generating` absent, then the copy button
present in the last `copilot-message-div`, then text unchanged for ~1.5 s.

## Code blocks are virtualized: do not parse the DOM

A code block renders as `div.scriptor-component-code-block.scriptor-codeblock-virtualized`. Two problems:

1. **Line numbers are text nodes interleaved with the code.** `innerText` of a 120-line PowerShell block came back as `PowerShell\n1\nWrite-Output 1\n2\nWrite-Output 2\n...` — 242 lines for 120 lines of code. Any regex over this is guaranteed to corrupt the script.
2. **Long blocks collapse** behind a `Show more lines` button and the widget is explicitly virtualized, so a long script may not be fully present in the DOM at all.

**Chosen extraction strategy:** click the message-level `Copy Response` button and read the clipboard. It copies the whole answer as raw markdown, fences and language tags intact, which is exactly what the parser wants. Playwright grants clipboard access with:

```ts
await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
  origin: 'https://m365.cloud.microsoft',
});
const markdown = await page.evaluate(() => navigator.clipboard.readText());
```

Per-block `Copy code` (aria-label `Copy code`) is the fallback when only one block is needed.

**Evidence that DOM reading is unsafe.** A reply whose JSON was valid came back from
`innerText` as:

```
{"status":"continue","steps":[{"id":1,...,"cmd":"$os=Get-ComputerInfo; ..."}s":"report Windows version and C drive free space"}
```

The substring `}],"note` was simply missing from the DOM text: the widget had not rendered
that part of the wrapped line. The JSON on screen was correct; the JSON we could read was
not. This is not a parser bug we can work around, it is missing data.

Verified in the browser pane: clipboard read is denied without that grant, so the permission call is mandatory, not optional.

## Downloads: solved

This was the part the user expected to be hard. It is not. A file Copilot generates renders as an ordinary anchor inside the markdown:

```html
<a href="blob:https://m365.cloud.microsoft/a297bdcf-..."
   download="probe-long.ps1"
   aria-label="probe-long.ps1"
   target="_blank">probe-long.ps1</a>
```

That explains the reported behaviour: the href is a `blob:` URL created in the page, so hovering shows nothing useful, and only the click materializes the file.

For the bot:

- Locate by `a[download]` inside the last message, match on the `download` attribute for the file name.
- Register `page.waitForEvent('download')` **before** clicking, then `download.saveAs(...)`.
- Because the anchor carries `target="_blank"`, also listen on the context for a new page, so a download that gets attributed to a popup is not missed.

Observed in the same reply: Copilot showed a `Coding and executing` chip, meaning the tenant has the code interpreter enabled. That is what produces downloadable files.

## Uploading the results file: solved without a dialog

The chat composer keeps a hidden file input in the DOM at all times:

```html
<input type="file" id="upload-file-button" multiple accept=".doc,...,.txt,text/plain,...">
```

Playwright can call `setInputFiles('#upload-file-button', reportPath)` on it directly. The
"+" menu never has to be opened and no native Windows file dialog is involved, which removes
the only place where OS-level automation would still have been needed.

`.txt`, `.log`, `.csv`, `.md`, `.json`, `.xml` and `.yml` are all in the accept list.
`.ps1` is **not**, so a downloaded script cannot be handed straight back to the chat; it
would have to be renamed to `.txt` first.

Once the file is set, a chip appears in the composer:

```html
<div class="fx-AttachmentList" aria-label="Attachments">
  <div class="fx-Attachment" aria-label="iteration-1.txt" id="SPO_YWM2N2Y4YWEt...">
```

Two things follow. The chip's `aria-label` is the file name, so it is easy to wait for. Its
DOM id gets an `SPO_` prefix, and that prefix is the real "upload finished" signal, because
`SPO` is SharePoint. There is also a `button[aria-label="Remove attachment <file>"]` for
taking an attachment back.

### Uploads go through the user's OneDrive

The composer shows this notice while an attachment is pending:

> Uploading from device will send a copy to OneDrive (work/school).

This is a real consequence, not a cosmetic warning. Every terminal report the bot sends is
stored as a file in the user's OneDrive for Business. It must be stated in the README and in
the confirm-mode prompt, because terminal output can contain host names, paths, user names
and occasionally secrets. Options to offer: a retention setting that deletes old report
files, and a redaction pass before upload.

### Validated end to end

A 274-byte report file was attached and sent in the live chat. Copilot opened it and quoted
back both a token from the middle of the file and the exact stderr line, inside the required
JSON block:

```json
{"status":"continue","steps":[],"notes":"MAGIC_TOKEN=ZX9-QUARTZ-7781 ; The system cannot find the path specified."}
```

So the file transport works, Copilot reads attachments reliably, and the format contract
survives a message that carries an attachment.

## Other controls seen

| Control | Locator | Note |
|---|---|---|
| New chat | `a[aria-label="New chat"]`, href `/chat?es=SSR&redirfrom=cosmicRingCookie` | It is an anchor, so navigating to the chat URL is equivalent. |
| Model selector | `button#gptModeSwitcher[aria-label="Model Selector"]`, showed `Auto` | Now read and driven; see below. |
| Add sources | `button[data-testid="PlusMenuButton"]` | File upload path, not needed for v1. |
| Temporary chat | `button[aria-label="Temporary chat"]` | Could be useful to avoid polluting chat history. |

## The model picker

Captured live on 2026-09-18, on the same tenant.

```html
<button id="gptModeSwitcher" aria-label="Model Selector" aria-haspopup="menu">Auto</button>
```

The button's **text is the value** (`Auto`), while its `aria-label` is the control's name.

**The menu is two levels deep.** Top-level choices are `role="menuitemradio"` with the name on
the first line and a description on the second. A vendor is a `role="menuitem"` row carrying
`aria-haspopup="menu"` that opens a submenu holding that vendor's models. Live on this tenant:

| Row | Kind | Children |
|---|---|---|
| Auto — Decides how long to think | choice, `aria-checked="true"` | |
| Quick response — Answers right away | choice | |
| Think deeper — Think longer for better answers | choice | |
| GPT — OpenAI | group, `aria-haspopup="menu"` | GPT 5.6 Think deeper, GPT 5.6 Quick response |

A tenant with Anthropic enabled gets a Claude group the same way. **Reading only the first
role that matches hides every grouped model**, which is what the first implementation did: it
returned the three thinking modes and no models at all. Every role is now read, groups are
opened one at a time from a freshly opened menu, and a submenu's children are identified as
whatever is on screen that was not on the top level.

**This list is not in the code and must never be.** It is what one tenant showed on one day;
another tenant sees other entries, and Microsoft changes them.

Two more facts worth keeping:

- **The button truncates.** After choosing `GPT 5.6 Quick response` it reads `GPT 5.6 Quick`.
  So verification accepts a button value that is a piece of the chosen name, and the full name
  is what gets reported and stored.
- **Nothing is marked while a grouped model is active.** With `GPT 5.6 Quick response` chosen,
  no row in the menu came back with `aria-checked="true"`. The button is therefore the only
  reliable answer to "what is this chat on", and `selected` on an option is a hint, not proof.

**The button hydrates later than the composer.** `ensureSignedIn()` returns as soon as the
composer is visible, and at that moment the button is not in the DOM yet. Checking once found
nothing and the first live read reported "this chat has no model picker" about a chat that
plainly has one. `resolveModelButton()` therefore polls for up to 15 s. The four-second pause
in a throwaway probe is what turned a wrong conclusion into a fact.

Verified end to end on the live chat: reading the current value, switching to `Quick response`
and reading it back, refusing a name the menu does not offer (`Claude Sonnet 5`) without
changing anything, reading all five entries including both inside the GPT group, selecting
`GPT 5.6 Quick response` from that group and confirming it, and switching back to `Auto`.

## Not yet verified

1. That a real Playwright-launched Edge with its own profile passes this tenant's Conditional Access. The sign-in used for this probe happened in a different browser.
2. That `download.saveAs()` actually receives the blob file. The anchor shape makes it very likely, but it needs one run.
3. Clipboard read after `grantPermissions` on this origin.
4. Whether Copilot holds the JSON contract over many turns.

## Contract validated live

The persona in `prompts/01-persona.md` plus the contract in `prompts/02-format.md` were
tested in a fresh chat on the same day, in a condensed form.

- The handshake reply was exactly `{"status":"continue","steps":[],"notes":"ready"}` in a
  single `json` block.
- The first real task produced a well-formed `command` step with `shell: "pwsh"` and a
  single-line command, no prose outside the block.

So the format holds at least for the opening turns. Endurance over 20+ turns is still open.

## Copilot destroys `[name]:` in its own output

Found while running the first successful loop. A PowerShell command containing
`[math]::Round($x, 2)` reached the runner as `:Round($x, 2)`, three iterations in a row.

It is not this project's copy path. Feeding that exact command through `extractFencedBlocks`,
`stripLineNumbers` and `parseReply` returns it byte for byte. And the mangled form was
already on screen in the chat: the rendered JSON block showed `Expression={:Round(...)}`,
and Copilot's own `notes` field said that `':Round'` had been emitted instead of `'[math]::'`.

The pattern is specific. In the same replies, `[pscustomobject]@{...}` and `[double]$c`
survived untouched. What they lack is the colon: `[label]:` is what a markdown parser reads
as a link-reference definition, and something in Copilot's output pipeline consumes it,
taking one of the two colons with it. It happens even inside a fenced code block.

Consequences for this project:

- `prompts/01-persona.md` and `prompts/02-format.md` forbid `[type]::Method(...)` and give
  three alternatives that are verified to work in PowerShell: a type in a variable
  (`$m = [math]; $m::Round($x, 2)`), the format operator (`"{0:N2}" -f $x`), and a method on
  the value (`$x.ToString("N2")`). A space before the colons is a syntax error, not a fix.
- `findLikelyDamage()` in `src/protocol/parser.ts` recognises the wreckage and the runner
  refuses the step rather than executing a command nobody wrote. The damage cannot be
  repaired here, because the type name is gone and guessing it would be worse than failing.
