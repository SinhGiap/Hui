'use strict';
// Everything on these pages comes from API Gateway. The Beanstalk tier only ever
// serves the shell, so the API is the one place business rules live.
// ponytail: no framework. Three pages of DOM building does not earn a build step.

const API = window.CONFIG.apiBase;
const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  kids.flat().forEach((k) => k != null && node.append(k));
  return node;
};

const token = {
  get: () => localStorage.getItem('hui.token'),
  set: (t) => localStorage.setItem('hui.token', t),
  clear: () => localStorage.removeItem('hui.token'),
};

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token.get() ? { Authorization: `Bearer ${token.get()}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (res.status === 401) { token.clear(); location.href = '/'; }
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

const money = (amount, currency) => `${Number(amount).toLocaleString()} ${currency}`;
const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');

function scoreCell(score) {
  return el('div', { className: 'score' },
    el('div', { className: 'bar' }, el('i', { style: `width:${Math.max(2, score)}%` })),
    el('span', {}, String(score)));
}

// ------------------------------------------------------------------ chrome
async function mountNav() {
  $('#apihint').textContent = new URL(API).host;
  if (!token.get()) return null;
  try {
    const { user } = await api('/me');
    $('#who').textContent = `${user.name} · reliability ${user.reliability}`;
    $('#nav').hidden = false;
    $('#signout').onclick = () => { token.clear(); location.href = '/'; };
    return user;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ sign in
function initSignIn() {
  if (token.get()) { location.href = '/dashboard'; return; }
  let mode = 'signin';
  const form = $('#authform');
  const err = $('#autherror');

  document.querySelectorAll('.tab[data-mode]').forEach((tab) => {
    tab.onclick = () => {
      mode = tab.dataset.mode;
      document.querySelectorAll('.tab[data-mode]').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.reg-only').forEach((n) => { n.hidden = mode !== 'register'; });
      form.name.required = mode === 'register';
      form.querySelector('.primary').textContent = mode === 'register' ? 'Create account' : 'Sign in';
      err.hidden = true;
    };
  });

  form.onsubmit = async (e) => {
    e.preventDefault();
    err.hidden = true;
    const payload = { email: form.email.value, password: form.password.value };
    if (mode === 'register') payload.name = form.name.value;
    try {
      const out = await api(mode === 'register' ? '/auth/register' : '/auth/login', { method: 'POST', body: payload });
      token.set(out.token);
      location.href = '/dashboard';
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  };
}

// ----------------------------------------------------------------- dashboard
async function initDashboard(user) {
  if (!user) { location.href = '/'; return; }
  $('#scoreline').textContent = `Your reliability score is ${user.reliability} — built from ${user.onTimeCount} on-time of ${user.contribCount} contributions.`;

  const form = $('#creategroup');
  form.startDate.value = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
  $('#newgroup').onclick = () => { form.hidden = !form.hidden; };
  $('#cancelcreate').onclick = () => { form.hidden = true; };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#createerror');
    err.hidden = true;
    try {
      const { group } = await api('/groups', {
        method: 'POST',
        body: {
          name: form.name.value,
          contributionAmount: Number(form.contributionAmount.value),
          currency: form.currency.value.toUpperCase(),
          country: form.country.value.toUpperCase(),
          cycleLengthDays: Number(form.cycleLengthDays.value),
          memberCap: Number(form.memberCap.value),
          startDate: form.startDate.value,
        },
      });
      location.href = `/group/${group.groupId}`;
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  };

  const { groups } = await api('/groups');
  const box = $('#groups');
  box.textContent = '';
  if (!groups.length) {
    box.append(el('p', { className: 'muted' }, 'No circles yet. Start one, then share the link with people you trust.'));
    return;
  }
  for (const g of groups) {
    const state = g.status === 'OPEN'
      ? el('span', { className: 'pill grey' }, `${g.memberCount}/${g.memberCap} joined`)
      : el('span', { className: 'pill' }, g.complete ? 'complete' : `cycle ${g.currentCycle} of ${g.dueDates.length}`);
    box.append(el('a', { className: 'card groupcard', href: `/group/${g.groupId}` },
      el('h3', {}, g.name),
      el('p', { className: 'muted small' }, `${money(g.contributionAmount, g.currency)} every ${g.cycleLengthDays} days · pot ${money(g.contributionAmount * g.memberCount, g.currency)}`),
      state));
  }
}

// --------------------------------------------------------------- group page
async function initGroup(user) {
  if (!user) { location.href = '/'; return; }
  const id = window.GROUP_ID;

  document.querySelectorAll('.tab[data-panel]').forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll('.tab[data-panel]').forEach((t) => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.panel').forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.panel; });
      if (tab.dataset.panel === 'report') loadReport(id);
    };
  });

  await render(id, user);

  $('#joinbtn').onclick = async () => { await api(`/groups/${id}/join`, { method: 'POST' }); location.reload(); };
  $('#startbtn').onclick = async () => { await api(`/groups/${id}/start`, { method: 'POST' }); location.reload(); };
}

async function render(id, user) {
  // Ask for a USD conversion alongside the group's own currency; the API fetches
  // it from the third-party exchange-rate service.
  const d = await api(`/groups/${id}?display=USD`);
  const g = d.group;

  $('#gname').textContent = g.name;
  $('#gsub').textContent = `Organised by ${g.ownerName} · ${money(g.contributionAmount, g.currency)} every ${g.cycleLengthDays} days`
    + (d.converted ? ` (≈ ${money(d.converted.amount, d.converted.currency)})` : '');

  const stats = $('#stats');
  stats.textContent = '';
  const cycleLabel = g.status === 'OPEN' ? 'not started' : g.complete ? 'complete' : `${g.currentCycle} of ${g.dueDates.length}`;
  const nextDue = g.status === 'ACTIVE' && !g.complete ? g.dueDates[g.currentCycle - 1] : null;
  const recipient = nextDue ? d.members.find((m) => m.payoutPosition === g.currentCycle) : null;
  for (const [label, value] of [
    ['Pot per cycle', money(d.pot, g.currency)],
    ['Members', `${g.memberCount} of ${g.memberCap}`],
    ['Cycle', cycleLabel],
    ['Next due', nextDue || '—'],
    ['Paid out to', recipient ? recipient.name : '—'],
  ]) stats.append(el('div', { className: 'stat' }, el('b', {}, value), el('span', {}, label)));

  $('#joinbtn').hidden = d.isMember || g.status !== 'OPEN' || g.memberCount >= g.memberCap;
  $('#startbtn').hidden = !(g.ownerId === user.userId && g.status === 'OPEN' && g.memberCount >= 2);

  const tbody = $('#members');
  tbody.textContent = '';
  for (const m of d.members) {
    tbody.append(el('tr', {},
      el('td', {}, m.payoutPosition ? String(m.payoutPosition) : '—'),
      el('td', {}, m.name + (m.userId === g.ownerId ? ' (organiser)' : '')),
      el('td', {}, scoreCell(m.reliability)),
      el('td', { className: 'muted' }, `${m.onTimeCount} on time of ${m.contribCount}`),
      el('td', {}, m.payoutPosition && g.dueDates.length ? day(g.dueDates[m.payoutPosition - 1]) : '—')));
  }

  renderLedger(d);
  setupPayForm(id, d);
}

function renderLedger(d) {
  const rows = $('#ledger');
  rows.textContent = '';
  const sorted = [...d.contributions].sort((a, b) => a.cycle - b.cycle || a.userName.localeCompare(b.userName));
  if (!sorted.length) {
    rows.append(el('tr', {}, el('td', { colSpan: 7, className: 'muted' }, 'Nothing logged yet.')));
    return;
  }
  for (const c of sorted) {
    rows.append(el('tr', {},
      el('td', {}, String(c.cycle)),
      el('td', {}, c.userName),
      el('td', {}, money(c.amount, c.currency)),
      el('td', { className: 'muted' }, c.dueDate),
      el('td', { className: 'muted' }, day(c.paidAt)),
      el('td', {}, el('span', { className: `pill ${c.onTime ? 'ok' : 'late'}` }, c.onTime ? 'on time' : 'late')),
      el('td', {}, c.evidenceKey && window.CONFIG.cdnDomain
        ? el('a', { href: `https://${window.CONFIG.cdnDomain}/${c.evidenceKey}`, target: '_blank', rel: 'noopener' }, 'view')
        : '—')));
  }
}

