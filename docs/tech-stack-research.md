# Tech stack research: Copilot chat automation bot for Windows

Date: 2026-09-17

> Decision (same day): browser automation only, see `architecture.md`. The OS-automation and API rows below are kept for the record.

## Goal

A Windows bot that:

1. Sends a user-defined sequence of opening messages to a Microsoft 365 Copilot chat.
2. Reads each reply, extracts terminal commands (Copilot is instructed to answer in a fixed format).
3. Downloads script files that Copilot attaches to the chat (links are not visible on hover; clicking starts the download).
4. Runs the commands in a terminal, captures the output in order.
5. Sends the combined output back to the chat and loops until the reply contains the stop marker ("Край").

Open-source project, so every dependency must have a permissive, OSI-approved license.

## Three ways to talk to Copilot

| Approach | Verdict | Why |
|---|---|---|
| **A. Browser automation of the Copilot web app** (`m365.cloud.microsoft/chat`, moving to `copilot.cloud.microsoft`) with **Playwright** | **Primary choice** | DOM access instead of pixels: read message text and code blocks exactly, wait for the stop marker, catch downloads through the `download` event no matter how the link is rendered (blob URLs included). Works with what the user sees today, needs no admin consent. Apache-2.0, maintained by Microsoft, latest 1.63.0 (Sep 2026). Drives real Edge via `channel: 'msedge'`. |
| **B. Official Copilot Chat API** (Work IQ Chat API, GA June 2026; Graph `/beta/copilot/conversations`, still preview) | **Second transport, behind an interface** | Cleanest long-term path, but: needs an M365 Copilot add-on license or Copilot Credits, admin consent for Entra scopes, **text-only responses**, **no code interpreter and no file generation**, so "download the attached script" is impossible. Scripts would have to be inlined as text. Also prone to gateway timeouts on long tasks. |
| **C. OS-level GUI automation** (nut.js, robotjs, pywinauto, FlaUI, PyAutoGUI) | **Fallback only** | Coordinate/keyboard driving is brittle, reading chat text needs clipboard tricks or OCR, and there is no download event. nut.js pulled its prebuilt npm packages behind a subscription in 2024 (repo stays Apache-2.0, but you must build native deps yourself); the community fork `@nut-tree-fork/nut-js` 4.2.6 is Apache-2.0 but last published March 2025. If a policy ever forbids browser automation, pywinauto (BSD-3, UIA backend) on the Edge/WebView2 accessibility tree is the sanest option. |

Notes:

- The Windows "Microsoft 365 Copilot" app is a web shell (WebView2). Playwright can even attach to it over CDP, but automating the web app in Edge directly is simpler and identical in behavior.
- Teams Copilot messages are not returned by the Graph `/chats/{id}/messages` endpoint, so there is no back door through Teams.
- Playwright bug to remember: `launchPersistentContext` with Edge's default profile directory hangs on `about:blank`. Use a dedicated profile folder for the bot; the human logs in with MFA once, the session persists.
- Risk to verify early: Entra Conditional Access / device-compliance rules may reject a fresh Edge profile. Test with the target tenant before building anything else.

## Recommended stack

| Concern | Choice | License | Why |
|---|---|---|---|
| Language / runtime | TypeScript on Node.js LTS | MIT | Playwright is first-class in Node; one language for browser, process control and CLI. Python + Playwright is an equally valid alternative if the team prefers it. |
| Chat transport | Playwright (`playwright`, Edge channel, persistent context) | Apache-2.0 | See table above. |
| Downloads | Playwright `page.waitForEvent('download')` + `download.saveAs()` | Apache-2.0 | Fires on click regardless of how the link is rendered; blob URLs supported. Register the wait **before** clicking. |
| Command execution | Node `child_process.spawn` of `pwsh` / `powershell.exe` / `cmd.exe` | built-in | Capture stdout, stderr, exit code, per-command timeout, working directory. |
| Response parsing | Fenced block in a fixed format (JSON recommended) + `zod` schema validation | MIT | Copy from the DOM `pre > code` elements rather than regexing rendered text. Reject malformed replies and ask Copilot to resend. |
| Config (opening messages, persona, format) | YAML files (`yaml` package) + `commander` CLI | ISC / MIT | Users edit a list of first messages without touching code. |
| Logging / transcript | `pino` + JSONL run log | MIT | Full audit trail: every prompt, reply, command, output, downloaded file hash. |
| Tests | `vitest` + Playwright | MIT / Apache-2.0 | Unit-test the parser and runner; record a DOM fixture for the chat page. |
| Project license | MIT or Apache-2.0 | | All dependencies above are compatible. |

## Architecture sketch

```
config (yaml) ─► Orchestrator loop
                   │
                   ├─► ChatTransport (interface)
                   │     ├─ PlaywrightWebTransport   (now)
                   │     └─ WorkIqApiTransport       (later, text-only)
                   ├─► ResponseParser  (fixed format ─► commands[], downloads[], done?)
                   ├─► Downloader      (download event ─► ./artifacts/<run>/)
                   ├─► CommandRunner   (spawn shell, capture, timeout, allow/deny list)
                   └─► Reporter        (assemble ordered output ─► next message)
```

## Safety requirements (non-negotiable for an OSS release)

- The bot executes commands and scripts written by an LLM. Ship with a **confirm mode** on by default (show the commands, wait for Enter), plus an unattended mode behind an explicit flag.
- Allow/deny list for commands (deny `Remove-Item -Recurse`, `format`, registry writes, etc. by default).
- Max iterations and wall-clock limit per run; per-command timeout.
- Downloaded scripts are hashed and logged; never executed unless the run is in unattended mode and the file type is on the allow list.
- Recommend running in a dedicated Windows account or Windows Sandbox.

## First spikes (in order)

1. Playwright + Edge persistent profile: can it sign in to the target tenant and stay signed in? (Conditional Access check.)
2. Inspect the Copilot chat DOM: stable locators for the textbox, send button, message list, code blocks, attachment cards.
3. Click an attachment card and confirm the `download` event fires and the file saves.
4. Ask the tenant admin whether Work IQ / Chat API is enabled and licensed, to plan the second transport.

## Sources

- nut.js: https://nutjs.dev/blog/i-give-up , https://github.com/nut-tree/nut.js/blob/develop/README.md , npm registry for `@nut-tree-fork/nut-js`
- Playwright: https://playwright.dev/docs/downloads , https://playwright.dev/docs/webview2 , https://learn.microsoft.com/en-us/microsoft-edge/playwright/ , https://github.com/microsoft/playwright/issues/21019
- Copilot APIs: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/ai-services/chat/overview , https://devblogs.microsoft.com/microsoft365dev/microsoft-365-copilot-apis-whats-new-and-whats-next/ , https://spknowledge.com/2026/09/02/microsoft-365-copilot-chat-api/
- Copilot web app URLs: https://learn.microsoft.com/en-us/copilot/manage , https://support.microsoft.com/en-us/microsoft-365-copilot/the-microsoft-365-app-transition-to-the-microsoft-365-copilot-app
- Teams Graph limitation: https://learn.microsoft.com/en-us/answers/questions/5709565/graph-api-chats-chat-id-messages-does-not-return-m
- Windows GUI tools: https://github.com/pywinauto/pywinauto , https://testguild.com/automation-tools-desktop/
