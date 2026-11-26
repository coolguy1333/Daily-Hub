'use strict';
// The app's own site checks: every 60 s, 7 days of results kept in sites.json.
const HOUR = 3600e3;
const KEEP = 7 * 24 * HOUR;
const INTERVAL = 60e3;
const TIMEOUT = 10e3;

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
    if (info) h.info = { ...info, t: r.t };
    this.store.sitesDirty = true;
    return r;
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
        info: s.details && h.info ? { version: h.info.version, uptime: h.info.uptime } : null,
        bars,
      };
    });
  }
}

module.exports = { SiteChecker, SITES };
