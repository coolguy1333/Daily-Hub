'use strict';
// The data model: what Claude can publish through the MCP tools, and what the page shows.
const crypto = require('crypto');
const V = require('./validate');
const { staleCheck, badgeCounts, httpsLink, homelabCard } = require('./view');

const { str, bool, int, date, obj, arr, req, desc, MAX_SUMMARY, MAX_ITEMS } = V;

const DAY = 24 * 3600e3;
const ENTRY_RETENTION = 30 * DAY;
const CAPS = { updates: 2000, news: 3000, emails: 5000, alerts: 1000 };
const STATES = ['ok', 'warn', 'down'];
const SEVERITIES = ['critical', 'warn', 'info'];
const SEVERITY_RANK = { critical: 0, warn: 1, info: 2 };
const SECTIONS = ['updates', 'news', 'emails', 'alerts'];
const SHOWN_KIND = 'daily'; // the page shows only daily updates; other kinds are accepted but hidden

// ---------------------------------------------------------------- schemas

const S = {};
S.updateItem = obj({ name: req(str()), state: str(), detail: str() });
S.update = obj({
  kind: req(desc(str(10, { enum: ['daily', 'hourly', 'note'] }), 'Only daily is shown on the page.')),
  status: req(str(10, { enum: STATES })),
  title: req(str()),
  summary: desc(str(MAX_SUMMARY, { multiline: true }), 'Plain text.'),
  items: arr(S.updateItem),
});
S.newsItem = obj({
  topic: req(str()), source: str(), headline: req(str()),
  summary: str(MAX_SUMMARY, { multiline: true }), url: req(str()),
});
S.news = desc(arr(S.newsItem), 'Deduplicated by url.');
S.email = obj({
  id: req(desc(str(200, { pattern: /^[A-Za-z0-9_.:@-]+$/ }), 'Gmail message id (dedupe only).')),
  received_at: req(date()),
  sender: req(str()),
  subject: str(),
  label: str(),
  need_to_read: bool(),
});
S.emails = desc(arr(S.email), 'Upserted by id.');
S.alert = obj({
  key: req(str(200)),
  severity: req(str(10, { enum: SEVERITIES })),
  title: req(str()),
  detail: str(),
});
S.alerts = obj({ raise: arr(S.alert), resolve: desc(arr(req(str(200))), 'Alert keys.') });
S.publish = obj({ update: S.update, news: S.news, emails: S.emails, alerts: S.alerts });
S.resolve = obj({ key: req(str(200)) });
S.setNeedToRead = obj({ ids: req(arr(req(str(200)))), value: bool({ default: false }) });
S.section = req(str(20, { enum: SECTIONS }));
S.list = obj({ section: S.section, since: date(), limit: desc(int(1, 50), 'Default 20.') });
S.del = obj({ section: S.section, id: req(desc(str(200), 'Entry id (alert key for alerts).')) });
S.empty = obj({});

const newId = prefix => prefix + crypto.randomBytes(6).toString('base64url');
const iso = t => new Date(t).toISOString();
const byDesc = key => (a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0);
const cap = (list, n) => { if (list.length > n) list.splice(0, list.length - n); };

// Only the fields the call sent; defaults for omitted ones are applied to new emails only,
// so republishing an email keeps its stored label, subject and Need to Read flag.
function sanitizeEmail(e) {
  e.sender = V.stripUrls(e.sender) || '(unknown sender)';
  if (e.subject !== undefined) e.subject = V.maskCodes(V.stripUrls(e.subject));
  return e;
}
const EMAIL_DEFAULTS = { subject: '', label: '', need_to_read: false };

class Hub {
  constructor(store, { now = Date.now } = {}) {
    this.store = store;
    this.now = now;
  }

  get data() { return this.store.hub; }

  // ---------------------------------------------------------------- publish

