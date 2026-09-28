import assert from 'node:assert/strict';
import { copyFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const expectedVersion = '6.3.289';
const packageJsonPath = fileURLToPath(new URL('../node_modules/pdfjs-dist/package.json', import.meta.url));
const sourcePath = fileURLToPath(new URL('../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url));
const targetPath = fileURLToPath(new URL(`../public/pdf.worker-${expectedVersion}.min.mjs`, import.meta.url));
const installed = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

assert.equal(
  installed.version,
  expectedVersion,
  `Refusing to copy pdfjs-dist ${installed.version}; expected ${expectedVersion}`,
);

copyFileSync(sourcePath, targetPath);
console.log(`synced pdfjs-dist ${installed.version} worker to public/pdf.worker-${expectedVersion}.min.mjs`);
