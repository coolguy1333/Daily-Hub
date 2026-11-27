'use strict';
// /api/dashboard (one call with every page's data) and the pure functions behind the page.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const h = require('./helpers');
const { staleCheck, badgeCounts, homelabCard, httpsLink, STALE_AFTER } = require('../lib/view');

const HOUR = 3600e3;
const PAGES = ['overview', 'updates', 'email', 'news', 'alerts', 'clients'];

test('staleCheck: the banner turns on after 2 hours without an update', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const at = ms => new Date(now - ms).toISOString();
  assert.equal(STALE_AFTER, 2 * HOUR);
  assert.deepEqual(staleCheck(at(5 * 60e3), now), { stale: false, since: at(5 * 60e3) });
  assert.equal(staleCheck(at(2 * HOUR), now).stale, false, 'exactly 2 hours is not yet stale');
  assert.equal(staleCheck(at(2 * HOUR + 1000), now).stale, true);
  assert.deepEqual(staleCheck(null, now), { stale: true, since: null }, 'no update at all');
  assert.equal(staleCheck('garbage', now).stale, true);
});

test('badgeCounts: critical alerts, open alerts, Need to Read; no network or sites badges', () => {
  const alert = severity => ({ severity });
  let b = badgeCounts({ openAlerts: [alert('critical'), alert('warn'), alert('critical'), alert('info')], needToRead: 4 });
  assert.deepEqual(b, {
    overview: { n: 2, cls: 'bad' },
    alerts: { n: 4, cls: 'bad' },
    email: { n: 4, cls: 'new' },
  });
  b = badgeCounts({ openAlerts: [alert('warn'), alert('info')], needToRead: 0 });
  assert.deepEqual(b.alerts, { n: 2, cls: 'warn' }, 'amber when nothing is critical');
  assert.equal(b.overview.n, 0);
  assert.equal(b.email.n, 0);
});

test('homelabCard: "All OK" with no open alert, otherwise open alerts newest first', () => {
  assert.deepEqual(homelabCard([]), { ok: true, alerts: [] });
  const a = (title, since, severity = 'warn') => ({ severity, title, detail: '', since, resolved_at: null });
  const card = homelabCard([a('old critical', '2026-11-27T08:00:00.000Z', 'critical'), a('newest', '2026-11-27T11:00:00.000Z'), a('middle', '2026-11-27T10:00:00.000Z', 'info')]);
  assert.equal(card.ok, false);
  assert.deepEqual(card.alerts.map(x => x.title), ['newest', 'middle', 'old critical'], 'newest first, not by severity');
});

