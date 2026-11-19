/**
 * Starts the API on localhost.
 *
 *   node dist/src/api/main.js
 *
 * Only 127.0.0.1 is bound, because this process drives the operator's own browser and runs
 * commands on this machine. Exposing it on a network interface would hand that to anyone who
 * could reach the port.
 */
import { startApi } from './server.js';

/*
 * A stray rejection must not end a run.
 *
 * Node's default for an unhandled rejection is to crash, which for this process means killing
 * the browser, the queue and every session still waiting behind it — for a promise nobody was
 * even reading any more. That happened: a losing `Promise.race` branch inside a download
 * rejected when the window closed and took a batch of three sessions with it. The cause is
 * fixed where it was, but the class of fault is not worth dying for, so it is logged loudly and
 * the process carries on. A task that genuinely failed still fails, through its own error path.
 */
process.on('unhandledRejection', (reason) => {
  console.error('[api] unhandled rejection (the run continues):', reason instanceof Error ? reason.stack : reason);
});

process.on('uncaughtException', (error) => {
  console.error('[api] uncaught exception (the run continues):', error.stack ?? error.message);
});

startApi().catch((e: unknown) => {
  console.error((e as Error).message);
  // Said in words too (2026-11-19): the bare "listen EADDRINUSE" left the operator to guess what holds the port.
  if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
    const port = Number(process.env.COP_API_PORT ?? 4000);
    console.error(`Port ${port} is taken. If copilot-operator is running already, open http://127.0.0.1:${port}/ ; otherwise another program has the port: close it, or start this one with COP_API_PORT set to another.`);
  }
  process.exit(1);
});
