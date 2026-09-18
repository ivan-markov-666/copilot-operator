/**
 * Starts the API on localhost.
 *
 *   node dist/src/api/main.js
 *
 * Only 127.0.0.1 is bound, because this process drives the operator's own browser and runs
 * commands on this machine. Exposing it on a network interface would hand that to anyone who
 * could reach the port.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';

const PORT = Number(process.env.COP_API_PORT ?? 4000);
const WEB_ORIGIN = process.env.COP_WEB_ORIGIN ?? 'http://localhost:3210';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn', 'log'] });
  app.enableCors({ origin: [WEB_ORIGIN, WEB_ORIGIN.replace('localhost', '127.0.0.1')] });
  app.setGlobalPrefix('api');
  await app.listen(PORT, '127.0.0.1');
  console.log(`copilot-operator api listening on http://127.0.0.1:${PORT}/api  (web origin ${WEB_ORIGIN})`);
}

main().catch((e: unknown) => {
  console.error((e as Error).message);
  process.exit(1);
});
