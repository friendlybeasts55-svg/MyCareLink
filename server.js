// Telehealth server: accounts, doctor verification, booking, private video rooms. Zero dependencies.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const SECRET = process.env.SECRET || crypto.randomBytes(32).toString('hex'); // set SECRET in production
const STRIPE = process.env.STRIPE_SECRET_KEY, CUR = (process.env.CURRENCY || 'usd').toLowerCase(),
  SAPI = process.env.STRIPE_API || 'https://api.stripe.com/v1', COMM = Math.min(50, Math.max(0, +process.env.COMMISSION_PERCENT || 15)); // COMM = your platform fee in percent  // Stripe Checkout (works worldwide where Stripe supports your business)
const DEMO_PAY = !STRIPE && (PROD ? process.env.DEMO_PAYMENTS === '1' : process.env.DEMO_PAYMENTS !== '0'); // fake "Pay" button, dev only
const DATA = process.env.DATA_DIR || __dirname;   // point DATA_DIR at a persistent disk/volume on your host
fs.mkdirSync(path.join(DATA, 'backups'), { recursive: true });
const DBF = path.join(DATA, 'db.json');
let db = { users: [], appts: [], audit: [] };
try { db = JSON.parse(fs.readFileSync(DBF)); } catch {}
const save = () => { fs.writeFileSync(DBF + '.tmp', JSON.stringify(db)); fs.renameSync(DBF + '.tmp', DBF); }; // atomic write: no half-written file on a crash
const backup = () => { try { const f = path.join(DATA, 'backups', 'db-' + new Date().toISOString().slice(0, 10) + '.json'); if (!fs.existsSync(f) && fs.existsSync(DBF)) fs.copyFileSync(DBF, f);
  fs.readdirSync(path.join(DATA, 'backups')).sort().slice(0, -14).forEach(x => fs.unlinkSync(path.join(DATA, 'backups', x))); } catch (e) { console.error('backup failed'); } };
const id = () => crypto.randomBytes(8).toString('hex');
const audit = (who, what) => { db.audit.push({ t: new Date().toISOString(), who, what }); db.audit = db.audit.slice(-1000); };
const bad = (msg, code = 400) => { throw { code, msg }; };

// ---- security helpers
const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
const checkPw = (pw, st) => { const [s, h] = st.split(':'); return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(pw, s, 64)); };
const mac = b => crypto.createHmac('sha256', SECRET).update(b).digest('base64url');
const sign = p => { const b = Buffer.from(JSON.stringify(p)).toString('base64url'); return b + '.' + mac(b); };
const unsign = t => { try { const [b, s] = (t || '').split('.'); const e = mac(b); if (!s || s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return; const p = JSON.parse(Buffer.from(b, 'base64url')); return p.exp > Date.now() ? p : undefined; } catch {} };
const hits = new Map();
const limited = (k, max, win) => { const n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < win); a.push(n); hits.set(k, a); return a.length > max; };
setInterval(() => hits.clear(), 3600000);
const SEC = { 'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()', ...(PROD ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}) };

// ---- data helpers
const pub = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, status: u.status, specialty: u.specialty, fee: u.fee });
const DUR = 30 * 60000;
const canJoin = a => a.paid && a.status === 'booked' && Date.now() >= new Date(a.time) - 15 * 60000 && Date.now() <= +new Date(a.time) + DUR + 60 * 60000;
const view = (a, me) => { const o = db.users.find(u => u.id === (me.role === 'doctor' ? a.patientId : a.doctorId)) || {};
  return { id: a.id, time: a.time, fee: a.fee, status: a.status, paid: a.paid, notes: a.notes, rating: a.rating, files: (a.files || []).map(f => ({ id: f.id, name: f.name, size: f.size })), canJoin: canJoin(a), net: me.role === 'doctor' && a.paid && a.fee > 0 ? +(a.fee - (a.commission ?? Math.round(a.fee * COMM) / 100)).toFixed(2) : 0, other: { name: o.name, specialty: o.specialty } }; };
