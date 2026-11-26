'use strict';
// A tiny schema language used for two things at once: the JSON Schemas the MCP tools advertise,
// and the validation that runs on every argument. Keeping both in one place means they can't drift.
//
//   str(max, opts)   string, trimmed, control characters removed, at most `max` characters
//   bool()           boolean
//   int(min, max)    integer
//   date()           ISO 8601 date-time, normalised to UTC (toISOString)
//   obj(fields)      object; unknown fields are rejected
//   arr(items, max)  array
// Any spec can be marked required with req(spec).

const MAX_TEXT = 500;
const MAX_SUMMARY = 4000;
const MAX_ITEMS = 200;

const str = (max = MAX_TEXT, opts = {}) => ({ type: 'string', max, ...opts });
const bool = (opts = {}) => ({ type: 'boolean', ...opts });
const int = (min, max, opts = {}) => ({ type: 'integer', min, max, ...opts });
const date = (opts = {}) => ({ type: 'date', ...opts });
const obj = (fields, opts = {}) => ({ type: 'object', fields, ...opts });
const arr = (items, max = MAX_ITEMS, opts = {}) => ({ type: 'array', items, max, ...opts });
const req = spec => ({ ...spec, required: true });
const desc = (spec, description) => ({ ...spec, description });

class ValidationError extends Error {}

// Plain text only: no control characters, bidi overrides or zero-width characters.
// Single-line fields also have their whitespace collapsed.
function plainText(s, multiline = false) {
  s = s.normalize('NFC').replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g, '');
  s = multiline ? s.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n') : s.replace(/\s+/g, ' ');
  return s.trim();
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;
const FUTURE_SLACK = 3600e3; // reject timestamps more than an hour in the future

function check(spec, value, where, now) {
  const fail = msg => { throw new ValidationError(where ? `${where}: ${msg}` : msg); };
  switch (spec.type) {
    case 'string': {
      if (typeof value !== 'string') fail('must be a string');
      if (value.length > spec.max) fail(`longer than ${spec.max} characters`);
      const v = plainText(value, spec.multiline);
      if (spec.required && !v) fail('must not be empty');
      if (spec.enum && !spec.enum.includes(v)) fail(`must be one of ${spec.enum.join(', ')}`);
      if (spec.pattern && !spec.pattern.test(v)) fail('has invalid characters');
      return v;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail('must be true or false');
      return value;
    case 'integer':
      if (!Number.isInteger(value)) fail('must be an integer');
      if (value < spec.min || value > spec.max) fail(`must be ${spec.min}-${spec.max}`);
      return value;
    case 'date': {
      if (typeof value !== 'string' || value.length > 40 || !ISO_RE.test(value.trim())) fail('must be an ISO 8601 date-time with a time zone');
      const t = Date.parse(value.trim());
      if (!Number.isFinite(t)) fail('is not a valid date');
      if (t > now + FUTURE_SLACK) fail('is in the future');
      return new Date(t).toISOString();
    }
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) fail('must be an object');
      for (const k of Object.keys(value)) if (!Object.hasOwn(spec.fields, k)) fail(`unknown field "${k}"`);
      const out = {};
      for (const [k, f] of Object.entries(spec.fields)) {
        const v = value[k];
        if (v === undefined || v === null) {
          if (f.required) fail(`missing "${k}"`);
          if (f.default !== undefined) out[k] = f.default;
          continue;
        }
        out[k] = check(f, v, where ? `${where}.${k}` : k, now);
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(value)) fail('must be an array');
      if (value.length > spec.max) fail(`more than ${spec.max} items`);
      if (spec.required && !value.length) fail('must not be empty');
      return value.map((v, i) => check(spec.items, v, `${where || ''}[${i}]`, now));
    }
    default:
      throw new Error(`unknown spec type ${spec.type}`);
  }
}

// Validate and normalise `value`; throws ValidationError with a short reason.
function validate(spec, value, { now = Date.now(), where = '' } = {}) {
  return check(spec, value, where, now);
}

// JSON Schema for a spec (what MCP clients see in tools/list).
function toJsonSchema(spec) {
  let s;
  switch (spec.type) {
    case 'string':
      s = { type: 'string', maxLength: spec.max };
      if (spec.enum) { s = { type: 'string', enum: spec.enum }; }
      break;
    case 'boolean': s = { type: 'boolean' }; break;
    case 'integer': s = { type: 'integer', minimum: spec.min, maximum: spec.max }; break;
    case 'date': s = { type: 'string', format: 'date-time' }; break;
    case 'object': {
      s = { type: 'object', properties: {}, additionalProperties: false };
      const required = [];
      for (const [k, f] of Object.entries(spec.fields)) {
        s.properties[k] = toJsonSchema(f);
        if (f.required) required.push(k);
      }
      if (required.length) s.required = required;
      break;
    }
    case 'array': s = { type: 'array', items: toJsonSchema(spec.items), maxItems: spec.max }; break;
    default: throw new Error(`unknown spec type ${spec.type}`);
  }
  if (spec.description) s.description = spec.description;
  return s;
}

// ---------------------------------------------------------------- email sanitising

// Anything that looks like a link: scheme URLs (http, javascript, mailto, ...), www.*,
// and bare domains followed by a path (example.com/login).
const URL_RES = [
  /\b[a-z][a-z0-9+.-]{1,20}:\/\/\S*/gi,
  /\b(?:javascript|vbscript|data|mailto|tel|sms|file):\S*/gi,
  /\bwww\.\S+/gi,
  /\b(?:[a-z0-9-]+\.)+[a-z]{2,24}\/\S*/gi,
];
function stripUrls(s) {
  for (const re of URL_RES) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').replace(/[<(\[]\s*[>)\]]/g, '').trim();
}

// Subjects of one-time-code emails: hide the code itself.
const CODE_WORDS_RE = /\b(codes?|verification|verify|verif\w*|otp|passcodes?|pass\s?code|one[- ]time|2fa|mfa|pin)\b/i;
function maskCodes(subject) {
  if (!CODE_WORDS_RE.test(subject)) return subject;
  return subject.replace(/(?<!\d)\d{4,8}(?!\d)/g, '•••');
}

module.exports = {
  MAX_TEXT, MAX_SUMMARY, MAX_ITEMS,
  str, bool, int, date, obj, arr, req, desc,
  ValidationError, validate, toJsonSchema, plainText, stripUrls, maskCodes,
};
