/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verify that the installed native binaries match THIS machine before anything tries to
 * exec them.
 *
 * Why this exists: several dependencies ship compiled per-platform binaries (esbuild, which
 * tsx and vite both use; mongodb-memory-server's mongod). If `node_modules` was
 * populated on a different OS/CPU -- which happens whenever a project folder is shared or
 * synced between machines, or copied into a container -- those binaries cannot run here.
 * The native failures are famously unhelpful: `sh: tsx: command not found`,
 * `cannot execute binary file`, `spawn ENOEXEC`. This turns them into one clear message.
 *
 * Plain .mjs on purpose: it must run when tsx itself is the thing that is broken.
 */

import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nodeModules = join(root, 'node_modules');

// esbuild's own naming: platform-arch, with a couple of special cases we don't hit here.
const expected = `${process.platform}-${process.arch}`;
const problems = [];

if (!existsSync(nodeModules)) {
  problems.push('node_modules is missing entirely.');
} else {
  const esbuildDir = join(nodeModules, '@esbuild');
  if (existsSync(esbuildDir)) {
    const installed = readdirSync(esbuildDir).filter(n => !n.startsWith('.'));
    if (installed.length > 0 && !installed.includes(expected)) {
      problems.push(
        `esbuild binary is for ${installed.join(', ')} but this machine needs ${expected}.`
      );
    }
  }
  if (!existsSync(join(nodeModules, '.bin', 'tsx'))) {
    problems.push('the tsx binary is not installed.');
  }
}

if (problems.length > 0) {
  const line = '='.repeat(78);
  console.error(`\n${line}`);
  console.error('  Dependencies do not match this machine, so the app cannot start.\n');
  for (const p of problems) console.error(`    - ${p}`);
  console.error(`\n  This machine: ${process.platform}-${process.arch} (node ${process.versions.node})`);
  console.error('\n  Fix (run on THIS machine):\n');
  console.error('      rm -rf node_modules package-lock.json');
  console.error('      npm install\n');
  console.error('  Native binaries cannot be shared across operating systems or CPUs. If this');
  console.error('  folder is synced or shared between two machines (e.g. a Mac and a Linux');
  console.error('  container), they will keep overwriting each other\'s node_modules and only');
  console.error('  whichever one installed last will work. Pick one machine to run on, or give');
  console.error('  each machine its own checkout.');
  console.error(`${line}\n`);
  process.exit(1);
}
