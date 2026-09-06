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

const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) node.setAttribute(k, String(v));
  kids.flat().forEach((k) => k != null && node.append(k));
  return node;
};

const token = {
  get: () => localStorage.getItem('hui.token'),
  set: (t) => localStorage.setItem('hui.token', t),
  clear: () => localStorage.removeItem('hui.token'),
};

async function api(path, { method = 'GET', body } = {}) {
  // Without a deadline a dropped connection leaves the page on "Loading..."
  // forever with nothing to tell the user why. Real calls answer in well under a
  // second, so 15s only ever fires on a genuine stall.
  let res;
  try {
    res = await fetch(API + path, {
      method,
      signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(token.get() ? { Authorization: `Bearer ${token.get()}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new Error(e.name === 'TimeoutError'
      ? 'The server did not answer in time. Check your connection and reload.'
      : 'Could not reach the server. Check your connection and reload.');
  }
  const data = await res.json().catch(() => ({ error: `${res.status} ${res.statusText}` }));
  if (res.status === 401) { token.clear(); location.href = '/'; }
  if (!res.ok) throw new Error(data.error || 'request failed');
  return data;
}

const money = (amount, currency) => `${Number(amount).toLocaleString()} ${currency}`;
const day = (iso) => (iso ? String(iso).slice(0, 10) : '—');

function scoreCell(score) {
  return el('div', { className: 'score' },
    el('div', { className: 'score-bar' }, el('i', { style: `width:${Math.max(2, score)}%` })),
    el('span', {}, String(score)));
}

// ------------------------------------------------------------------- the ring
// A rotation is the one thing a paper hui book cannot draw, so it is the hero on
// every page: seats around a circle, the pot resting on whoever's turn it is.
// Same function at 300px on the landing page, 232px on a circle, 46px in a row.
// Seats carry no names — the table underneath maps seat to member, and crowding
// six diacritic-heavy names into 13px dots would only make both unreadable.
function ringSvg({ size = 232, seats, current = 0, filled = 0, center, caption }) {
  const big = size >= 150;
  const seatR = big ? 13 : Math.max(3, size / 13);
  const radius = size / 2 - seatR - (big ? 10 : 4);
  const mid = size / 2;
  const at = (i) => {
    const angle = (-90 + (360 / seats) * i) * (Math.PI / 180);
    return [mid + radius * Math.cos(angle), mid + radius * Math.sin(angle)];
  };

  const root = svg('svg', { class: 'ring', viewBox: `0 0 ${size} ${size}`, width: size, height: size, role: 'img' });
  root.append(svg('title', {}, caption || `Seat ${current} of ${seats}`));
  root.append(svg('circle', { class: 'ring-track', cx: mid, cy: mid, r: radius }));

  for (let i = 0; i < seats; i++) {
    const [x, y] = at(i);
    const state = i + 1 === current ? 'now' : i < filled ? 'done' : '';
    root.append(svg('circle', { class: `seat ${state}`.trim(), cx: x, cy: y, r: seatR }));
  }
  if (current) {
    const [x, y] = at(current - 1);
    root.append(svg('circle', { class: 'pot', cx: x, cy: y, r: seatR + (big ? 8 : 4) }));
  }
  if (big && center) {
    root.append(svg('text', { class: 'ring-n', x: mid, y: mid + 3 }, center[0]));
    root.append(svg('text', { class: 'ring-of', x: mid, y: mid + 21 }, center[1]));
  }
  return root;
}

// ------------------------------------------------------------------ chrome
async function mountNav() {
  $('#apihint').textContent = new URL(API).host;
  if (!token.get()) return null;
  try {
    const { user } = await api('/me');
    $('#who').textContent = `${user.name}, reliability ${user.reliability}`;
    $('#nav').hidden = false;
    $('#signout').onclick = () => { token.clear(); location.href = '/'; };
    return user;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ sign in
const HERO_NAMES = ['Mai', 'Hương', 'Đức', 'Linh', 'Tuấn', 'Bảo'];

// The one piece of motion on the site: the pot travels a single lap on load and
// then rests. It is here because the mechanic is hard to explain in a sentence
// and obvious in three seconds of movement.
function initHero() {
  const host = $('#herochart');
  const cap = $('#herocap');
  if (!host) return;
  const seats = HERO_NAMES.length;

  const ring = ringSvg({ size: 300, seats, current: 1, filled: 0, center: ['1', `of ${seats} cycles`] });
  ring.classList.add('ring-dark');
  host.append(ring);

  const dots = [...ring.querySelectorAll('.seat')];
  const pot = ring.querySelector('.pot');
  const number = ring.querySelector('.ring-n');

  const show = (cycle) => {
    const seat = dots[cycle - 1];
    pot.setAttribute('cx', seat.getAttribute('cx'));
    pot.setAttribute('cy', seat.getAttribute('cy'));
    dots.forEach((dot, i) => {
      dot.classList.toggle('now', i === cycle - 1);
      dot.classList.toggle('done', i < cycle - 1);
    });
    number.textContent = String(cycle);
    cap.textContent = '';
    cap.append(`Cycle ${cycle}, and the pot goes to `, el('b', {}, HERO_NAMES[cycle - 1]), '.');
  };

  show(1);
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  let cycle = 1;
  setTimeout(() => {
    const step = setInterval(() => {
      cycle += 1;
      if (cycle > seats) {
        clearInterval(step);
        cap.textContent = `${seats} cycles, ${seats} payouts, and everyone has been paid exactly once.`;
        return;
      }
      show(cycle);
    }, 620);
  }, 700);
}

// Only ever holds a same-origin /group/ path this script wrote itself, so it
// cannot be turned into an open redirect by a crafted link.
const INVITE_KEY = 'hui.invite';
function takeInvite() {
  const next = sessionStorage.getItem(INVITE_KEY);
  sessionStorage.removeItem(INVITE_KEY);
  return next && next.startsWith('/group/') ? next : '/dashboard';
}

function initSignIn() {
  if (token.get()) { location.href = '/dashboard'; return; }
  initHero();

  // Tell an invited friend what they are signing in for.
  if (sessionStorage.getItem(INVITE_KEY)) {
    const note = $('#invitenote');
    if (note) note.hidden = false;
  }

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
      location.href = takeInvite();
    } catch (e2) {
      err.textContent = e2.message;
      err.hidden = false;
    }
  };
}

// ----------------------------------------------------------------- dashboard
async function initDashboard(user) {
  if (!user) { location.href = '/'; return; }
  $('#scoreline').textContent = `Your reliability score is ${user.reliability}. It comes from ${user.onTimeCount} on-time payments out of ${user.contribCount}.`;

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
    box.append(el('li', { className: 'empty' }, 'You are not in a circle yet. Start one, then send the link to people you trust.'));
    return;
  }
  for (const g of groups) {
    const open = g.status === 'OPEN';
    const seats = open ? g.memberCap : g.dueDates.length;
    const current = !open && !g.complete ? g.currentCycle : 0;
    const filled = open ? g.memberCount : g.complete ? seats : g.currentCycle - 1;
    const state = open ? `${g.memberCount} of ${g.memberCap} seats taken`
      : g.complete ? 'Everyone has been paid' : `Cycle ${g.currentCycle} of ${g.dueDates.length}`;

    box.append(el('li', {}, el('a', { className: 'circle-row', href: `/group/${g.groupId}` },
      ringSvg({ size: 46, seats, current, filled, caption: state }),
      el('div', { className: 'circle-body' },
        el('h3', {}, g.name),
        el('p', { className: 'muted small', style: 'margin:0' },
          `${money(g.contributionAmount, g.currency)} every ${g.cycleLengthDays} days, for a pot of ${money(g.contributionAmount * g.memberCount, g.currency)}.`)),
      el('span', { className: `tag ${open ? 'wait' : current ? 'pot' : ''}`.trim() }, state))));
  }
}

// --------------------------------------------------------------- group page
async function initGroup(user) {
  // An invite link is the one page strangers arrive at signed out. Remember it
  // so signing in returns them to the circle instead of a bare dashboard.
  if (!user) { sessionStorage.setItem(INVITE_KEY, location.pathname); location.href = '/'; return; }
  const id = window.GROUP_ID;

  const TAB_KEY = `hui.tab.${id}`;
  const selectTab = (name) => {
    document.querySelectorAll('.tab[data-panel]').forEach((t) => t.classList.toggle('active', t.dataset.panel === name));
    document.querySelectorAll('.panel[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    if (name === 'report') loadReport(id);
  };

  document.querySelectorAll('.tab[data-panel]').forEach((tab) => {
    tab.onclick = () => { sessionStorage.setItem(TAB_KEY, tab.dataset.panel); selectTab(tab.dataset.panel); };
  });

  await render(id, user);

  // Joining, starting and logging a payment all reload the page. Without this the
  // user is thrown back to Members and loses sight of the row they just created.
  const savedTab = sessionStorage.getItem(TAB_KEY);
  if (savedTab) selectTab(savedTab);

  $('#joinbtn').onclick = async () => { await api(`/groups/${id}/join`, { method: 'POST' }); location.reload(); };
  $('#startbtn').onclick = async () => { await api(`/groups/${id}/start`, { method: 'POST' }); location.reload(); };
  $('#democlock').onclick = async () => { await api(`/groups/${id}/demo/advance`, { method: 'POST' }); location.reload(); };
}

async function render(id, user) {
  // Ask for a USD conversion alongside the group's own currency; the API fetches
  // it from the third-party exchange-rate service.
  const d = await api(`/groups/${id}?display=USD`);
  const g = d.group;
  const open = g.status === 'OPEN';

  $('#gname').textContent = g.name;
  $('#gsub').textContent = `Organised by ${g.ownerName}. ${money(g.contributionAmount, g.currency)} from each member every ${g.cycleLengthDays} days.`;

  const nextDue = g.status === 'ACTIVE' && !g.complete ? g.dueDates[g.currentCycle - 1] : null;
  const recipient = nextDue ? d.members.find((m) => m.payoutPosition === g.currentCycle) : null;
  const seats = open ? g.memberCap : g.dueDates.length;
  const current = !open && !g.complete ? g.currentCycle : 0;
  const filled = open ? g.memberCount : g.complete ? seats : g.currentCycle - 1;

  const gring = $('#gring');
  gring.textContent = '';
  gring.append(ringSvg({
    size: 232,
    seats,
    current,
    filled,
    center: open ? [String(g.memberCount), `of ${g.memberCap} seats`] : [String(Math.min(g.currentCycle, seats)), `of ${seats} cycles`],
    caption: open ? `${g.memberCount} of ${g.memberCap} seats taken` : `Cycle ${g.currentCycle} of ${seats}`,
  }));

  const facts = $('#facts');
  facts.textContent = '';
  facts.append(el('div', { className: 'fact' },
    el('div', { className: 'pot-figure' }, money(d.pot, g.currency)),
    el('span', {}, d.converted ? `in the pot each cycle, about ${money(d.converted.amount, d.converted.currency)}` : 'in the pot each cycle')));
  for (const [value, label] of [
    [`${g.memberCount} of ${g.memberCap}`, 'members'],
    [open ? 'Not started' : g.complete ? 'Complete' : `${g.currentCycle} of ${g.dueDates.length}`, 'cycle'],
    [nextDue || 'Not scheduled', 'next payment due'],
    [recipient ? recipient.name : 'Nobody yet', 'takes this pot'],
  ]) facts.append(el('div', { className: 'fact' }, el('b', {}, value), el('span', {}, label)));

  $('#joinbtn').hidden = d.isMember || !open || g.memberCount >= g.memberCap;
  $('#startbtn').hidden = !(g.ownerId === user.userId && open && g.memberCount >= 2);

  // Invites are just the circle's own URL: anyone signed in who opens it while
  // seats remain gets the Join button. No invite tokens, no pending-member state.
  const invite = $('#invitebtn');
  invite.hidden = !(d.isMember && open && g.memberCount < g.memberCap);
  invite.onclick = () => copyLink(invite, 'Copy invite link');

  // Demo clock. Only the organiser sees it, only while DEMO_MODE is on, and the
  // label says what the next press will do rather than making you guess.
  const clock = $('#democlock');
  const canDemo = d.demo && g.ownerId === user.userId && g.status === 'ACTIVE' && g.dueDates.length > 0;
  clock.hidden = !canDemo;
  if (canDemo) {
    const today = new Date().toISOString().slice(0, 10);
    const due = g.dueDates[g.currentCycle - 1];
    // Past the final due date the circle reads complete; offer a reset rather
    // than hiding the control and stranding the demo with no way back.
    clock.textContent = g.complete ? 'Test: reset the clock'
      : due > today ? 'Test: jump to due date' : 'Test: push past due date';
  }

  const tbody = $('#members');
  tbody.textContent = '';
  for (const m of d.members) {
    tbody.append(el('tr', {},
      el('td', { className: 'seatno' }, m.payoutPosition ? String(m.payoutPosition) : '—'),
      el('td', {}, m.name + (m.userId === g.ownerId ? ' (organiser)' : '')),
      el('td', {}, scoreCell(m.reliability)),
      el('td', { className: 'muted' }, `${m.onTimeCount} of ${m.contribCount}`),
      el('td', {}, thisCycleTag(d, m)),
      el('td', {}, m.payoutPosition && g.dueDates.length ? day(g.dueDates[m.payoutPosition - 1]) : '—')));
  }

  renderLedger(d);
  setupPayForm(id, d);
}

// An organiser's real question is "who still owes me for this cycle". The answer
// is already in the group payload, so it belongs as a column on the table that
// already lists everyone rather than a separate organiser-only page.
function thisCycleTag(d, member) {
  const cycle = d.group.currentCycle;
  if (!cycle || cycle > d.group.dueDates.length) return el('span', { className: 'tag wait' }, '—');
  const paid = d.contributions.find((c) => c.cycle === cycle && c.userId === member.userId);
  if (!paid) return el('span', { className: 'tag wait' }, 'Not paid');
  return el('span', { className: `tag ${paid.onTime ? '' : 'late'}`.trim() }, paid.onTime ? 'On time' : 'Late');
}

// Beanstalk serves plain http, so navigator.clipboard does not exist here and
// execCommand('copy') needs a user gesture Chrome no longer grants a script.
// Revealing the link pre-selected always works; the clipboard is the bonus path
// for whenever this sits behind https.
async function copyLink(button, label) {
  const url = location.href;
  const field = $('#invitelink');
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = 'Link copied';
    setTimeout(() => { button.textContent = label; }, 2000);
  } catch {
    field.value = url;
    field.hidden = false;
    field.select();
    button.textContent = 'Copy this link';
  }
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
      el('td', { className: 'seatno' }, String(c.cycle)),
      el('td', {}, c.userName),
      el('td', {}, money(c.amount, c.currency)),
      el('td', { className: 'muted' }, c.dueDate),
      el('td', { className: 'muted' }, day(c.paidAt)),
      el('td', {}, el('span', { className: `tag ${c.onTime ? '' : 'late'}`.trim() }, c.onTime ? 'On time' : 'Late')),
      // The API decides how evidence is reachable - CloudFront when it exists,
      // a presigned GET when it does not - so the page just follows the link.
      el('td', {}, c.evidenceUrl
        ? el('a', { href: c.evidenceUrl, target: '_blank', rel: 'noopener' }, 'View')
        : '—')));
  }
}

function setupPayForm(id, d) {
  const form = $('#payform');
  const g = d.group;
  // Not gated on g.complete: once the last due date passes, an unpaid member
  // must still be able to record what they owe. The empty-picker check below
  // already hides the form when there is genuinely nothing left to pay.
  form.hidden = !(d.isMember && g.status === 'ACTIVE');
  if (form.hidden) return;

  // Only offer cycles this member has not already paid; the API rejects a repeat
  // anyway, but showing an impossible option is a worse experience than hiding it.
  const myPaidCycles = new Set(d.contributions.filter((c) => c.userId === window.ME.userId).map((c) => c.cycle));

  const picker = $('#cyclepick');
  picker.textContent = '';
  g.dueDates.forEach((due, i) => {
    const cycle = i + 1;
    if (myPaidCycles.has(cycle)) return;
    picker.append(el('option', { value: String(cycle) }, `Cycle ${cycle}, due ${due}`));
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
        status.textContent = 'Uploading evidence…';
        const { uploadUrl, key } = await api('/uploads/presign', { method: 'POST', body: { contentType: file.type, groupId: id } });
        // fetch only rejects on a network-level failure, and the browser's message
        // for that is the opaque "Failed to fetch". Say something the user can act
        // on - the file is still attached, so pressing the button again retries.
        let put;
        try {
          put = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
        } catch {
          throw new Error('Could not reach S3 to upload the evidence. Check your connection and press Log contribution again - your file is still attached.');
        }
        if (!put.ok) throw new Error(`evidence upload failed (S3 returned ${put.status})`);
        evidenceKey = key;
      }
      status.textContent = 'Saving…';
      const out = await api(`/groups/${id}/contributions`, {
        method: 'POST',
        body: { cycle: Number(picker.value), amount: g.contributionAmount, evidenceKey },
      });
      status.textContent = out.onTime ? 'Logged, on time.' : `Logged late, it was due ${out.dueDate}.`;
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
  rows.append(el('tr', {}, el('td', { colSpan: 4, className: 'muted' }, 'Running the query…')));

  let d;
  try {
    d = await api(`/groups/${id}/report`);
  } catch (e) {
    rows.textContent = '';
    rows.append(el('tr', {}, el('td', { colSpan: 4, className: 'error' }, e.message)));
    return;
  }

  const source = $('#reportsource');
  source.textContent = d.source === 'athena' ? 'Athena over the Glue catalog' : 'Live DynamoDB rollup';
  source.className = `tag small ${d.source === 'athena' ? '' : 'wait'}`.trim();
  $('#reportnote').hidden = !d.note;
  if (d.note) $('#reportnote').textContent = d.note;

  // Every cycle collects the same number of payments, so bar height by count would
  // draw identical rectangles. Each column is a full cycle instead, split into the
  // share paid on time and the share paid late.
  const cycles = d.byCycle || [];
  for (const c of cycles) {
    const paid = Number(c.paid);
    const onTime = Number(c.on_time);
    const pct = paid ? (onTime / paid) * 100 : 0;
    chart.append(el('div', { className: 'col' },
      el('span', { className: 'pct' }, `${Math.round(pct)}%`),
      el('div', { className: 'bar', title: `${onTime} of ${paid} paid on time` },
        el('i', { className: 'lateseg', style: `flex:${100 - pct} 1 0` }),
        el('i', { className: 'on', style: `flex:${pct} 1 0` })),
      el('span', { className: 'cyc' }, `Cycle ${c.cycle}`)));
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
  try {
    const user = await mountNav();
    window.ME = user || {};
    const path = location.pathname;
    if (path === '/') initSignIn();
    else if (path === '/dashboard') await initDashboard(user);
    else if (path.startsWith('/group/')) await initGroup(user);
  } catch (e) {
    // A failed boot would otherwise leave the placeholder "Loading..." on screen
    // with no clue what went wrong. Put the reason where the placeholder was.
    const slot = $('#gname') || $('#scoreline');
    if (slot) { slot.textContent = e.message; slot.classList.add('error'); }
  }
})();
