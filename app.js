const $ = s => document.querySelector(s);
const api = async (m, u, b) => {
  const r = await fetch('/api' + u, { method: m, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: b ? JSON.stringify(b) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'Something went wrong');
  return d;
};
// h() builds DOM with textContent only, so user text can never run as HTML
const h = (t, a = {}, ...c) => { const e = document.createElement(t);
  for (const k in a) k.startsWith('on') ? e[k] = a[k] : e.setAttribute(k, a[k]);
  c.flat().forEach(x => x != null && e.append(x)); return e; };
const fmt = iso => new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const root = $('#root'); let me = null, timer = null, call = null;
const show = (...n) => { root.replaceChildren(...n); };
const msg = (el, t, ok) => { el.className = ok ? 'ok' : 'err'; el.textContent = t; };

async function init() { if (location.hash.startsWith('#reset=')) return resetView(location.hash.slice(7)); try { me = await api('GET', '/me'); } catch { me = null; } me ? home() : authView(); }

function authView(mode = 'login') {
  clearInterval(timer); $('#who').replaceChildren();
  const out = h('div'), f = {}; const inp = (k, l, t = 'text', ex = {}) => { f[k] = h('input', { type: t, ...ex }); return [h('label', {}, l), f[k]]; };
  const doctorBox = h('div', { style: 'display:none' }, inp('specialty', 'Specialty (e.g. Dermatology)'), inp('license', 'Medical license number'), inp('fee', 'Fee per visit', 'number', { min: 0 }));
  f.role = h('select', { onchange: () => doctorBox.style.display = f.role.value === 'doctor' ? 'block' : 'none' }, h('option', { value: 'patient' }, 'I am a patient'), h('option', { value: 'doctor' }, 'I am a doctor'));
  f.consent = h('input', { type: 'checkbox' });
  const reg = mode === 'register';
  const go = h('button', { class: 'p', onclick: async () => {
    try {
      if (reg) { const r = await api('POST', '/register', { name: f.name.value, email: f.email.value, password: f.password.value, role: f.role.value, specialty: f.specialty.value, license: f.license.value, fee: +f.fee.value, consent: f.consent.checked }); msg(out, r.message, true); }
      else { me = await api('POST', '/login', { email: f.email.value, password: f.password.value }); home(); }
    } catch (e) { msg(out, e.message); } } }, reg ? 'Create account' : 'Sign in');
  show(h('div', { class: 'card' }, h('h2', {}, reg ? 'Create your account' : 'Welcome back'),
    reg ? [inp('name', 'Full name'), h('label', {}, 'Account type'), f.role] : [], inp('email', 'Email', 'email'),
    inp('password', reg ? 'Password (10+ characters)' : 'Password', 'password'), reg ? doctorBox : [],
    reg ? h('label', { class: 'chk' }, f.consent, 'I agree to the Terms and Privacy Policy, and I understand this service is not for emergencies.') : [],
    go, h('button', { onclick: () => authView(reg ? 'login' : 'register') }, reg ? 'I already have an account' : 'Create an account'), reg ? [] : h('button', { onclick: forgotView }, 'Forgot password?'), out));
}

function forgotView() {
  const e = h('input', { type: 'email' }), out = h('div');
  show(h('div', { class: 'card' }, h('h2', {}, 'Reset your password'), h('p', { class: 'muted' }, 'Enter your email and we will send a reset link.'), h('label', {}, 'Email'), e,
    h('button', { class: 'p', onclick: async () => { try { msg(out, (await api('POST', '/forgot', { email: e.value })).message, true); } catch (x) { msg(out, x.message); } } }, 'Send link'), h('button', { onclick: () => authView() }, 'Back'), out));
}
function resetView(token) {
  const p = h('input', { type: 'password' }), out = h('div');
  show(h('div', { class: 'card' }, h('h2', {}, 'Choose a new password'), h('label', {}, 'New password (10+ characters)'), p,
    h('button', { class: 'p', onclick: async () => { try { msg(out, (await api('POST', '/reset', { token, password: p.value })).message, true); history.replaceState(null, '', '/'); } catch (x) { msg(out, x.message); } } }, 'Update password'), h('button', { onclick: () => { history.replaceState(null, '', '/'); init(); } }, 'Go to sign in'), out));
}

function home() {
  clearInterval(timer);
  $('#who').replaceChildren(h('span', { class: 'muted' }, me.name + ' · ' + me.role + ' '), h('button', { onclick: async () => { await api('POST', '/logout'); me = null; authView(); } }, 'Sign out'));
  ({ patient: patientView, doctor: doctorView, admin: adminView })[me.role]();
}

const upBtn = a => { const i = h('input', { type: 'file', accept: '.pdf,.png,.jpg,.jpeg', style: 'display:none', onchange: () => { const f = i.files[0]; if (!f) return; if (f.size > 3e6) return alert('File must be under 3 MB');
  const r = new FileReader(); r.onload = async () => { try { await api('POST', `/appts/${a.id}/files`, { name: f.name, data: r.result.split(',')[1] }); home(); } catch (e) { alert(e.message); } }; r.readAsDataURL(f); } });
  return [i, h('button', { onclick: () => i.click() }, 'Attach file')]; };
const fileList = a => (a.files || []).map(f => h('div', { class: 'muted' }, h('a', { href: `/api/appts/${a.id}/files/${f.id}` }, f.name), ' (' + Math.ceil(f.size / 1024) + ' KB)'));
const apptCard = (a, extra = []) => h('div', { class: 'card' }, h('h3', {}, (me.role === 'patient' ? 'Dr. ' : '') + a.other.name), h('div', { class: 'muted' }, fmt(a.time) + ' · ' + a.fee + ' fee'),
  h('span', { class: 'tag' }, a.status === 'booked' && !a.paid ? 'awaiting payment' : a.status), a.notes ? h('p', {}, h('b', {}, 'Doctor notes: '), a.notes) : [], fileList(a), a.status !== 'cancelled' ? upBtn(a) : [], extra);
const joinBtn = a => a.canJoin ? h('button', { class: 'p', onclick: () => callView(a) }, 'Join video visit') : [];
const cancelBtn = a => a.status === 'booked' ? h('button', { class: 'd', onclick: async () => { if (confirm('Cancel this appointment?')) { await api('POST', `/appts/${a.id}/cancel`); home(); } } }, 'Cancel') : [];

async function patientView() {
  const [docs, appts] = await Promise.all([api('GET', '/doctors'), api('GET', '/appts')]);
  const err = h('div');
  show(location.search.includes('paid=1') ? h('div', { class: 'card ok' }, 'Thank you. Your payment is being confirmed, and your visit will show as paid in a moment.') : [], h('h2', {}, 'My appointments'), appts.length ? appts.map(a => apptCard(a, [
    a.status === 'booked' && !a.paid ? h('button', { class: 'p', onclick: async () => { try { const r = await api('POST', `/appts/${a.id}/pay`); r.url ? location.href = r.url : home(); } catch (e) { msg(err, e.message); } } }, 'Pay ' + a.fee) : [],
    joinBtn(a), cancelBtn(a),
    a.status === 'completed' && !a.rating ? [1, 2, 3, 4, 5].map(n => h('button', { onclick: async () => { await api('POST', `/appts/${a.id}/rate`, { rating: n }); home(); } }, n + '★')) : [],
    a.rating ? h('span', { class: 'muted' }, 'Your rating: ' + a.rating + '★') : []])) : h('p', { class: 'muted' }, 'No appointments yet.'),
    err, h('h2', {}, 'Find a doctor'),
    docs.length ? docs.map(d => h('div', { class: 'card' }, h('h3', {}, 'Dr. ' + d.name), h('div', { class: 'muted' }, d.specialty + ' · ' + d.fee + ' per visit'),
      d.slots.length ? d.slots.map(s => h('button', { onclick: async () => { try { await api('POST', '/book', { doctorId: d.id, slotId: s.id }); home(); } catch (e) { msg(err, e.message); } } }, fmt(s.time))) : h('div', { class: 'muted' }, 'No open times right now.'))) : h('p', { class: 'muted' }, 'No verified doctors are available yet.'));
}

async function doctorView() {
  const [slots, appts, pay] = await Promise.all([api('GET', '/slots'), api('GET', '/appts'), api('GET', '/connect/status')]), err = h('div'), when = h('input', { type: 'datetime-local' });
  const earned = appts.reduce((t, a) => t + (a.net || 0), 0).toFixed(2);
  const payCard = pay.configured ? h('div', { class: 'card' }, h('h3', {}, 'Payouts'), h('p', { class: 'muted' }, pay.ready ? 'Payouts are active. You have earned ' + earned + ' from paid visits, after the platform fee.' : 'Set up payouts to receive money from patients. Patients can book paid visits with you after this is done.'),
    h('button', { class: pay.ready ? '' : 'p', onclick: async () => { try { location.href = (await api('POST', pay.ready ? '/connect/dashboard' : '/connect/onboard')).url; } catch (e) { alert(e.message); } } }, pay.ready ? 'Open payout dashboard' : pay.connected ? 'Continue payout setup' : 'Set up payouts')) : [];
  show(me.status !== 'approved' ? h('div', { class: 'card' }, h('h3', {}, 'Account ' + me.status), h('p', { class: 'muted' }, me.status === 'pending' ? 'An admin is verifying your license. You will appear to patients once approved.' : 'Your account was not approved. Contact support.')) : [],
    payCard, h('h2', {}, 'Add an available time'), h('div', { class: 'card' }, when, h('button', { class: 'p', onclick: async () => { try { await api('POST', '/slots', { time: new Date(when.value).toISOString() }); home(); } catch (e) { msg(err, e.message || 'Pick a date and time'); } } }, 'Add time'), err,
      slots.map(s => h('span', { class: 'tag', style: 'margin:4px 6px 0 0' }, fmt(s.time) + (s.booked ? ' (booked)' : '')))),
    h('h2', {}, 'My appointments'), appts.length ? appts.map(a => { const n = h('textarea', { rows: 3, placeholder: 'Visit notes or prescription' }); n.value = a.notes || '';
      return apptCard({ ...a, notes: '' }, [h('p', { class: 'muted' }, 'Patient: ' + a.other.name + (a.net ? ' · You receive ' + a.net : '')), joinBtn(a), cancelBtn(a),
        a.status !== 'cancelled' ? [n, h('button', { onclick: async () => { try { await api('POST', `/appts/${a.id}/notes`, { notes: n.value }); home(); } catch (e) { alert(e.message); } } }, 'Save notes and complete')] : []]); }) : h('p', { class: 'muted' }, 'No appointments yet.'));
}

async function adminView() {
  const [docs, log, sum] = await Promise.all([api('GET', '/admin/doctors'), api('GET', '/admin/audit'), api('GET', '/admin/summary')]);
  const act = (d, a) => h('button', { class: a === 'approve' ? 'p' : 'd', onclick: async () => { await api('POST', `/admin/doctors/${d.id}/${a}`); home(); } }, a === 'approve' ? 'Approve' : 'Reject');
  show(h('div', { class: 'card' }, h('h3', {}, 'Platform earnings'), h('p', { class: 'muted' }, sum.fees + ' in fees (' + sum.percent + '%) from ' + sum.visits + ' paid visits, ' + sum.gross + ' paid by patients in total.')), h('h2', {}, 'Doctor verification'), docs.length ? docs.map(d => h('div', { class: 'card' }, h('h3', {}, d.name), h('div', { class: 'muted' }, d.email + ' · ' + d.specialty + ' · License: ' + d.license), h('span', { class: 'tag' }, d.status), h('div', {}, act(d, 'approve'), act(d, 'reject')))) : h('p', { class: 'muted' }, 'No doctors have registered yet.'),
    h('h2', {}, 'Recent activity'), h('div', { class: 'card muted' }, log.map(l => h('div', {}, new Date(l.t).toLocaleString() + ' · ' + l.what))));
}

function callView(a) {
  const remote = h('video', { id: 'remote', autoplay: '', playsinline: '' }), local = h('video', { id: 'local', autoplay: '', playsinline: '', muted: '' }), wait = h('div', { id: 'wait' }, 'Waiting for the other person to join…');
  local.muted = true; const status = h('div', { class: 'muted' }), cLog = h('div', { style: 'max-height:140px;overflow:auto;margin-top:8px' }), cIn = h('input', { maxlength: 1000, placeholder: 'Type a message' });
  const addChat = (who, t) => { cLog.append(h('div', {}, h('b', {}, who + ': '), t)); cLog.scrollTop = 1e9; };
  let stream, pc, after = 0, stopped = false; const doctor = me.role === 'doctor';
  const sig = data => api('POST', `/call/${a.id}/signal`, { data }).catch(() => {});
  const newPC = () => { if (pc) pc.close(); pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }); // add a TURN server here for reliability
    stream.getTracks().forEach(t => pc.addTrack(t, stream));
    pc.onicecandidate = e => e.candidate && sig({ type: 'ice', c: e.candidate });
    pc.ontrack = e => { remote.srcObject = e.streams[0]; wait.style.display = 'none'; };
    pc.onconnectionstatechange = () => status.textContent = pc.connectionState === 'connected' ? 'Connected' : ''; };
  const handle = async d => { try {
    if (d.type === 'ready' && doctor) { newPC(); await pc.setLocalDescription(await pc.createOffer()); sig({ type: 'offer', sdp: pc.localDescription }); }
    else if (d.type === 'offer' && !doctor) { newPC(); await pc.setRemoteDescription(d.sdp); await pc.setLocalDescription(await pc.createAnswer()); sig({ type: 'answer', sdp: pc.localDescription }); }
    else if (d.type === 'answer' && doctor && pc) await pc.setRemoteDescription(d.sdp);
    else if (d.type === 'ice' && pc) await pc.addIceCandidate(d.c);
    else if (d.type === 'chat') addChat(a.other.name, String(d.text).slice(0, 1000));
  } catch {} };
  const poll = async () => { if (stopped) return; try { for (const m of await api('GET', `/call/${a.id}/signal?after=${after}`)) { after = m.n; await handle(m.data); } } catch (e) { status.textContent = e.message; } setTimeout(poll, 1000); };
  const end = () => { stopped = true; if (pc) pc.close(); if (stream) stream.getTracks().forEach(t => t.stop()); home(); };
  const tog = (kind, onT, offT) => { const b = h('button', { onclick: () => { const t = stream[kind]()[0]; t.enabled = !t.enabled; b.textContent = t.enabled ? onT : offT; } }, onT); return b; };
  show(h('h2', {}, 'Visit with ' + (doctor ? a.other.name : 'Dr. ' + a.other.name)), h('div', { class: 'stage' }, remote, wait, local), status,
    h('div', {}, '', h('button', { class: 'd', onclick: end }, 'Leave visit')),
    h('div', { class: 'card' }, h('b', {}, 'Chat'), cLog, h('div', { class: 'row' }, cIn, h('button', { class: 'p', onclick: () => { const t = cIn.value.trim(); if (!t) return; sig({ type: 'chat', text: t }); addChat('You', t); cIn.value = ''; } }, 'Send'))));
  navigator.mediaDevices.getUserMedia({ video: true, audio: true }).then(s => { stream = s; local.srcObject = s;
    root.children[3].prepend(tog('getAudioTracks', 'Mute mic', 'Unmute mic'), tog('getVideoTracks', 'Camera off', 'Camera on'));
    if (!doctor) sig({ type: 'ready' }); else sig({ type: 'hello' }); poll(); })
    .catch(() => { status.textContent = 'Camera and mic access is needed for the visit. Allow it and try again.'; });
}
init();
