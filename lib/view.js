'use strict';
// Small pure functions behind the page: the stale check-in banner, the sidebar badges and safe links.
// No I/O, no clock of their own: everything comes in as arguments, so they are easy to test.

const STALE_AFTER = 2 * 3600e3; // no update from Claude for this long -> warning banner

// { stale, since }: stale when there is no update at all, or the newest is older than maxAge.
function staleCheck(latestAt, now, maxAge = STALE_AFTER) {
  const t = latestAt ? Date.parse(latestAt) : NaN;
  if (!Number.isFinite(t)) return { stale: true, since: null };
  return { stale: now - t > maxAge, since: latestAt };
}

// Sidebar badges: { n, cls } per page. n = 0 means the badge is hidden.
//   overview: open critical alerts (red)
//   alerts:   open alerts (red if any is critical, amber otherwise)
//   email:    Need to Read (accent colour)
function badgeCounts({ openAlerts = [], needToRead = 0 }) {
  const critical = openAlerts.filter(a => a.severity === 'critical').length;
  return {
    overview: { n: critical, cls: 'bad' },
    alerts: { n: openAlerts.length, cls: critical ? 'bad' : 'warn' },
    email: { n: needToRead, cls: 'new' },
  };
}

// The Overview's Homelab card: "All OK" when no alert is open, otherwise the open alerts, newest first.
function homelabCard(openAlerts = []) {
  const alerts = [...openAlerts].sort((a, b) => (a.since < b.since ? 1 : a.since > b.since ? -1 : 0));
  return { ok: alerts.length === 0, alerts };
}

// A news URL becomes a link only if it is a well-formed https:// URL; otherwise null (plain text).
function httpsLink(url) {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname ? u.href : null;
  } catch { return null; }
}

module.exports = { STALE_AFTER, staleCheck, badgeCounts, homelabCard, httpsLink };
