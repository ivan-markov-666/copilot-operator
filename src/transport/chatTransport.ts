/**
 * What the runner, the reviewer and the API need from a chat, and where that chat comes from.
 *
 * Everything that talks to Copilot goes through `CopilotTransport`, which drives a real Edge window
 * signed in to Microsoft 365. That is the product, and it is also why nothing above the transport
 * could be tested end to end: every run opened a browser, signed in and spent the operator's hourly
 * message allowance. The loop itself — send, read the reply, run the steps, report back, stop at the
 * limit, carry on after an interruption, commit on the right branch — never touches the page, only
 * these few methods. So the rest of the code asks for a `ChatTransport` and gets one from
 * `createTransport`, and the automated checks put a scripted chat in its place (test/support/fakeChat.ts)
 * that answers from a script and never opens a window.
 *
 * The type is a `Pick` of the real class rather than an interface written out by hand, so the two
 * cannot drift apart: a method that changes its signature in `CopilotTransport` changes it here, and
 * the scripted chat stops compiling instead of passing checks against a shape the product no longer has.
 *
 * Deliberately, nothing outside the code can swap the chat: no environment variable, no setting, no
 * command-line flag. A scripted chat hands the runner steps to execute, and a switch that a file or
 * an environment could flip would be a way to make the bot run commands nobody reviewed. Only code
 * running in this process — a check script — can call `setTransportFactory`.
 */
import { CopilotTransport, type TransportOptions } from './copilotTransport.js';

export { ReplyTimeoutError, isReplyTimeout } from './copilotTransport.js';

export type ChatTransport = Pick<
  CopilotTransport,
  | 'open'
  | 'close'
  | 'ensureSignedIn'
  | 'newChat'
  | 'openConversation'
  | 'openConversationByName'
  | 'currentChatId'
  | 'nameChat'
  | 'selectModel'
  | 'currentModel'
  | 'listModels'
  | 'sendAndConfirm'
  | 'waitForReply'
  | 'dumpFailure'
  | 'recentCrash'
  | 'signOut'
  | 'gotoChatAs'
  | 'findAccountsInPage'
>;

export type TransportFactory = (opts: TransportOptions) => ChatTransport;

const realChat: TransportFactory = (opts) => new CopilotTransport(opts);
let factory: TransportFactory = realChat;

/** A chat for these options: the real Copilot window, unless a check has put a scripted one in. */
export function createTransport(opts: TransportOptions): ChatTransport {
  return factory(opts);
}

/** For checks only: every chat opened from now on comes from `f`. `null` puts the real one back. */
export function setTransportFactory(f: TransportFactory | null): void {
  factory = f ?? realChat;
}