  // Validates every part and item first, then applies everything that passed in one write.
  publish(args) {
    const now = this.now();
    const rejected = [];
    const reject = (part, index, reason) => rejected.push(index === null ? { part, reason } : { part, index, reason });
    let budget = MAX_ITEMS;
    const take = () => budget-- > 0;
    const plan = {};

    if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
    for (const k of Object.keys(args)) if (!Object.hasOwn(S.publish.fields, k)) reject(k, null, 'unknown part');

    // Validate a list of items one by one; bad ones are rejected, the rest kept.
    const items = (part, spec, list) => {
      if (!Array.isArray(list)) { reject(part, null, 'must be an array'); return []; }
      const out = [];
      list.forEach((v, i) => {
        if (!take()) return reject(part, i, `over ${MAX_ITEMS} items per call`);
        try { out.push(V.validate(spec, v, { now })); } catch (err) { reject(part, i, err.message); }
      });
      return out;
    };
    // Validate an object part apart from one list field, which is checked item by item.
    const head = (part, spec, value, listField) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) { reject(part, null, 'must be an object'); return null; }
      const { [listField]: list, ...rest } = value;
      const fields = { ...spec.fields };
      delete fields[listField];
      try {
        const h = V.validate(obj(fields), rest, { now });
        return { h, list };
      } catch (err) { reject(part, null, err.message); return null; }
    };

    if (args.update != null) {
      const r = head('update', S.update, args.update, 'items');
      if (r) {
        r.h.summary = r.h.summary || '';
        r.h.items = r.list == null ? [] : items('update.items', S.updateItem, r.list);
        plan.update = r.h;
      }
    }
    if (args.news != null) plan.news = items('news', S.newsItem, args.news);
    if (args.emails != null) plan.emails = items('emails', S.email, args.emails).map(sanitizeEmail);
    if (args.alerts != null) {
      const a = args.alerts;
      if (!a || typeof a !== 'object' || Array.isArray(a)) reject('alerts', null, 'must be an object');
      else {
        for (const k of Object.keys(a)) if (!Object.hasOwn(S.alerts.fields, k)) reject('alerts', null, `unknown field "${k}"`);
        if (a.raise != null) plan.raise = items('alerts.raise', S.alert, a.raise);
        if (a.resolve != null) plan.resolve = items('alerts.resolve', req(str(200)), a.resolve);
      }
    }

    const added = {}, updated = {};
    const inc = (o, k, n = 1) => { if (n) o[k] = (o[k] || 0) + n; };
    const hasWork = plan.update || plan.news?.length || plan.emails?.length || plan.raise?.length || plan.resolve?.length;
    if (hasWork) {
      this.store.transact(d => {
        const at = iso(now);
        if (plan.update) {
          d.updates.push({ id: newId('u_'), at, ...plan.update });
          cap(d.updates, CAPS.updates);
          inc(added, 'updates');
        }
        if (plan.news) {
          const byUrl = new Map(d.news.map(n => [n.url, n]));
          for (const n of plan.news) {
            const old = byUrl.get(n.url);
            if (old) { Object.assign(old, n); inc(updated, 'news'); }
            else { const e = { id: newId('w_'), at, source: '', summary: '', ...n }; d.news.push(e); byUrl.set(n.url, e); inc(added, 'news'); }
          }
          cap(d.news, CAPS.news);
        }
        if (plan.emails) {
          const byId = new Map(d.emails.map(e => [e.id, e]));
          for (const e of plan.emails) {
            const old = byId.get(e.id);
            if (old) { Object.assign(old, e); inc(updated, 'emails'); }
            else { const x = { ...EMAIL_DEFAULTS, ...e, at }; d.emails.push(x); byId.set(e.id, x); inc(added, 'emails'); }
          }
          d.emails.sort((a, b) => (a.received_at < b.received_at ? -1 : 1));
          cap(d.emails, CAPS.emails);
        }
        for (const a of plan.raise || []) inc(this._raise(d, a, at) === 'added' ? added : updated, 'alerts');
        for (const key of plan.resolve || []) if (this._resolve(d, key, at)) inc(updated, 'resolved');
      });
    }
    return { ok: rejected.length === 0, added, updated, rejected };
  }

  // ---------------------------------------------------------------- alerts

  _raise(d, a, at) {
    const old = d.alerts.find(x => x.key === a.key);
    if (old && !old.resolved_at) {
      Object.assign(old, { severity: a.severity, title: a.title, detail: a.detail || '', updated_at: at });
      return 'updated';
    }
    if (old) d.alerts.splice(d.alerts.indexOf(old), 1);
    d.alerts.push({ key: a.key, severity: a.severity, title: a.title, detail: a.detail || '', since: at, updated_at: at, resolved_at: null });
    cap(d.alerts, CAPS.alerts);
    return 'added';
  }

  _resolve(d, key, at) {
    const a = d.alerts.find(x => x.key === key);
    if (!a || a.resolved_at) return false;
    a.resolved_at = at;
    a.updated_at = at;
    return true;
  }

  raiseAlert(args) {
    const a = V.validate(S.alert, args, { now: this.now() });
    const r = this.store.transact(d => this._raise(d, a, iso(this.now())));
    return { ok: true, key: a.key, result: r };
  }

  resolveAlert(args) {
    const { key } = V.validate(S.resolve, args);
    const a = this.data.alerts.find(x => x.key === key);
    if (!a || a.resolved_at) return { ok: true, key, result: a ? 'already_resolved' : 'not_found' };
    this.store.transact(d => this._resolve(d, key, iso(this.now())));
    return { ok: true, key, result: 'resolved' };
  }

  // ---------------------------------------------------------------- emails

  setNeedToRead(args) {
    const { ids, value } = V.validate(S.setNeedToRead, args);
    const want = new Set(ids);
    const found = this.data.emails.filter(e => want.has(e.id));
    const change = found.filter(e => e.need_to_read !== value).map(e => e.id);
    if (change.length) {
      const set = new Set(change);
      this.store.transact(d => { for (const e of d.emails) if (set.has(e.id)) e.need_to_read = value; });
    }
    return { ok: true, updated: change.length, unchanged: found.length - change.length, not_found: want.size - found.length };
  }

  // ---------------------------------------------------------------- read

  openAlerts() {
    return this.data.alerts.filter(a => !a.resolved_at)
      .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (a.since < b.since ? 1 : -1));
  }

  getState() {
    const d = this.data;
    const u = d.updates[d.updates.length - 1];
    const newest = (list, key) => list.reduce((m, x) => (m === null || x[key] > m ? x[key] : m), null);
    const open = this.openAlerts();
    const ntr = d.emails.filter(e => e.need_to_read).sort(byDesc('received_at'));
    return {
      latest: {
        update: u ? { id: u.id, kind: u.kind, status: u.status, title: u.title, at: u.at } : null,
        news_at: newest(d.news, 'at'),
        email_received_at: newest(d.emails, 'received_at'),
      },
      open_alerts: open.map(a => ({ key: a.key, severity: a.severity, title: a.title, since: a.since })),
      need_to_read: ntr.slice(0, 50).map(e => ({ id: e.id, sender: e.sender, subject: e.subject, received_at: e.received_at })),
      counts: {
        updates: d.updates.length, news: d.news.length,
        emails: d.emails.length, need_to_read: ntr.length, alerts_open: open.length,
      },
    };
  }

  listEntries(args) {
    const { section, since, limit = 20 } = V.validate(S.list, args, { now: this.now() });
    const d = this.data;
    const pick = {
      updates: [d.updates, 'at', u => ({ id: u.id, at: u.at, kind: u.kind, status: u.status, title: u.title })],
      news: [d.news, 'at', n => ({ id: n.id, at: n.at, topic: n.topic, headline: n.headline })],
      emails: [d.emails, 'received_at', e => ({ id: e.id, received_at: e.received_at, sender: e.sender, subject: e.subject, label: e.label, need_to_read: e.need_to_read })],
      alerts: [d.alerts, 'updated_at', a => ({ key: a.key, severity: a.severity, title: a.title, since: a.since, resolved_at: a.resolved_at })],
    }[section];
    const [list, key, view] = pick;
    const rows = list.filter(x => !since || x[key] >= since).sort(byDesc(key));
    return { section, total: rows.length, items: rows.slice(0, limit).map(view), more: rows.length > limit };
  }

  deleteEntry(args) {
    const { section, id } = V.validate(S.del, args);
    const field = { updates: 'updates', news: 'news', emails: 'emails', alerts: 'alerts' }[section];
    const idKey = section === 'alerts' ? 'key' : 'id';
    if (!this.data[field].some(x => x[idKey] === id)) return { ok: true, deleted: 0 };
    this.store.transact(d => { d[field] = d[field].filter(x => x[idKey] !== id); });
    return { ok: true, deleted: 1 };
  }

  // ---------------------------------------------------------------- retention

  // Entries older than 30 days and alerts resolved over 30 days ago.
  retention() {
    const now = this.now();
    const entryCut = iso(now - ENTRY_RETENTION);
    const d = this.data;
    const keep = {
      updates: u => u.at >= entryCut,
      news: n => n.at >= entryCut,
      emails: e => e.received_at >= entryCut,
      alerts: a => !a.resolved_at || a.resolved_at >= entryCut,
    };
    const removed = {};
    for (const [k, f] of Object.entries(keep)) { const n = d[k].filter(x => !f(x)).length; if (n) removed[k] = n; }
    if (Object.keys(removed).length) this.store.transact(x => { for (const [k, f] of Object.entries(keep)) x[k] = x[k].filter(f); });
    return removed;
  }

  // ---------------------------------------------------------------- page

  view() {
    const now = this.now();
    const d = this.data;
    const dayAgo = iso(now - DAY);
    // Need to Read stays until Claude clears it (set_need_to_read); the rest is the last 24 hours.
    const mail = e => ({ received_at: e.received_at, sender: e.sender, subject: e.subject, label: e.label });
    const flagged = d.emails.filter(e => e.need_to_read).sort(byDesc('received_at'));
    const recent = d.emails.filter(e => e.received_at >= dayAgo).sort(byDesc('received_at'));
    const labels = new Map();
    for (const e of recent.filter(e => !e.need_to_read)) {
      const l = e.label || 'Other';
      if (!labels.has(l)) labels.set(l, []);
      labels.get(l).push(mail(e));
    }
    const newsByAge = [...d.news].sort(byDesc('at'));
    const topics = new Map();
    for (const n of newsByAge.slice(0, 100)) {
      if (!topics.has(n.topic)) topics.set(n.topic, []);
      topics.get(n.topic).push({ at: n.at, source: n.source, headline: n.headline, summary: n.summary, link: httpsLink(n.url) });
    }
    // Updates are stored oldest first; reversing before the stable sort puts the later one first on a tie.
    const newestFirst = [...d.updates].reverse().sort(byDesc('at'));
    // Only daily updates are shown; any update (hourly, note, ...) still counts as a check-in from Claude.
    const updates = newestFirst.filter(u => u.kind === SHOWN_KIND).slice(0, 100).map(({ id, ...u }) => u);
    const open = this.openAlerts();
    const alert = a => ({ severity: a.severity, title: a.title, detail: a.detail, since: a.since, resolved_at: a.resolved_at });
    const monthAgo = iso(now - ENTRY_RETENTION);
    return {
      overview: {
        homelab: homelabCard(open.map(alert)),
        latest: updates[0] || null,
        checkin: staleCheck(newestFirst[0] ? newestFirst[0].at : null, now),
        stats: {
          open_alerts: open.length,
          need_to_read: flagged.length,
          news_24h: newsByAge.filter(n => n.at >= dayAgo).length,
        },
      },
      updates,
      email: {
        count_24h: recent.length,
        need_to_read: flagged.map(mail),
        labels: [...labels].map(([label, items]) => ({ label, items })),
      },
      news: [...topics].map(([topic, items]) => ({ topic, items })),
      alerts: {
        open: open.map(alert),
        resolved: d.alerts.filter(a => a.resolved_at && a.resolved_at >= monthAgo).sort(byDesc('resolved_at')).map(alert),
      },
      badges: badgeCounts({ openAlerts: open, needToRead: flagged.length }),
    };
  }
}

module.exports = { Hub, S, SECTIONS, SHOWN_KIND, DAY };