const bookable = d => d.role === 'doctor' && d.status === 'approved' && (d.fee === 0 || !STRIPE || d.payoutsReady);
const mine = (c, aid) => { const a = db.appts.find(x => x.id === aid && (x.doctorId === c.user.id || x.patientId === c.user.id)); if (!a) bad('Appointment not found', 404); return a; };
const str = (v, max) => String(v || '').trim().slice(0, max);
const BASE = process.env.BASE_URL || 'http://localhost:' + PORT;
const UP = path.join(DATA, 'uploads'); fs.mkdirSync(UP, { recursive: true });
// Email: set RESEND_API_KEY and MAIL_FROM to send real emails (resend.com). Without them, emails print in the console.
const mail = async (to, subject, text) => {
  if (!process.env.RESEND_API_KEY) return console.log(`\n[EMAIL to ${to}] ${subject}\n${text}\n`);
  try { await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.MAIL_FROM, to, subject, text }) }); } catch { console.error('email failed'); }
};
const notify = (a, subject, text) => [a.doctorId, a.patientId].forEach(i => { const u = db.users.find(x => x.id === i); u && mail(u.email, subject, text); });
const remind = () => { const n = Date.now(); db.appts.forEach(a => { if (a.status !== 'booked') return; const left = new Date(a.time) - n; if (left <= 0) return;
  if (left <= 3600000 && !a.r1) { a.r1 = a.r24 = 1; notify(a, 'Your visit starts within an hour', `Your CareLink visit is at ${new Date(a.time).toUTCString()}. Sign in at ${BASE} to join.`); }
  else if (left <= 86400000 && !a.r24) { a.r24 = 1; notify(a, 'Reminder: visit tomorrow', `Your CareLink visit is at ${new Date(a.time).toUTCString()}. Sign in at ${BASE}.`); } }); save(); };
const stripe = (p, body, key) => fetch(SAPI + p, { method: 'POST', headers: { Authorization: 'Bearer ' + STRIPE, 'Content-Type': 'application/x-www-form-urlencoded', ...(key ? { 'Idempotency-Key': key } : {}) }, body: new URLSearchParams(body) }).then(r => r.json());
const stripeGet = p => fetch(SAPI + p, { headers: { Authorization: 'Bearer ' + STRIPE } }).then(r => r.json());
const FT = { pdf: ['application/pdf', b => b.slice(0, 4).toString() === '%PDF'], png: ['image/png', b => b.slice(1, 4).toString() === 'PNG'], jpg: ['image/jpeg', b => b[0] === 0xff && b[1] === 0xd8] };

// ---- routes
const routes = [];
const R = (m, p, fn, o = {}) => routes.push({ m, re: new RegExp('^' + p.replace(/:\w+/g, '([\\w-]+)') + '$'), fn, o });
const calls = {};

R('POST', '/api/register', c => {
  const b = c.body, email = str(b.email, 100).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) bad('Enter a valid email');
  if (str(b.name, 80).length < 2) bad('Enter your full name');
  if (String(b.password || '').length < 10) bad('Password must be at least 10 characters');
  if (b.consent !== true) bad('You must accept the Terms and Privacy Policy');
  if (!['patient', 'doctor'].includes(b.role)) bad('Choose patient or doctor');
  if (db.users.some(u => u.email === email)) bad('An account with this email already exists');
  const u = { id: id(), name: str(b.name, 80), email, pw: hashPw(b.password), role: b.role, status: 'active', created: Date.now() };
  if (b.role === 'doctor') {
    if (str(b.license, 50).length < 4) bad('Enter your medical license number');
    Object.assign(u, { status: 'pending', specialty: str(b.specialty, 60) || 'General', license: str(b.license, 50), fee: Math.max(0, Math.min(1e6, +b.fee || 0)), slots: [] });
  }
  db.users.push(u); audit(u.id, 'register ' + u.role); save();
  return { ok: true, message: u.role === 'doctor' ? 'Account created. An admin will verify your license before you appear to patients.' : 'Account created. You can sign in.' };
});
R('POST', '/api/login', c => {
  const email = str(c.body.email, 100).toLowerCase();
  if (limited('login:' + c.ip + email, 8, 15 * 60000)) bad('Too many attempts. Try again in 15 minutes.', 429);
  const u = db.users.find(x => x.email === email);
  if (!u || !checkPw(String(c.body.password || ''), u.pw)) { audit(email, 'login failed'); bad('Wrong email or password', 401); }
  audit(u.id, 'login'); c.cookie = sign({ id: u.id, iat: Date.now(), exp: Date.now() + 8 * 3600000 }); return pub(u);
});
R('POST', '/api/forgot', c => {
  const email = str(c.body.email, 100).toLowerCase();
  if (limited('forgot:' + c.ip + email, 3, 3600000)) bad('Too many requests. Try again later.', 429);
  const u = db.users.find(x => x.email === email);
  if (u) { const t = crypto.randomBytes(32).toString('base64url'); u.reset = { h: crypto.createHash('sha256').update(t).digest('hex'), exp: Date.now() + 1800000 }; save(); audit(u.id, 'password reset requested');
    mail(u.email, 'Reset your CareLink password', `Open this link within 30 minutes: ${BASE}/#reset=${t}\nIf you did not ask for this, ignore this email.`); }
  return { ok: true, message: 'If that email has an account, a reset link is on its way.' };
});
R('POST', '/api/reset', c => {
  if (limited('reset:' + c.ip, 10, 3600000)) bad('Too many attempts', 429);
  if (String(c.body.password || '').length < 10) bad('Password must be at least 10 characters');
  const hs = crypto.createHash('sha256').update(String(c.body.token || '')).digest('hex');
  const u = db.users.find(x => x.reset && x.reset.h === hs && x.reset.exp > Date.now()); if (!u) bad('This reset link is invalid or has expired');
  u.pw = hashPw(c.body.password); u.pwAt = Date.now(); delete u.reset; audit(u.id, 'password reset'); save();
  return { ok: true, message: 'Password updated. You can sign in.' };
});
R('POST', '/api/logout', c => { c.cookie = ''; return { ok: true }; });
R('GET', '/api/me', c => pub(c.user), { auth: 1 });