function setupPayForm(id, d) {
  const form = $('#payform');
  const g = d.group;
  form.hidden = !(d.isMember && g.status === 'ACTIVE' && !g.complete);
  if (form.hidden) return;

  // Only offer cycles this member has not already paid; the API rejects a repeat
  // anyway, but showing an impossible option is a worse experience than hiding it.
  const myPaidCycles = new Set(d.contributions.filter((c) => c.userId === window.ME.userId).map((c) => c.cycle));

  const picker = $('#cyclepick');
  picker.textContent = '';
  g.dueDates.forEach((due, i) => {
    const cycle = i + 1;
    if (myPaidCycles.has(cycle)) return;
    picker.append(el('option', { value: String(cycle) }, `Cycle ${cycle} — due ${due}`));
  });
  if (!picker.options.length) {
    form.hidden = true;
    return;
  }
  picker.value = String(Math.min(g.currentCycle, g.dueDates.length));
  if (!picker.value) picker.selectedIndex = 0;
  $('#payamount').value = g.contributionAmount;

  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#payerror');
    const status = $('#paystatus');
    err.hidden = true;
    const btn = form.querySelector('.primary');
    btn.disabled = true;

    try {
      let evidenceKey;
      const file = form.evidence.files[0];
      if (file) {
        // Presigned PUT: the image goes browser -> S3 directly, never through Lambda.
        status.textContent = 'uploading evidence…';
        const { uploadUrl, key } = await api('/uploads/presign', { method: 'POST', body: { contentType: file.type, groupId: id } });
        const put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
        if (!put.ok) throw new Error('evidence upload failed');
        evidenceKey = key;
      }
      status.textContent = 'saving…';
      const out = await api(`/groups/${id}/contributions`, {
        method: 'POST',
        body: { cycle: Number(picker.value), amount: g.contributionAmount, evidenceKey },
      });
      status.textContent = out.onTime ? 'logged, on time' : `logged, late (due ${out.dueDate})`;
      setTimeout(() => location.reload(), 900);
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
      btn.disabled = false;
      status.textContent = '';
    }
  };
}

