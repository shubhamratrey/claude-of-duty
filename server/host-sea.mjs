// The entry point that esbuild bundles into the single executable.
//
// It exists separately from host-entry.mjs so that importing the host's logic
// has no side effects and can be unit tested. Everything here is arrangement:
// work out whether we are inside a Single Executable Application, and if we are
// not, allow the checkout's own export/web to stand in for the bundled copy so
// `node server/host-sea.mjs` behaves like the packaged app.
//
// Two constraints from the SEA format shape the style:
//   * There is no top-level await, because esbuild cannot express one in the
//     CommonJS output that `--experimental-sea-config` requires.
//   * `import.meta.url` means nothing once this is a resource inside a binary,
//     so it is only consulted on the path where we know we are not one.

import path from 'node:path';
import process from 'node:process';
import { isSeaRuntime, startHost } from './host-entry.mjs';

/** export/web in the checkout this file was loaded from, or null in a SEA. */
function checkoutWebDir() {
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    return path.resolve(here, '..', 'export', 'web');
  } catch {
    return null;
  }
}

async function main() {
  const extraWebDirs = [];
  if (!(await isSeaRuntime())) {
    const checkout = checkoutWebDir();
    if (checkout) extraWebDirs.push(checkout);
  }
  await startHost({ extraWebDirs });
}

main().catch((error) => {
  process.stderr.write(`PlayOps: ${error?.stack ?? error}\n`);
  process.exit(1);
});
