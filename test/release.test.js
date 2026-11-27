'use strict';
// The release workflow: on every push to main, release the package.json version if it is new.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'release.yml'), 'utf8');

test('release workflow: runs on main, tests first, releases only a new package.json version', () => {
  assert.match(wf, /on:\n  push:\n    branches: \[main\]/);
  assert.match(wf, /permissions:\n  contents: write/);
  assert.ok(wf.indexOf('npm test') < wf.indexOf('gh release create'), 'tests run before releasing');
  assert.match(wf, /version=\$\(node -p "require\('\.\/package\.json'\)\.version"\)/);
  assert.match(wf, /if gh release view "\$version"[^\n]*\n[\s\S]*?exit 0/, 'an existing release is left alone');
  assert.match(wf, /gh release create "\$version" --target "\$GITHUB_SHA" --title "\$version" --generate-notes/, 'plain version tags, like 1.1.0 and 1.2.0');
  assert.doesNotMatch(wf, /secrets\./, 'needs only the built-in token');
});

test('version is 1.3.0 in package.json and package-lock.json', () => {
  const pkg = require('../package.json');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.version, '1.3.0');
  assert.equal(lock.version, '1.3.0');
  assert.equal(lock.packages[''].version, '1.3.0');
});