test('httpsLink: only well-formed https:// URLs become links', () => {
  assert.equal(httpsLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  for (const u of ['http://example.com', 'javascript:alert(1)', ' https://example.com', 'HTTPS:/x', 'https://', 'ftp://x', 'data:text/html,x', '', null, 42]) {
    assert.equal(httpsLink(u), null, String(u));
  }
});

test('/api/dashboard: Homelab card, daily updates only, no network or sites', async () => {
  const ctx = await h.startApp();
  try {
    const iso = ms => new Date(ctx.clock.now() - ms).toISOString();
    const hub = ctx.app.hub;
    const dash = async () => (await fetch(`${ctx.base}/api/dashboard`, { headers: h.accessHeaders(ctx) })).json();

    // Nothing open: All OK.
    let d = await dash();
    assert.deepEqual(d.overview.homelab, { ok: true, alerts: [] });
    assert.equal(d.overview.latest, null);
    assert.equal(d.overview.checkin.stale, true);

    hub.publish({
      update: { kind: 'daily', status: 'warn', title: 'Daily summary', summary: 'One host warm.', items: [{ name: 'pve1', state: 'warn', detail: '81 °C' }] },
      news: [
        { topic: 'Tech', headline: 'Safe', url: 'https://example.com/safe' },
        { topic: 'Tech', headline: 'Plain http', url: 'http://example.com/plain' },
        { topic: 'Tech', headline: 'Script', url: 'javascript:alert(1)' },
      ],
      emails: [
        { id: 'a', received_at: iso(10 * 60e3), sender: 'Bank', subject: 'Statement', label: 'Finance', need_to_read: true },
        { id: 'b', received_at: iso(20 * 60e3), sender: 'Shop', subject: 'Shipped', label: 'Orders' },
      ],
      alerts: { raise: [{ key: 'k1', severity: 'critical', title: 'Backup failed' }, { key: 'k3', severity: 'info', title: 'FYI' }] },
    });
    hub.resolveAlert({ key: 'k3' });
    ctx.clock.advance(60e3);
    hub.publish({ alerts: { raise: [{ key: 'k2', severity: 'warn', title: 'Disk 85%', detail: 'pve2' }] } });
    ctx.clock.advance(60e3);
    // Hourly and note updates are accepted but not shown; they still count as a check-in.
    hub.publish({ update: { kind: 'hourly', status: 'ok', title: 'Hourly check' } });
    hub.publish({ update: { kind: 'note', status: 'ok', title: 'A note' } });

    d = await dash();
    assert.deepEqual(Object.keys(d).sort(), ['alerts', 'badges', 'clients', 'email', 'news', 'now', 'overview', 'title', 'updates', 'user']);
    for (const gone of ['sites', 'site_notes', 'network']) assert.equal(gone in d, false, gone);

    // Overview: Homelab card with open alerts newest first, the newest daily update, three tiles.
    assert.equal(d.overview.homelab.ok, false);
    assert.deepEqual(d.overview.homelab.alerts.map(a => [a.title, a.severity]), [['Disk 85%', 'warn'], ['Backup failed', 'critical']]);
    assert.equal(d.overview.homelab.alerts[0].detail, 'pve2');
    assert.equal(d.overview.latest.title, 'Daily summary');
    assert.equal(d.overview.checkin.stale, false);
    assert.equal(d.overview.checkin.since, d.now, 'the hourly update counts as a check-in');
    assert.deepEqual(d.overview.stats, { open_alerts: 2, need_to_read: 1, news_24h: 3 });

    // Updates: only daily.
    assert.deepEqual(d.updates.map(u => [u.kind, u.title]), [['daily', 'Daily summary']]);
    assert.equal(hub.data.updates.length, 3, 'other kinds are still stored');

    // News: a link only for https://
    const links = Object.fromEntries(d.news[0].items.map(n => [n.headline, n.link]));
    assert.deepEqual(links, { Safe: 'https://example.com/safe', 'Plain http': null, Script: null });

    // Alerts page and badges.
    assert.deepEqual(d.alerts.open.map(a => a.title), ['Backup failed', 'Disk 85%'], 'Alerts page: most severe first');
    assert.deepEqual(d.alerts.resolved.map(a => a.title), ['FYI']);
    assert.deepEqual(d.badges, { overview: { n: 1, cls: 'bad' }, alerts: { n: 2, cls: 'bad' }, email: { n: 1, cls: 'new' } });

    // Everything resolved: All OK again.
    hub.resolveAlert({ key: 'k1' });
    hub.resolveAlert({ key: 'k2' });
    d = await dash();
    assert.deepEqual(d.overview.homelab, { ok: true, alerts: [] });

    // The stale banner turns on 2 hours after the newest update of any kind.
    ctx.clock.advance(2 * HOUR + 60e3);
    d = await dash();
    assert.equal(d.overview.checkin.stale, true);
  } finally { await ctx.close(); }
});

test('/api/dashboard keeps the Access check', async () => {
  const ctx = await h.startApp();
  try {
    assert.equal((await fetch(`${ctx.base}/api/dashboard`)).status, 403);
    assert.equal((await fetch(`${ctx.base}/api/dashboard`, { headers: { 'cf-access-jwt-assertion': ctx.jwt({ email: 'stranger@example.com' }) } })).status, 403);
  } finally { await ctx.close(); }
});

test('page: six pages, no Network or Sites, Homelab card, links only for https://, textContent only', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.doesNotMatch(js, /\.innerHTML\s*=|insertAdjacentHTML|outerHTML\s*=|document\.write/);
  const src = js.match(/const httpsUrl = u => \{[\s\S]*?\n  \};/)[0];
  const httpsUrl = new Function(`${src}; return httpsUrl;`)();
  assert.equal(httpsUrl('https://example.com/x'), 'https://example.com/x');
  for (const u of ['http://example.com', 'javascript:alert(1)', null, 'https://']) assert.equal(httpsUrl(u), null, String(u));
  assert.match(js, /href \? el\('a', \{ href, target: '_blank', rel: 'noopener noreferrer'/);
  for (const v of PAGES) {
    assert.ok(html.includes(`href="#${v}" data-view="${v}"`), `nav ${v}`);
    assert.ok(html.includes(`<section class="view" data-view="${v}" hidden><div id="v-${v}"></div></section>`), `view ${v}`);
  }
  for (const gone of ['network', 'sites']) {
    assert.ok(!html.includes(`#${gone}`) && !html.includes(`data-view="${gone}"`), `no ${gone} page`);
    assert.doesNotMatch(js, new RegExp(`view${gone[0].toUpperCase()}${gone.slice(1)}\\b`), `no ${gone} view`);
  }
  assert.ok(!js.includes('Network down or warn'), 'no network KPI');
  assert.match(js, /el\('h3', \{ text: 'Homelab' \}\), el\('strong', \{ text: 'All OK' \}\)/);
  assert.match(js, /const VIEWS = \['overview', 'updates', 'email', 'news', 'alerts', 'clients'\];/);
  assert.doesNotMatch(html, /<script>|<style|\sstyle=|\son\w+=/i, 'no inline scripts, styles or handlers');
});