R('GET', '/api/doctors', c => db.users.filter(bookable).map(d => ({ id: d.id, name: d.name, specialty: d.specialty, fee: d.fee,
  slots: d.slots.filter(s => !s.booked && new Date(s.time) > Date.now()).sort((a, b) => a.time.localeCompare(b.time)).slice(0, 12) })), { auth: 1, roles: ['patient'] });
R('POST', '/api/slots', c => {
  if (c.user.status !== 'approved') bad('Your account is not verified yet', 403);
  const t = new Date(c.body.time); if (isNaN(t) || t < Date.now()) bad('Pick a future time');
  if (c.user.slots.some(s => s.time === t.toISOString())) bad('You already added this time');
  c.user.slots.push({ id: id(), time: t.toISOString(), booked: false }); save(); return { ok: true };
}, { auth: 1, roles: ['doctor'] });
R('GET', '/api/slots', c => c.user.slots.filter(s => new Date(s.time) > Date.now()), { auth: 1, roles: ['doctor'] });

R('POST', '/api/book', c => {
  const d = db.users.find(u => u.id === c.body.doctorId && bookable(u));
  const s = d && d.slots.find(x => x.id === c.body.slotId && !x.booked && new Date(x.time) > Date.now());
  if (!s) bad('That time is no longer available');
  s.booked = true;
  const a = { id: id(), doctorId: d.id, patientId: c.user.id, slotId: s.id, time: s.time, fee: d.fee, status: 'booked', paid: d.fee === 0, notes: '', rating: null };
  db.appts.push(a); audit(c.user.id, 'book ' + a.id); save(); notify(a, 'Appointment booked', `A CareLink visit is booked for ${new Date(a.time).toUTCString()}.`); remind(); return view(a, c.user);
}, { auth: 1, roles: ['patient'] });
R('GET', '/api/appts', c => db.appts.filter(a => a.doctorId === c.user.id || a.patientId === c.user.id).sort((a, b) => a.time.localeCompare(b.time)).map(a => view(a, c.user)), { auth: 1 });
R('POST', '/api/appts/:id/pay', async c => {
  const a = mine(c, c.m[1]); if (a.patientId !== c.user.id) bad('Not allowed', 403);
  if (a.paid || a.status !== 'booked') bad('There is nothing to pay for this appointment');
  if (STRIPE) {
    const dr = db.users.find(u => u.id === a.doctorId); if (a.fee > 0 && !dr.payoutsReady) bad('This doctor cannot take payments yet', 409);
    try {
      const s = await stripe('/checkout/sessions', { mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': CUR, 'line_items[0][price_data][unit_amount]': String(Math.round(a.fee * 100)),
        'line_items[0][price_data][product_data][name]': 'Doctor visit on ' + new Date(a.time).toUTCString(), client_reference_id: a.id, 'metadata[appt]': a.id, customer_email: c.user.email,
        'payment_intent_data[application_fee_amount]': String(Math.round(a.fee * COMM)), 'payment_intent_data[transfer_data][destination]': dr.stripeAcct, // doctor is paid directly, you keep the fee
        success_url: BASE + '/?paid=1', cancel_url: BASE + '/' }, 'checkout-' + a.id + '-' + Math.floor(Date.now() / 600000));
      if (!s.url) throw 0; return { url: s.url };
    } catch { bad('The payment service is unavailable. Try again shortly.', 502); }
  }
  if (!DEMO_PAY) bad('Online payment is not set up yet', 501);
  a.paid = true; audit(c.user.id, 'demo pay ' + a.id); save(); return { ok: true };
}, { auth: 1, roles: ['patient'] });
// Stripe tells us a payment succeeded. The signature proves the message really came from Stripe.
R('POST', '/api/stripe/webhook', c => {
  const secs = [process.env.STRIPE_WEBHOOK_SECRET, process.env.STRIPE_CONNECT_WEBHOOK_SECRET].filter(Boolean); if (!STRIPE || !secs.length) bad('Not configured', 501);
  const p = Object.fromEntries(String(c.headers['stripe-signature'] || '').split(',').map(x => x.split('='))), t = +p.t;
  const valid = p.v1 && Math.abs(Date.now() / 1000 - t) <= 300 && secs.some(sec => { const e = crypto.createHmac('sha256', sec).update(t + '.' + c.raw).digest('hex'); return e.length === p.v1.length && crypto.timingSafeEqual(Buffer.from(e), Buffer.from(p.v1)); });
  if (!valid) bad('Bad signature');
  const ev = c.body;
  if (ev.type === 'checkout.session.completed') {
    const s = ev.data.object, a = db.appts.find(x => x.id === (s.metadata || {}).appt);
    if (a && !a.paid && s.payment_status === 'paid' && s.amount_total === Math.round(a.fee * 100) && String(s.currency).toLowerCase() === CUR) {
      a.paid = true; a.pi = s.payment_intent; a.commission = Math.round(a.fee * COMM) / 100; audit('stripe', 'paid ' + a.id); save(); notify(a, 'Payment received', `Payment for the visit on ${new Date(a.time).toUTCString()} was received.`);
    }
  }
  if (ev.type === 'account.updated') { const u = db.users.find(x => x.stripeAcct && x.stripeAcct === ev.data.object.id); if (u) { u.payoutsReady = (ev.data.object.capabilities || {}).transfers === 'active'; save(); } }
  return { received: true };
});
R('POST', '/api/appts/:id/cancel', c => {
  const a = mine(c, c.m[1]); if (a.status !== 'booked' || new Date(a.time) < Date.now()) bad('This appointment cannot be cancelled');
  a.status = 'cancelled'; a.refundDue = a.paid && a.fee > 0;
  if (a.refundDue && STRIPE && a.pi) stripe('/refunds', { payment_intent: a.pi, reverse_transfer: 'true', refund_application_fee: 'true' }, 'refund-' + a.id).then(r => { if (r.id) { a.refundDue = false; audit('stripe', 'refund ' + a.id); save(); } }).catch(() => {});
  const d = db.users.find(u => u.id === a.doctorId), s = d.slots.find(x => x.id === a.slotId); if (s) s.booked = false;
  audit(c.user.id, 'cancel ' + a.id); save(); notify(a, 'Appointment cancelled', `The visit on ${new Date(a.time).toUTCString()} was cancelled.` + (a.refundDue ? ' A refund is due.' : '')); return { ok: true };
}, { auth: 1 });
R('POST', '/api/appts/:id/notes', c => {
  const a = mine(c, c.m[1]); if (a.doctorId !== c.user.id) bad('Not allowed', 403);
  if (new Date(a.time) > Date.now()) bad('You can add notes once the visit starts');
  a.notes = str(c.body.notes, 3000); a.status = 'completed'; audit(c.user.id, 'notes ' + a.id); save(); return { ok: true };
}, { auth: 1, roles: ['doctor'] });
R('POST', '/api/appts/:id/rate', c => {
  const a = mine(c, c.m[1]), r = +c.body.rating; if (a.patientId !== c.user.id || a.status !== 'completed') bad('You can rate after the doctor completes the visit');
  if (!(r >= 1 && r <= 5)) bad('Rating must be 1 to 5'); a.rating = Math.round(r); save(); return { ok: true };
}, { auth: 1, roles: ['patient'] });

