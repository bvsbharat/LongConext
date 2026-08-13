/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `npm run start` runs a pre-built bundle. Without a build it failed with a raw
 * MODULE_NOT_FOUND stack trace for `dist/server.cjs`, which reads like a broken install
 * rather than "you skipped a step" -- and it is an easy command to reach for when you just
 * want the app running. Say what to do instead.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

if (!existsSync(join(root, 'dist', 'server.cjs'))) {
  const line = '='.repeat(78);
  console.error(`\n${line}`);
  console.error('  Nothing to start: dist/server.cjs has not been built.\n');
  console.error('  For local development you almost certainly want:\n');
  console.error('      npm run dev            # API + UI on http://localhost:3000');
  console.error('                             # one process, one port -- no separate client\n');
  console.error('  `npm run start` only serves a production build. If that is what you want:\n');
  console.error('      npm run build && npm run start\n');
  console.error(`${line}\n`);
  process.exit(1);
}
