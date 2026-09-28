import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const buildRoot = new URL('../build/', import.meta.url);
const buildPath = fileURLToPath(buildRoot);

assert.ok(existsSync(buildPath), 'Production build is missing; run npm run build first');

const files = [];
const visit = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) visit(absolutePath);
    else files.push(relative(buildPath, absolutePath).replaceAll('\\', '/'));
  }
};
visit(buildPath);

const workers = files.filter((file) => /pdf\.worker.*\.mjs$/i.test(file));
assert.deepEqual(
  workers,
  ['pdf.worker-6.3.289.min.mjs'],
  `Expected only the versioned raw PDF.js 6 worker, found: ${workers.join(', ')}`,
);
assert.ok(!files.includes('pdf.worker.min.js'), 'Legacy PDF.js 3 worker remains in the production build');

const workerSource = readFileSync(join(buildPath, workers[0]), 'utf8');
assert.match(workerSource, /6\.3\.289/, 'Worker source does not contain the expected API version');
assert.doesNotMatch(workerSource, /@babel\/runtime|(?:[A-Za-z]:)?[\\/]Users[\\/]/i, 'Worker contains build-machine imports');

console.log(`production build contains only ${workers[0]}`);
