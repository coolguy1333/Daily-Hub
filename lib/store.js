'use strict';
// JSON-file storage in DATA_DIR (adapted from homelab-status lib/store.js). No database needed:
//   hub.json    - everything Claude publishes: updates, network snapshots, news, emails, alerts, site notes.
//                 One file, so a publish call is written in one atomic rename (one transaction).
//   sites.json  - the app's own site checks (7 days)
//   oauth.json  - OAuth clients and SHA-256 hashes of issued tokens (mode 0600)
const fs = require('fs');
const path = require('path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      const backup = `${file}.corrupt-${Date.now()}`;
      try { fs.renameSync(file, backup); } catch { /* ignore */ }
      console.error(`[store] Could not parse ${path.basename(file)} (${err.message}). Moved to ${path.basename(backup)}.`);
    }
    return fallback;
  }
}

// Like readJson, but the result must be a plain object.
function readObject(file, fallback) {
  const data = readJson(file, fallback);
  return data && typeof data === 'object' && !Array.isArray(data) ? data : fallback;
}

// Write to a temp file, then rename over the real one: readers never see a half-written file.
// Throws on failure so a transaction can be abandoned.
function writeJsonAtomic(file, data, mode = 0o644) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data), { mode });
  fs.renameSync(tmp, file);
}

const emptyHub = () => ({ updates: [], snapshots: [], news: [], emails: [], alerts: [], site_notes: [] });
const emptyOauth = () => ({ clients: {}, access: {}, refresh: {} });

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.files = {
      hub: path.join(dir, 'hub.json'),
      sites: path.join(dir, 'sites.json'),
      oauth: path.join(dir, 'oauth.json'),
    };
    const hub = readObject(this.files.hub, emptyHub());
    this.hub = emptyHub();
    for (const k of Object.keys(this.hub)) if (Array.isArray(hub[k])) this.hub[k] = hub[k];
    this.sites = readObject(this.files.sites, {});
    const oauth = readObject(this.files.oauth, emptyOauth());
    this.oauth = emptyOauth();
    for (const k of Object.keys(this.oauth)) if (oauth[k] && typeof oauth[k] === 'object') this.oauth[k] = oauth[k];
    this.sitesDirty = false;
  }

  // Run `fn` on a copy of the hub data; keep the copy only if it was written to disk.
  // Node runs this synchronously, so no other request sees a half-applied change.
  transact(fn) {
    const next = structuredClone(this.hub);
    const result = fn(next);
    writeJsonAtomic(this.files.hub, next);
    this.hub = next;
    return result;
  }

  saveOauth() {
    try { writeJsonAtomic(this.files.oauth, this.oauth, 0o600); } catch (err) { console.error(`[store] Failed to write oauth.json: ${err.message}`); }
  }

  saveSites(force = false) {
    if (!this.sitesDirty && !force) return;
    try { writeJsonAtomic(this.files.sites, this.sites); this.sitesDirty = false; } catch (err) { console.error(`[store] Failed to write sites.json: ${err.message}`); }
  }
}

module.exports = { Store, readJson, readObject, writeJsonAtomic };
