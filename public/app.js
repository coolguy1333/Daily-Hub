'use strict';
// Renders /api/dashboard. Every stored value goes through textContent, never innerHTML.
(() => {
  const $ = id => document.getElementById(id);
  const REFRESH_MS = 60e3;

  function el(tag, attrs, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) e.append(c instanceof Node ? c : String(c));
    return e;
  }
  const fill = (node, ...children) => { node.replaceChildren(...children.flat().filter(Boolean)); };
  const empty = text => el('p', { class: 'muted empty', text });

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
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }
  function duration(sec) {
    if (sec === null || sec === undefined) return '';
    const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  const httpsUrl = u => {
    try { const x = new URL(u); return x.protocol === 'https:' && /^https:\/\//i.test(u) ? x.href : null; } catch { return null; }
  };
  const pill = (state, text) => el('span', { class: `pill ${state}`, text: text || state });

  // ---------------------------------------------------------------- sections

  function renderAlerts(alerts) {
    const box = $('alerts');
    box.hidden = !alerts.length;
    fill(box, alerts.map(a => el('div', { class: `alert ${a.severity}` },
      el('span', { class: 'sev', text: a.severity }),
      el('div', { class: 'alert-body' },
        el('strong', { text: a.title }),
        a.detail ? el('span', { class: 'detail', text: a.detail }) : null,
      ),
      el('span', { class: 'muted when', text: `since ${time(a.since)}` }),
    )));
  }

  function renderSites(sites) {
    fill($('sites'), sites.map(s => {
      const bars = el('div', { class: 'bars', 'aria-label': 'Last 24 hours' }, s.bars.map(b => {
        const cls = b.pct === null ? 'nodata' : b.pct >= 100 ? 'up' : b.pct <= 0 ? 'down' : 'warn';
        return el('span', { class: `bar ${cls}`, title: `${time(b.t)}: ${b.pct === null ? 'no data' : `${b.pct}% up`}` });
      }));
      const meta = [
        s.ms !== null ? `${s.ms} ms` : null,
        `checked ${ago(s.checked_at)}`,
        s.uptime_7d !== null ? `${s.uptime_7d}% 7d` : null,
        s.info && s.info.version ? `v${s.info.version}` : null,
        s.info && s.info.uptime !== null ? `up ${duration(s.info.uptime)}` : null,
        s.error ? s.error : null,
      ].filter(Boolean).join(' · ');
      return el('div', { class: 'site' },
        el('div', { class: 'site-head' },
          pill(s.state === 'up' ? 'ok' : s.state === 'down' ? 'down' : 'nodata', s.state),
          el('strong', { text: s.name }),
          el('span', { class: 'muted', text: s.host }),
        ),
        el('div', { class: 'muted small', text: meta }),
        bars,
        el('div', { class: 'bar-legend muted small' }, el('span', { text: '24h ago' }), el('span', { text: 'now' })),
      );
    }));
  }

  function renderToday(updates) {
    if (!updates.length) return fill($('today'), empty('No updates yet.'));
    fill($('today'), updates.map(u => el('article', { class: 'update' },
      el('div', { class: 'update-head' },
        pill(u.status), el('strong', { text: u.title }),
        el('span', { class: 'muted small', text: `${u.kind} · ${time(u.at)}` }),
      ),
      u.summary ? el('p', { class: 'summary', text: u.summary }) : null,
      u.items && u.items.length ? el('ul', { class: 'items' }, u.items.map(i => el('li', null,
        i.state ? pill(['ok', 'warn', 'down'].includes(i.state) ? i.state : 'nodata', i.state) : null,
        el('span', { text: i.name }),
        i.detail ? el('span', { class: 'muted', text: ` – ${i.detail}` }) : null,
      ))) : null,
    )));
  }

  function renderNetwork(net) {
    $('network-at').textContent = net ? `taken ${time(net.taken_at)} (${ago(net.taken_at)})` : '';
    if (!net) return fill($('network'), empty('No snapshot yet.'));
    const summary = el('div', { class: 'net-counts' },
      ['down', 'warn', 'ok'].map(s => net.counts[s] ? pill(s, `${net.counts[s]} ${s}`) : null));
    fill($('network'), summary, el('div', { class: 'groups' }, net.groups.map(g => el('div', { class: 'group' },
      el('h3', { text: g.group }),
      el('ul', { class: 'board' }, g.items.map(i => el('li', { class: `state-${i.state}` },
        el('span', { class: `dot ${i.state}`, 'aria-label': i.state }),
        el('span', { class: 'name', text: i.name }),
        i.detail ? el('span', { class: 'muted small detail', text: i.detail }) : null,
      ))),
    ))));
  }

  const mailRow = m => el('li', { class: 'mail' },
    el('span', { class: 'muted time', text: time(m.received_at) }),
    el('span', { class: 'sender', text: m.sender }),
    el('span', { class: 'subject', text: m.subject || '(no subject)' }),
    el('span', { class: 'label', text: m.label || 'Other' }),
  );

  function renderEmail(mail) {
    if (!mail.total) return fill($('email-list'), empty('No email in the last 24 hours.'));
    const out = [];
    if (mail.need_to_read.length) {
      out.push(el('div', { class: 'mail-group need' }, el('h3', { text: `Need to Read (${mail.need_to_read.length})` }), el('ul', { class: 'mails' }, mail.need_to_read.map(mailRow))));
    }
    for (const g of mail.labels) out.push(el('div', { class: 'mail-group' }, el('h3', { text: `${g.label} (${g.items.length})` }), el('ul', { class: 'mails' }, g.items.map(mailRow))));
    fill($('email-list'), out);
  }

  function renderNews(news) {
    if (!news.length) return fill($('news'), empty('No news yet.'));
    fill($('news'), news.map(t => el('div', { class: 'topic' },
      el('h3', { text: t.topic }),
      el('ul', { class: 'news' }, t.items.map(n => {
        const href = httpsUrl(n.url);
        const headline = href ? el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: n.headline }) : el('span', { text: n.headline });
        return el('li', null,
          el('div', null, headline),
          el('div', { class: 'muted small', text: [n.source, time(n.at)].filter(Boolean).join(' · ') }),
          n.summary ? el('p', { class: 'summary', text: n.summary }) : null,
        );
      })),
    )));
  }

  function renderClients(clients) {
    if (!clients.length) return fill($('clients'), empty('No connected clients.'));
    fill($('clients'), el('ul', { class: 'clients' }, clients.map(c => {
      const btn = el('button', { class: 'btn small', type: 'button', text: 'Revoke' });
      btn.addEventListener('click', () => revoke(c, btn));
      return el('li', null,
        el('div', null, el('strong', { text: c.name }), el('span', { class: 'muted', text: ` → ${c.redirect_host}` })),
        el('div', { class: 'muted small', text: `connected ${time(c.approved_at)} · last used ${ago(c.last_used_at)}` }),
        btn,
      );
    })));
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

  // ---------------------------------------------------------------- load

  async function load() {
    try {
      const r = await fetch('/api/dashboard', { credentials: 'same-origin', cache: 'no-store' });
      if (r.status === 403 || r.redirected) throw new Error('Your session has expired. Reload the page to sign in again.');
      if (!r.ok) throw new Error(`Could not load the dashboard (HTTP ${r.status}).`);
      const d = await r.json();
      document.title = d.title;
      $('title').textContent = d.title;
      $('email').textContent = d.user;
      $('updated').textContent = `updated ${time(d.now)}`;
      $('error').hidden = true;
      renderAlerts(d.alerts);
      renderSites(d.sites);
      renderToday(d.today);
      renderNetwork(d.network);
      renderEmail(d.email);
      renderNews(d.news);
      renderClients(d.clients);
    } catch (err) {
      $('error').textContent = err.message || 'Could not load the dashboard.';
      $('error').hidden = false;
    }
  }

  load();
  setInterval(load, REFRESH_MS);
})();
