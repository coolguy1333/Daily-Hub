'use strict';
// The app's own site checks: every 60 s, 7 days of results kept in sites.json.
const HOUR = 3600e3;
const KEEP = 7 * 24 * HOUR;
const INTERVAL = 60e3;
const TIMEOUT = 10e3;
const DOWN_AFTER = 2;        // failed checks in a row before a site counts as down (one blip is ignored)
const RESTART_SLACK_S = 30; // uptime this much lower than expected means the site restarted
const MAX_EVENTS = 50;
const EVENTS_SHOWN = 8;

function duration(ms) {
  const m = Math.max(1, Math.round(ms / 60e3));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

const SITES = [
  { id: 'webmanager', name: 'WebManager', url: 'https://webmgr.dev/healthz' },
  { id: 'homelab', name: 'Homelab Status', url: 'https://upt.webmgr.dev/api/health', details: true },
];

class SiteChecker {
  constructor(store, { fetch = globalThis.fetch, now = Date.now, version = '' } = {}) {
    this.store = store;
    this.fetch = fetch;
    this.now = now;
    this.ua = `daily-hub/${version}`;
    this.timer = null;
    for (const s of SITES) {
      const h = store.sites[s.id];
      if (!h || !Array.isArray(h.results)) store.sites[s.id] = { results: [], info: null };
      const x = store.sites[s.id];
      if (!Array.isArray(x.events)) x.events = [];
      if (!('state' in x)) Object.assign(x, { state: null, since: null, fails: 0, failSince: null });
    }
  }

  async checkOne(site) {
    const start = this.now();
    const r = { t: start, ok: false, ms: null, code: null, err: null };
    let info = null;
    try {
      const res = await this.fetch(site.url, { signal: AbortSignal.timeout(TIMEOUT), headers: { 'user-agent': this.ua, accept: 'application/json' }, redirect: 'manual' });
      r.code = res.status;
      const text = (await res.text()).slice(0, 10000);
      r.ms = Math.max(0, this.now() - start);
      let body = null;
      try { body = JSON.parse(text); } catch { /* not JSON */ }
      r.ok = res.status === 200 && Boolean(body) && body.status === 'ok';
      if (!r.ok) r.err = res.status !== 200 ? `HTTP ${res.status}` : 'unexpected response';
      if (site.details && body && typeof body === 'object') {
        info = {
          version: typeof body.version === 'string' ? body.version.slice(0, 40) : null,
          uptime: Number.isFinite(body.uptime) ? Math.max(0, Math.round(body.uptime)) : null,
        };
      }
    } catch (err) {
      r.err = err.name === 'TimeoutError' ? 'timeout' : 'unreachable';
    }
    const h = this.store.sites[site.id];
    h.results.push(r);
    const cut = this.now() - KEEP;
    while (h.results.length && h.results[0].t < cut) h.results.shift();
    this.track(h, r, info);
    if (info) h.info = { ...info, t: r.t };
    while (h.events.length && (h.events[0].t < cut || h.events.length > MAX_EVENTS)) h.events.shift();
    this.store.sitesDirty = true;
    return r;
  }

  // Turns check results into the important things: down, back up, new version, restart.
  track(h, r, info) {
    const event = (kind, status, title, detail = '') => h.events.push({ t: r.t, kind, status, title, detail });
    if (r.ok) {
      if (h.state === 'down') event('up', 'ok', `Back up after ${duration(r.t - h.since)}`);
      if (h.state !== 'up') { h.state = 'up'; h.since = r.t; }
      h.fails = 0;
      h.failSince = null;
    } else {
      if (!h.fails) h.failSince = r.t;
      h.fails++;
      if (h.fails >= DOWN_AFTER && h.state !== 'down') {
        h.state = 'down';
        h.since = h.failSince;
        event('down', 'down', `Down: ${r.err || 'check failed'}`);
      }
    }
    const prev = h.info;
    if (r.ok && info && prev) {
      if (info.version && prev.version && info.version !== prev.version) {
        event('version', 'info', `Updated to v${info.version}`, `was v${prev.version}`);
      } else if (info.uptime !== null && prev.uptime !== null && prev.t) {
        const expected = prev.uptime + (r.t - prev.t) / 1000;
        if (info.uptime + RESTART_SLACK_S < expected) event('restart', 'warn', 'Restarted', `up ${duration(info.uptime * 1000)}`);
      }
    }
  }

  // Compact per-site state for get_state.
  summary() {
    return SITES.map(s => {
      const h = this.store.sites[s.id];
      return { id: s.id, state: h.state || 'pending', since: h.since ? new Date(h.since).toISOString() : null };
    });
  }

  checkAll() { return Promise.all(SITES.map(s => this.checkOne(s))); }

  start() {
    const run = () => this.checkAll().catch(err => console.error(`[sites] ${err.message}`));
    setTimeout(run, 2000).unref();
    this.timer = setInterval(run, INTERVAL);
    this.timer.unref();
    this.saver = setInterval(() => this.store.saveSites(), 5 * 60e3);
    this.saver.unref();
  }

  stop() { clearInterval(this.timer); clearInterval(this.saver); this.store.saveSites(true); }

  view() {
    const now = this.now();
    return SITES.map(s => {
      const h = this.store.sites[s.id];
      const last = h.results[h.results.length - 1] || null;
      // 24 hourly buckets, oldest first: share of successful checks (null = no data).
      const bars = [];
      for (let i = 23; i >= 0; i--) {
        const a = now - (i + 1) * HOUR, b = now - i * HOUR;
        let n = 0, up = 0;
        for (const r of h.results) if (r.t > a && r.t <= b) { n++; if (r.ok) up++; }
        bars.push({ t: new Date(b).toISOString(), pct: n ? Math.round((up / n) * 1000) / 10 : null });
      }
      const week = h.results;
      const upWeek = week.length ? Math.round((week.filter(r => r.ok).length / week.length) * 1000) / 10 : null;
      return {
        id: s.id, name: s.name, host: new URL(s.url).host,
        state: last ? (last.ok ? 'up' : 'down') : 'pending',
        ms: last ? last.ms : null,
        checked_at: last ? new Date(last.t).toISOString() : null,
        error: last && !last.ok ? last.err : null,
        uptime_7d: upWeek,
        since: h.since ? new Date(h.since).toISOString() : null,
        events: h.events.slice(-EVENTS_SHOWN).reverse().map(e => ({ at: new Date(e.t).toISOString(), status: e.status, title: e.title, detail: e.detail, source: 'check' })),
        info: s.details && h.info ? { version: h.info.version, uptime: h.info.uptime } : null,
        bars,
      };
    });
  }
}

module.exports = { SiteChecker, SITES };