R('POST', '/api/appts/:id/files', c => {
  const a = mine(c, c.m[1]); if (a.status === 'cancelled') bad('This appointment was cancelled');
  a.files = a.files || []; if (a.files.length >= 5) bad('Limit of 5 files per appointment');
  const buf = Buffer.from(String(c.body.data || ''), 'base64'); if (!buf.length || buf.length > 3e6) bad('File must be under 3 MB');
  const ext = Object.keys(FT).find(k => FT[k][1](buf)); if (!ext) bad('Only PDF, PNG or JPG files are allowed');
  const f = { id: id(), ext, by: c.user.id, size: buf.length, name: str(c.body.name, 60).replace(/[^\w. -]/g, '_') || 'file.' + ext };
  fs.writeFileSync(path.join(UP, f.id), buf); a.files.push(f); audit(c.user.id, 'upload ' + f.id); save(); return { ok: true };
}, { auth: 1 });
R('GET', '/api/appts/:id/files/:fid', c => {
  const a = mine(c, c.m[1]), f = (a.files || []).find(x => x.id === c.m[2]); if (!f) bad('Not found', 404);
  audit(c.user.id, 'download ' + f.id); return { __file: { buf: fs.readFileSync(path.join(UP, f.id)), type: FT[f.ext][0], name: f.name } };
}, { auth: 1 });

