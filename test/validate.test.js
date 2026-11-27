'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../lib/validate');
const { S } = require('../lib/hub');

const now = Date.parse('2026-11-26T12:00:00Z');

test('plain text: control, bidi and zero-width characters are removed', () => {
  assert.equal(V.plainText('a\u0000b‮c​d\n e'), 'abcd e');
  assert.equal(V.plainText('line 1\r\n\r\n\r\nline 2', true), 'line 1\n\nline 2');
});

test('unknown fields are rejected', () => {
  assert.throws(() => V.validate(S.alert, { key: 'k', severity: 'warn', title: 't', extra: 1 }), /unknown field "extra"/);
});

test('max lengths: 500 for fields, 4000 for summary', () => {
  const base = { kind: 'note', status: 'ok', title: 'x' };
  assert.throws(() => V.validate(S.update, { ...base, title: 'x'.repeat(501) }), /longer than 500/);
  assert.equal(V.validate(S.update, { ...base, summary: 'y'.repeat(4000) }).summary.length, 4000);
  assert.throws(() => V.validate(S.update, { ...base, summary: 'y'.repeat(4001) }), /longer than 4000/);
});

test('types, enums and required fields', () => {
  assert.throws(() => V.validate(S.alert, { key: 'k', severity: 'major', title: 't' }), /severity: must be one of/);
  assert.throws(() => V.validate(S.alert, { key: 'k', severity: 'warn' }), /missing "title"/);
  assert.throws(() => V.validate(S.alert, { key: 'k', severity: 'warn', title: 5 }), /title: must be a string/);
  assert.throws(() => V.validate(S.alert, { key: '   ', severity: 'warn', title: 't' }), /key: must not be empty/);
  assert.throws(() => V.validate(S.setNeedToRead, { ids: ['a'], value: 'no' }), /must be true or false/);
  assert.throws(() => V.validate(S.list, { section: 'emails', limit: 51 }), /must be 1-50/);
});

test('dates must be ISO 8601 with a zone and not in the future', () => {
  assert.equal(V.validate(V.date(), '2026-11-26T08:00:00-05:00', { now }), '2026-11-26T13:00:00.000Z');
  assert.throws(() => V.validate(V.date(), '2026-11-26 08:00', { now }), /ISO 8601/);
  assert.throws(() => V.validate(V.date(), 'yesterday', { now }), /ISO 8601/);
  assert.throws(() => V.validate(V.date(), '2026-11-28T08:00:00Z', { now }), /future/);
});

test('URLs are stripped from text', () => {
  assert.equal(V.stripUrls('Reset at https://evil.example/x?y=1 now'), 'Reset at now');
  assert.equal(V.stripUrls('see www.example.com/a or example.org/login'), 'see or');
  assert.equal(V.stripUrls('click javascript:alert(1) here'), 'click here');
  assert.equal(V.stripUrls('Amazon <ship@amazon.com>'), 'Amazon <ship@amazon.com>');
});

test('codes are masked only in code-like subjects', () => {
  assert.equal(V.maskCodes('Your verification code is 482913'), 'Your verification code is •••');
  assert.equal(V.maskCodes('OTP: 1234 and 99887766'), 'OTP: ••• and •••');
  assert.equal(V.maskCodes('Your passcode 123456789 (9 digits kept)'), 'Your passcode 123456789 (9 digits kept)');
  assert.equal(V.maskCodes('Invoice 2026-1234'), 'Invoice 2026-1234');
});

test('JSON Schema matches the validation rules', () => {
  const s = V.toJsonSchema(S.publish);
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(Object.keys(s.properties), ['update', 'news', 'emails', 'alerts']);
  assert.equal(s.properties.update.properties.summary.maxLength, 4000);
  assert.equal(s.properties.emails.maxItems, 200);
  assert.deepEqual(Object.keys(s.properties.emails.items.properties), ['id', 'received_at', 'sender', 'subject', 'label', 'need_to_read']);
  assert.equal(s.properties.emails.items.additionalProperties, false);
});
