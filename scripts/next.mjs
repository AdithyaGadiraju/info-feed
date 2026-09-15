#!/usr/bin/env node
/**
 * Runs the Next CLI with `.env` already applied to the environment.
 *
 * `next dev` and `next start` resolve `--port` from `process.env.PORT` while parsing
 * their arguments, which happens before Next loads `.env` itself. So `PORT=3005` in
 * `.env` was silently ignored and the server always came up on 3000. Preloading dotenv
 * with `node -r dotenv/config next` does not fix it either: Next forks the dev server
 * and re-serialises the parent's `execArgv` into `NODE_OPTIONS`, where `-r` is not a
 * legal entry, so the fork dies on startup. Loading `.env` here and spawning the CLI as
 * a plain child process is the only place the variable is set early enough to count.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ quiet: true });

const nextBin = fileURLToPath(new URL('../node_modules/next/dist/bin/next', import.meta.url));

const child = spawn(process.execPath, [nextBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

// Ctrl-C must stop the dev server, not just this wrapper.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 0));
});