// private video room: only the two people on a paid, current appointment
R('GET', '/api/call/:id/signal', c => {
  const a = mine(c, c.m[1]); if (!canJoin(a)) bad('This call is not open', 403);
  const after = +c.url.searchParams.get('after') || 0;
  return (calls[a.id] || []).filter(m => m.n > after && m.from !== c.user.id).map(m => ({ n: m.n, data: m.data }));
}, { auth: 1 });
R('POST', '/api/call/:id/signal', c => {
  const a = mine(c, c.m[1]); if (!canJoin(a)) bad('This call is not open', 403);
  const q = calls[a.id] = calls[a.id] || [], n = (q.length ? q[q.length - 1].n : 0) + 1;
  const sd = c.body.data || {}; if (JSON.stringify(sd).length > 12000 || !['ready', 'hello', 'offer', 'answer', 'ice', 'chat'].includes(sd.type)) bad('Bad message');
  if (sd.type === 'chat' && (typeof sd.text !== 'string' || sd.text.length > 1000)) bad('Message too long');
  q.push({ n, from: c.user.id, data: c.body.data }); if (q.length > 300) q.shift();
  if (c.body.data && c.body.data.type === 'ready') audit(c.user.id, 'join call ' + a.id); return { ok: true };
}, { auth: 1 });

// doctor payouts (Stripe Connect Express): the doctor onboards with Stripe and is paid directly
const need = () => { if (!STRIPE) bad('Payments are not set up on this site', 501); };
R('GET', '/api/connect/status', async c => {
  const u = c.user;
  if (STRIPE && u.stripeAcct && !u.payoutsReady) { try { const a = await stripeGet('/accounts/' + u.stripeAcct); u.payoutsReady = (a.capabilities || {}).transfers === 'active'; save(); } catch {} }
  return { configured: !!STRIPE, connected: !!u.stripeAcct, ready: !!u.payoutsReady };
}, { auth: 1, roles: ['doctor'] });
R('POST', '/api/connect/onboard', async c => {
  need(); const u = c.user; if (u.status !== 'approved') bad('Your account is not verified yet', 403);
  try {
    if (!u.stripeAcct) { const a = await stripe('/accounts', { type: 'express', email: u.email, 'capabilities[transfers][requested]': 'true', 'metadata[user]': u.id }, 'acct-' + u.id); if (!a.id) throw 0; u.stripeAcct = a.id; save(); }
    const l = await stripe('/account_links', { account: u.stripeAcct, refresh_url: BASE + '/?connect=refresh', return_url: BASE + '/?connect=done', type: 'account_onboarding' }); if (!l.url) throw 0;
    audit(u.id, 'payout onboarding'); return { url: l.url };
  } catch { bad('Could not reach the payment service. Try again shortly.', 502); }
}, { auth: 1, roles: ['doctor'] });
R('POST', '/api/connect/dashboard', async c => {
  need(); if (!c.user.stripeAcct) bad('Set up payouts first');
  try { const l = await stripe('/accounts/' + c.user.stripeAcct + '/login_links', {}); if (!l.url) throw 0; return { url: l.url }; } catch { bad('Could not reach the payment service. Try again shortly.', 502); }
}, { auth: 1, roles: ['doctor'] });