async function loadReport(id) {
  const chart = $('#chart');
  const rows = $('#reportrows');
  chart.textContent = '';
  rows.textContent = '';
  rows.append(el('tr', {}, el('td', { colSpan: 4, className: 'muted' }, 'Running query…')));

  let d;
  try {
    d = await api(`/groups/${id}/report`);
  } catch (e) {
    rows.textContent = '';
    rows.append(el('tr', {}, el('td', { colSpan: 4, className: 'error' }, e.message)));
    return;
  }

  $('#reportsource').textContent = d.source === 'athena' ? 'Athena over Glue catalog' : 'live DynamoDB rollup';
  $('#reportnote').hidden = !d.note;
  if (d.note) $('#reportnote').textContent = d.note;

  // Bar height is the on-time rate, not the payment count: every cycle collects
  // the same number of payments, so counts would draw a flat, meaningless chart.
  const cycles = d.byCycle || [];
  for (const c of cycles) {
    const paid = Number(c.paid);
    const onTime = Number(c.on_time);
    const pct = paid ? (onTime / paid) * 100 : 0;
    chart.append(el('div', { className: 'col' },
      el('b', {}, `${Math.round(pct)}%`),
      el('i', { style: `height:${Math.max(2, pct)}%`, title: `${onTime} of ${paid} paid on time` }),
      el('small', {}, `cycle ${c.cycle}`),
      el('small', {}, `${onTime}/${paid}`)));
  }
  if (!cycles.length) chart.append(el('p', { className: 'muted' }, 'No contributions logged yet.'));

  rows.textContent = '';
  for (const m of d.byMember || []) {
    rows.append(el('tr', {},
      el('td', {}, m.user_name),
      el('td', {}, String(m.payments)),
      el('td', {}, String(m.on_time)),
      el('td', {}, `${m.on_time_pct}%`)));
  }
}

// --------------------------------------------------------------------- boot
(async () => {
  const user = await mountNav();
  window.ME = user || {};
  const path = location.pathname;
  if (path === '/') initSignIn();
  else if (path === '/dashboard') initDashboard(user);
  else if (path.startsWith('/group/')) initGroup(user);
})();
