'use strict';
// Renders /api/dashboard as pages behind a sidebar with hash routing (#overview, #updates, ...),
// following coolguy1333/homelab-status. Every stored value goes through textContent, never innerHTML.
(() => {
  const REFRESH_MS = 60e3;
  const VIEWS = ['overview', 'updates', 'email', 'news', 'alerts', 'clients'];
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const state = { data: null, error: '' };

  // ---------------------------------------------------------------- DOM helpers

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  }

  const pad = n => String(n).padStart(2, '0');
  function time(iso) {
    if (!iso) return '';
    const d = new Date(iso), now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    if (d.toDateString() === now.toDateString()) return hm;
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${hm}`;
  }
  function ago(iso) {
    if (!iso) return 'never';
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  // A link only for a well-formed https:// URL (the server already sends null otherwise).
  const httpsUrl = u => {
    if (typeof u !== 'string' || !/^https:\/\//i.test(u)) return null;
    try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch { return null; }
  };

  const DOT = { ok: 'up', warn: 'pending', down: 'down', info: 'info' };
  const dot = (status, inline = false) => el('span', { class: `dot ${DOT[status] || ''}${inline ? ' inline' : ''}`, title: status, 'aria-label': status });
  const PILL = { ok: 'ok', warn: 'warn', down: 'bad', critical: 'bad', info: 'info' };
  const pill = (status, text) => el('span', { class: `pill ${PILL[status] || ''}`, text: text || status });

  const pageHead = (title, sub) => el('div', { class: 'page-head' }, el('div', null, el('h2', { text: title }), sub ? el('p', { class: 'muted', text: sub }) : null));
  const empty = text => el('div', { class: 'card empty', text });
  const kpi = (k, v, s, cls, href) => el(href ? 'a' : 'div', { class: `kpi ${cls || ''}`, href },
    el('div', { class: 'kpi-k', text: k }), el('div', { class: `kpi-v${typeof v === 'string' ? ' txt' : ''}`, text: String(v) }), s ? el('div', { class: 'kpi-s', text: s }) : null);

  // Table with header labels and rows of cells (strings or nodes; {wrap: true, v} for wrapping text).
  function table(heads, rows) {
    return el('div', { class: 'table-wrap' }, el('table', { class: 'ctable' },
      el('thead', null, el('tr', null, heads.map(h => el('th', { text: h })))),
      el('tbody', null, rows.map(r => el('tr', null, r.map(c => {
        if (c && typeof c === 'object' && !(c instanceof Node)) return el('td', { class: c.cls || (c.wrap ? 'wrap' : null) }, c.v instanceof Node ? c.v : String(c.v ?? ''));
        return el('td', null, c instanceof Node ? c : String(c ?? ''));
      })))),
    ));
  }
  const tableCard = (title, sub, heads, rows, cls = '') => el('div', { class: `card table-card ${cls}` },
    title ? el('div', { class: 'card-head' }, el('h3', { text: title }), sub ? el('span', { class: 'muted small', text: sub }) : null) : null,
    table(heads, rows));

  const itemsTable = items => table(['Name', 'State', 'Detail'], items.map(i => [
    i.name, el('span', null, dot(i.state, true), i.state || ''), { wrap: true, v: i.detail || '' },
  ]));

  // ---------------------------------------------------------------- pages

  function viewOverview(d) {
    const o = d.overview;
    const out = [pageHead('Overview', 'Everything here comes from Claude through the MCP connector.')];
    // Homelab: "All OK" when no alert is open, otherwise the open alerts, newest first.
    const hl = o.homelab;
    if (hl.ok) {
      out.push(el('div', { class: 'card attention ok homelab' }, el('span', { class: 'att-ok', text: '✓' }),
        el('div', null, el('h3', { text: 'Homelab' }), el('strong', { text: 'All OK' }))));
    } else {
      const cls = { critical: 'err', warn: 'warn', info: 'info' };
      const ico = { critical: '●', warn: '▲', info: 'i' };
      out.push(el('div', { class: 'card attention homelab' },
        el('div', { class: 'att-head' }, el('h3', { text: 'Homelab' }), el('a', { href: '#alerts', class: 'small', text: `${hl.alerts.length} open alert${hl.alerts.length === 1 ? '' : 's'}` })),
        el('ul', { class: 'att-list' }, hl.alerts.map(a => el('li', { class: `att ${cls[a.severity]}` },
          el('span', { class: 'att-ico', text: ico[a.severity], title: a.severity }),
          el('div', null, el('strong', { text: a.title }), a.detail ? el('span', { class: 'muted', text: ` – ${a.detail}` }) : null),
          el('time', { text: `since ${time(a.since)}` }),
        )))));
    }
    if (o.checkin.stale) {
      out.push(el('div', { class: 'overall warn', role: 'status' }, el('span', { class: 'overall-dot' }),
        el('div', { class: 'overall-title', text: o.checkin.since ? `No check-in from Claude since ${time(o.checkin.since)} (${ago(o.checkin.since)})` : 'No check-in from Claude yet' })));
    }
    const u = o.latest;
    out.push(u ? el('div', { class: 'card happening' },
      el('div', { class: 'muted small', text: "What's happening" }),
      el('div', { class: 'happening-head' }, dot(u.status), el('h3', { text: u.title }), pill(u.status)),
      u.summary ? el('p', { class: 'pre-line', text: u.summary }) : null,
      u.items && u.items.length ? itemsTable(u.items) : null,
      el('div', { class: 'muted small', text: `from Claude, ${ago(u.at)}` }),
    ) : empty('No daily update from Claude yet.'));
    const s = o.stats;
    out.push(el('div', { class: 'kpis' },
      kpi('Open alerts', s.open_alerts, null, s.open_alerts ? (d.badges.alerts.cls === 'bad' ? 'bad' : 'warn') : 'ok', '#alerts'),
      kpi('Need to Read', s.need_to_read, null, '', '#email'),
      kpi('News, last 24 h', s.news_24h, null, '', '#news'),
    ));
    return out;
  }

  function viewUpdates(d) {
    return [
      pageHead('Updates', 'Daily updates from Claude, newest first.'),
      d.updates.length ? d.updates.map(u => el('article', { class: 'card update' },
        el('div', { class: 'update-head' }, dot(u.status), el('h3', { text: u.title }), el('span', { class: 'muted small', text: `${time(u.at)} · ${ago(u.at)}` })),
        u.summary ? el('p', { class: 'pre-line', text: u.summary }) : null,
        u.items && u.items.length ? itemsTable(u.items) : null,
      )) : empty('No daily updates yet.'),
    ];
  }

  const mailRows = list => list.map(m => [time(m.received_at), { wrap: true, v: m.sender }, { wrap: true, v: m.subject || '(no subject)' }, m.label || 'Other']);
  function viewEmail(d) {
    const e = d.email;
    const out = [
      pageHead('Email', 'Need to Read stays until Claude clears it; the rest is the last 24 hours.'),
      el('div', { class: 'kpis' }, kpi('Emails, last 24 h', e.count_24h), kpi('Need to Read', e.need_to_read.length, null, e.need_to_read.length ? 'warn' : '')),
    ];
    const heads = ['Time', 'Sender', 'Subject', 'Label'];
    if (e.need_to_read.length) out.push(tableCard('Need to Read', null, heads, mailRows(e.need_to_read), 'ct-mail'));
    for (const g of e.labels) out.push(tableCard(g.label, `${g.items.length}`, heads, mailRows(g.items), 'ct-mail ct-grouped'));
    if (!e.need_to_read.length && !e.labels.length) out.push(empty('No email in the last 24 hours.'));
    return out;
  }

  function viewNews(d) {
    if (!d.news.length) return [pageHead('News'), empty('No news yet.')];
    return [
      pageHead('News', 'Newest first, grouped by topic.'),
      d.news.map(t => el('div', { class: 'card pad' },
        el('div', { class: 'card-head' }, el('h3', { text: t.topic }), el('span', { class: 'muted small', text: `${t.items.length}` })),
        el('ul', { class: 'news-list' }, t.items.map(n => {
          const href = httpsUrl(n.link);
          return el('li', null,
            href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: n.headline }) : el('span', { class: 'headline', text: n.headline }),
            el('div', { class: 'muted small', text: [n.source, `${time(n.at)}`].filter(Boolean).join(' · ') }),
            n.summary ? el('p', { class: 'pre-line', text: n.summary }) : null,
          );
        })),
      )),
    ];
  }

  function viewAlerts(d) {
    const a = d.alerts;
    return [
      pageHead('Alerts', 'Open alerts first, most severe first; then alerts resolved in the last 30 days.'),
      a.open.length
        ? tableCard('Open', `${a.open.length}`, ['Severity', 'Title', 'Detail', 'Since'], a.open.map(x => [pill(x.severity), { wrap: true, v: x.title }, { wrap: true, v: x.detail }, time(x.since)]))
        : el('div', { class: 'card attention ok' }, el('span', { class: 'att-ok', text: '✓' }), el('strong', { text: 'No open alerts' })),
      a.resolved.length
        ? tableCard('Resolved, last 30 days', `${a.resolved.length}`, ['Severity', 'Title', 'Detail', 'Since', 'Resolved'], a.resolved.map(x => [pill(x.severity), { wrap: true, v: x.title }, { wrap: true, v: x.detail }, time(x.since), time(x.resolved_at)]))
        : null,
    ];
  }

  function viewClients(d) {
    return [
      pageHead('Clients', 'MCP clients you approved, and your Cloudflare Access session.'),
      el('div', { class: 'card pad signed-in' },
        el('div', null, el('div', { class: 'muted small', text: 'Signed in as' }), el('strong', { text: d.user })),
        el('a', { class: 'btn', href: '/cdn-cgi/access/logout', text: 'Sign out' })),
      d.clients.length
        ? tableCard('Connected clients', `${d.clients.length}`, ['Name', 'Sends back to', 'Connected', 'Last used', ''], d.clients.map(c => [
          { wrap: true, v: c.name }, c.redirect_host, time(c.approved_at), ago(c.last_used_at),
          { cls: 'row-actions', v: el('button', { class: 'btn small danger', type: 'button', text: 'Revoke', on: { click: ev => revoke(c, ev.currentTarget) } }) },
        ]))
        : empty('No connected clients.'),
    ];
  }

  async function revoke(c, btn) {
    if (!confirm(`Revoke ${c.name}? It will have to be connected and approved again.`)) return;
    btn.disabled = true;
    try {
      const r = await fetch('/api/clients/revoke', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: c.client_id }), credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      load();
    } catch (err) {
      btn.disabled = false;
      alert(`Could not revoke: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- navigation & render

  const currentView = () => {
    const v = (location.hash || '').replace(/^#\/?/, '');
    return VIEWS.includes(v) ? v : 'overview';
  };

  function badges(d) {
    for (const [k, b] of Object.entries(d.badges)) {
      const node = $(`[data-badge="${k}"]`);
      if (node) { node.textContent = b.n ? String(b.n) : ''; node.className = `nb ${b.n ? b.cls : ''}`; }
    }
    const open = d.alerts.open.length;
    const critical = d.badges.overview.n;
    const hs = $('#headStatus');
    hs.hidden = false;
    hs.className = `head-status ${critical ? 'bad' : open ? 'warn' : 'ok'}`;
    hs.textContent = critical ? `${critical} critical` : open ? `${open} alert${open > 1 ? 's' : ''}` : 'all good';
    document.title = `${critical ? `(${critical}) ` : ''}${d.title}`;
  }

  const PAGES = { overview: viewOverview, updates: viewUpdates, email: viewEmail, news: viewNews, alerts: viewAlerts, clients: viewClients };
  function render() {
    const view = currentView();
    $$('.view').forEach(v => { v.hidden = v.dataset.view !== view; });
    $$('#sidenav a').forEach(a => {
      const on = a.dataset.view === view;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    // Under 900 px the nav is a scrolling tab bar: keep the current page's tab in view.
    const active = $('#sidenav a.active');
    if (active && matchMedia('(max-width: 900px)').matches) active.scrollIntoView({ block: 'nearest', inline: 'center' });
    const err = $('#error');
    err.hidden = !state.error;
    err.textContent = state.error;
    const d = state.data;
    const target = $(`#v-${view}`);
    if (!d) { target.replaceChildren(empty(state.error ? 'Could not load the dashboard.' : 'Loading…')); return; }
    badges(d);
    $('#siteTitle').textContent = d.title;
    $('#updated').textContent = `updated ${time(d.now)}`;
    target.replaceChildren(...PAGES[view](d).flat().filter(Boolean));
  }

  async function load() {
    try {
      const r = await fetch('/api/dashboard', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 403 || r.redirected) throw new Error('Your session has expired. Reload the page to sign in again.');
      if (!r.ok) throw new Error(`Could not load the dashboard (HTTP ${r.status}).`);
      state.data = await r.json();
      state.error = '';
    } catch (err) {
      state.error = err.message || 'Could not load the dashboard.';
    }
    render();
  }

  window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });

  // ---------------------------------------------------------------- theme (same as homelab-status)
  function applyTheme(t) {
    if (t) document.documentElement.dataset.theme = t;
    else delete document.documentElement.dataset.theme;
  }
  try { applyTheme(localStorage.getItem('dh-theme')); } catch { /* storage unavailable */ }
  $('#themeBtn').addEventListener('click', () => {
    const dark = document.documentElement.dataset.theme
      ? document.documentElement.dataset.theme === 'dark'
      : matchMedia('(prefers-color-scheme: dark)').matches;
    const next = dark ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem('dh-theme', next); } catch { /* ignore */ }
  });

  // The sidebar sticks right under the header, so it needs the header's real height.
  const setTopbarHeight = () => document.documentElement.style.setProperty('--topbar-h', `${$('.topbar').offsetHeight}px`);
  setTopbarHeight();
  if (window.ResizeObserver) new ResizeObserver(setTopbarHeight).observe($('.topbar'));

  render();
  load();
  setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
})();