// admin
R('GET', '/api/admin/summary', c => { const p = db.appts.filter(a => a.paid && a.fee > 0 && a.status !== 'cancelled');
  return { visits: p.length, percent: COMM, gross: +p.reduce((t, a) => t + a.fee, 0).toFixed(2), fees: +p.reduce((t, a) => t + (a.commission ?? Math.round(a.fee * COMM) / 100), 0).toFixed(2) }; }, { auth: 1, roles: ['admin'] });
R('GET', '/api/admin/doctors', c => db.users.filter(u => u.role === 'doctor').map(u => ({ ...pub(u), license: u.license })), { auth: 1, roles: ['admin'] });
R('POST', '/api/admin/doctors/:id/:act', c => {
  const u = db.users.find(x => x.id === c.m[1] && x.role === 'doctor'); if (!u) bad('Not found', 404);
  if (!['approve', 'reject'].includes(c.m[2])) bad('Bad action');
  u.status = c.m[2] === 'approve' ? 'approved' : 'rejected'; audit(c.user.id, c.m[2] + ' doctor ' + u.id); save(); return { ok: true };
}, { auth: 1, roles: ['admin'] });
R('GET', '/api/admin/audit', c => db.audit.slice(-100).reverse(), { auth: 1, roles: ['admin'] });

// ---- server
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };
const send = (res, code, body, extra = {}) => { res.writeHead(code, { ...SEC, 'Content-Type': 'application/json', ...extra }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'), ip = (process.env.TRUST_PROXY && req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (!url.pathname.startsWith('/api/')) {
    const f = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!['index.html', 'app.js'].includes(f)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    return fs.readFile(path.join(__dirname, 'public', f), (e, d) => e ? send(res, 404, 'Not found') : send(res, 200, d, { 'Content-Type': mime[path.extname(f)] }));
  }
  if (limited('ip:' + ip, 400, 60000)) return send(res, 429, { error: 'Too many requests' });
  if (req.method !== 'GET' && url.pathname !== '/api/stripe/webhook' && req.headers['x-requested-with'] !== 'fetch') return send(res, 403, { error: 'Bad request' });
  let raw = ''; req.on('data', d => { raw += d; if (raw.length > (req.method === 'POST' && /\/files$/.test(url.pathname) ? 4.5e6 : 20000)) req.destroy(); });
  req.on('end', async () => {
    try {
      let body = {}; if (raw) { try { body = JSON.parse(raw); } catch { bad('Invalid data'); } }
      const r = routes.find(x => x.m === req.method && x.re.test(url.pathname)); if (!r) bad('Not found', 404);
      const c = { body, raw, headers: req.headers, ip, url, m: url.pathname.match(r.re) };
      if (r.o.auth) {
        const cookie = (req.headers.cookie || '').split(/;\s*/).find(s => s.startsWith('sid=')), p = unsign(cookie && cookie.slice(4));
        c.user = p && db.users.find(u => u.id === p.id); if (c.user && p.iat < (c.user.pwAt || 0)) c.user = undefined; if (!c.user) bad('Please sign in', 401);
        if (r.o.roles && !r.o.roles.includes(c.user.role)) bad('Not allowed', 403);
      }
      const out = await r.fn(c), extra = {};
      if (c.cookie !== undefined) extra['Set-Cookie'] = `sid=${c.cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${c.cookie ? 28800 : 0}${PROD ? '; Secure' : ''}`;
      if (out && out.__file) { res.writeHead(200, { ...SEC, 'Content-Type': out.__file.type, 'Content-Disposition': `attachment; filename="${out.__file.name}"` }); return res.end(out.__file.buf); }
      send(res, 200, out, extra);
    } catch (e) { if (!e.code) console.error(e); send(res, e.code || 500, { error: e.code ? e.msg : 'Server error' }); }
  });
}).listen(PORT, () => console.log('Telehealth running on http://localhost:' + PORT));

setInterval(remind, 60000); backup(); setInterval(backup, 3600000);

// first-run admin account
if (!db.users.some(u => u.role === 'admin')) {
  const email = process.env.ADMIN_EMAIL || 'admin@example.com', pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  db.users.push({ id: id(), name: 'Admin', email, pw: hashPw(pw), role: 'admin', status: 'active', created: Date.now() }); save();
  console.log(`\nAdmin created. Email: ${email}  Password: ${pw}\nChange these with ADMIN_EMAIL / ADMIN_PASSWORD before going live.\n`);
}
