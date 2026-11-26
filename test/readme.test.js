'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const section = readme.split('### 2. Cloudflare bot settings')[1].split('\n### ')[0];

test('README bot settings: only /24 ranges Cloudflare IP Access rules accept', () => {
  assert.doesNotMatch(readme, /160\.79\.104\.0\/21|153\.61\.208\.0\/20/);
  for (const cidr of section.match(/\b\d+\.\d+\.\d+\.\d+\/\d+/g)) assert.match(cidr, /\/(24|16)$/, cidr);
  assert.match(section, /eight Allow rules/);
  assert.match(section, /`160\.79\.104\.0\/24` through `160\.79\.111\.0\/24`/);
  assert.match(section, /Optionally also add `153\.61\.208\.0\/24` through `153\.61\.223\.0\/24`/);
});

test('README bot settings: turning off Block AI Bots and Bot Fight Mode is still an option', () => {
  assert.match(section, /turn off \*\*Block AI Bots\*\* and \*\*Bot Fight Mode\*\*.*\*\*or\*\*/);
});
