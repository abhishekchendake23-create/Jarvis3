(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const KEY = 'abhynex.jarvis.v2';
const TOKEN = 'abhynex.jarvis.session';
const DEF = { lang: 'en-IN', voiceURI: '', rate: 1, autoSpeak: true, currentId: null, conversations: [], notes: [] };
const MSG = {
  unavailable: 'JARVIS is temporarily unavailable. Please try again.',
  noVoiceIn: 'Voice input is not supported by this browser. You can type your message.',
};

/* ---------- storage (no secrets: only chats + preferences) ---------- */
let S = load();
function load() { try { return Object.assign({}, DEF, JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return { ...DEF }; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* storage full/blocked */ } }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
function cur() {
  let c = S.conversations.find((x) => x.id === S.currentId);
  if (!c) { c = { id: uid(), title: 'New chat', messages: [], updated: Date.now() }; S.conversations.unshift(c); S.currentId = c.id; save(); }
  return c;
}
function addMsg(role, text, extra) {
  const c = cur();
  c.messages.push(Object.assign({ role, text, ts: Date.now() }, extra));
  if (role === 'user' && c.title === 'New chat') c.title = text.slice(0, 40);
  c.updated = Date.now();
  if (c.messages.length > 200) c.messages.splice(0, c.messages.length - 200);
  if (S.conversations.length > 50) S.conversations.length = 50;
  save();
}

/* ---------- ui helpers ---------- */
let toastT;
function toast(t) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => (el.hidden = true), 4000); }
const HINT = { IDLE: 'Tap the microphone and speak, or type below.', LISTENING: 'Listening...', THINKING: 'Thinking...', SPEAKING: 'Speaking...', ERROR: MSG.unavailable };
let state = 'IDLE';
function setState(s, hint) {
  state = s; document.body.dataset.state = s;
  $('#stateLabel').textContent = s;
  $('#stateHint').textContent = hint || HINT[s];
  $('#micBtn').setAttribute('aria-pressed', String(s === 'LISTENING'));
  $('#micBtn').setAttribute('aria-label', s === 'LISTENING' ? 'Stop listening' : 'Start voice input');
  $('#stopSpeakBtn').hidden = s !== 'SPEAKING';
}
function showView(v) {
  $$('.view').forEach((e) => e.classList.toggle('active', e.id === 'view-' + v));
  $$('.nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === v));
  if (v === 'chat') { renderChat(); scrollEnd(); }
  if (v === 'memory') renderMemory();
}
const scrollEnd = () => { const m = $('#view-chat'); requestAnimationFrame(() => (m.scrollTop = m.scrollHeight)); };
function linkify(parent, text) {
  const re = /\bhttps?:\/\/[^\s<>"']+/g; let last = 0, m;
  while ((m = re.exec(text))) {
    parent.append(text.slice(last, m.index));
    const a = document.createElement('a'); a.href = m[0]; a.textContent = m[0]; a.target = '_blank'; a.rel = 'noopener noreferrer';
    parent.append(a); last = m.index + m[0].length;
  }
  parent.append(text.slice(last));
}
function renderChat() {
  const box = $('#messages'); box.textContent = '';
  const c = cur();
  if (!c.messages.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No messages yet. Say or type something to JARVIS.'; box.append(p); }
  c.messages.forEach((m, i) => {
    const w = document.createElement('div'); w.className = 'msg ' + (m.role === 'user' ? 'user' : 'jarvis');
    const b = document.createElement('div'); b.className = 'bubble'; linkify(b, m.text); w.append(b);
    if (m.role !== 'user') {
      const a = document.createElement('div'); a.className = 'acts';
      [['copy', 'Copy'], ['speak', 'Speak'], ['stop', 'Stop']].forEach(([k, l]) => {
        const x = document.createElement('button'); x.type = 'button'; x.dataset.act = k; x.dataset.i = i; x.textContent = l; x.setAttribute('aria-label', l + ' this reply'); a.append(x);
      });
      w.append(a);
    }
    box.append(w);
  });
  const last = [...c.messages].reverse().find((m) => m.role !== 'user');
  const lr = $('#lastReply'); lr.hidden = !last; if (last) lr.textContent = last.text.length > 300 ? last.text.slice(0, 300) + '…' : last.text;
}
function showTyping() {
  const w = document.createElement('div'); w.className = 'msg jarvis'; w.id = 'typing';
  w.innerHTML = '<div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div>';
  $('#messages').append(w); scrollEnd();
}
const hideTyping = () => { const t = $('#typing'); if (t) t.remove(); };

/* ---------- API ---------- */
class AuthError extends Error {}
async function api(path, body, method) {
  const r = await fetch(path, {
    method: method || (body ? 'POST' : 'GET'),
    headers: Object.assign({ 'Content-Type': 'application/json' }, sessionStorage.getItem(TOKEN) ? { Authorization: 'Bearer ' + sessionStorage.getItem(TOKEN) } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = {}; try { j = await r.json(); } catch { /* non-json */ }
  if (r.status === 401 && path !== '/api/login') throw new AuthError();
  return { ok: r.ok, status: r.status, data: j };
}

/* ---------- speech output ---------- */
const synth = 'speechSynthesis' in window ? window.speechSynthesis : null;
let voices = [], speakToken = 0;
const FEMALE = /female|woman|zira|samantha|susan|heera|neerja|swara|aarohi|kalpana|lekha|veena|tessa|karen|fiona|moira|victoria|\bx-(ene|enf|hia|hif|mrf|mrc)|-f\b/i;
function loadVoices() { if (!synth) return; voices = synth.getVoices(); fillVoices(); }
function langVoices() {
  const p = S.lang.slice(0, 2);
  let l = voices.filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith(p));
  if (!l.length && p === 'mr') l = voices.filter((v) => v.lang.toLowerCase().startsWith('hi'));
  return l.length ? l : voices;
}
function pickVoice() {
  const l = langVoices();
  return l.find((v) => v.voiceURI === S.voiceURI) || l.find((v) => FEMALE.test(v.name + ' ' + v.voiceURI)) || l.find((v) => v.lang.toLowerCase() === S.lang.toLowerCase()) || l[0] || null;
}
function fillVoices() {
  const sel = $('#voiceSel'); sel.textContent = '';
  const auto = document.createElement('option'); auto.value = ''; auto.textContent = 'Auto (prefer female)'; sel.append(auto);
  langVoices().forEach((v) => { const o = document.createElement('option'); o.value = v.voiceURI; o.textContent = v.name + ' (' + v.lang + ')'; sel.append(o); });
  sel.value = S.voiceURI;
  if (sel.value !== S.voiceURI) sel.value = '';
}
function clean(t) { return t.replace(/https?:\/\/\S+/g, ' link ').replace(/[*_`#>~|]/g, '').replace(/\s+/g, ' ').trim(); }
function chunks(t) { const out = []; (t.match(/[^.!?।]+[.!?।]*\s*/g) || [t]).forEach((s) => { while (s.length > 180) { let k = s.lastIndexOf(' ', 180); if (k < 40) k = 180; out.push(s.slice(0, k)); s = s.slice(k); } if (s.trim()) out.push(s); }); return out; }
function speak(text) {
  if (!synth) { toast('Voice output is not available on this browser. The text reply is shown above.'); return; }
  try {
    synth.cancel();
    const parts = chunks(clean(text)); if (!parts.length) return;
    const tok = ++speakToken, v = pickVoice();
    parts.forEach((p, i) => {
      const u = new SpeechSynthesisUtterance(p);
      if (v) { u.voice = v; u.lang = v.lang; } else u.lang = S.lang;
      u.rate = S.rate; u.pitch = v && FEMALE.test(v.name) ? 1 : 1.1;
      if (i === 0) u.onstart = () => { if (tok === speakToken) setState('SPEAKING'); };
      u.onend = () => { if (tok === speakToken && i === parts.length - 1) setState('IDLE'); };
      u.onerror = () => { if (tok === speakToken) setState('IDLE'); };
      synth.speak(u);
    });
  } catch { setState('IDLE'); }
}
function stopSpeak() { speakToken++; try { synth && synth.cancel(); } catch { /* ignore */ } if (state === 'SPEAKING') setState('IDLE'); }

/* ---------- commands (browser-safe only) ---------- */
function parseCommand(raw) {
  let t = raw.replace(/^\s*(hey\s+|ok\s+)?jarvis[\s,.:!-]*/i, '').trim();
  if (!t) t = raw;
  let m = t.match(/^remember(?:\s+(?:this|that))?[\s:,-]*(.*)$/i);
  if (m) {
    const note = m[1].trim() || ([...cur().messages].reverse().find((x) => x.role !== 'user') || {}).text || '';
    if (!note) return { local: 'Tell me what to remember, for example: remember my meeting is at 5.' };
    S.notes.push({ id: uid(), text: note.slice(0, 300), ts: Date.now() }); save();
    return { local: 'Done. I will remember: ' + note.slice(0, 300) };
  }
  m = t.match(/^open\s+(?:the\s+)?(?:website\s+)?(\S+)$/i);
  if (m) {
    const d = m[1].replace(/^https?:\/\//i, '').replace(/[,.!?]+$/, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(d)) return { local: 'Tap to open: https://' + d };
    return { local: 'Tell me the full website address, like example.com, and I will give you a link to tap.' };
  }
  m = t.match(/^search(?:\s+(?:for|this|about))?[\s:,-]*(.*)$/i);
  if (m) return { text: m[1].trim() || t, search: true };
  return { text: t };
}

/* ---------- send flow ---------- */
let busy = false;
async function sendMessage(raw) {
  let text = (raw || '').trim().slice(0, 2000);
  if (!text || busy) return;
  stopSpeak();
  const cmd = parseCommand(text);
  const history = cur().messages.slice(-20).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', text: m.text }));
  addMsg('user', text);
  $('#msgInput').value = '';
  if (cmd.local) { addMsg('jarvis', cmd.local); renderChat(); scrollEnd(); finishReply(cmd.local); return; }
  busy = true; setState('THINKING'); renderChat(); showTyping();
  try {
    const r = await api('/api/chat', {
      message: cmd.text, conversation: history, language: S.lang, search: !!cmd.search,
      memory: S.notes.slice(-10).map((n) => n.text), clientTime: new Date().toString(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    hideTyping();
    const reply = r.data && r.data.reply;
    if (r.ok && r.data.success && reply) { addMsg('jarvis', reply); renderChat(); scrollEnd(); finishReply(reply); }
    else fail(reply || MSG.unavailable);
  } catch (e) {
    hideTyping();
    if (e instanceof AuthError) { lock('Session expired. Enter your passcode again.'); return; }
    fail(MSG.unavailable);
  } finally { busy = false; }
}
function finishReply(reply) {
  renderChat();
  if (S.autoSpeak && synth) speak(reply); else setState('IDLE');
}
function fail(msg) {
  addMsg('jarvis', msg); renderChat(); scrollEnd(); setState('ERROR', msg);
  setTimeout(() => { if (state === 'ERROR') setState('IDLE'); }, 4000);
}

/* ---------- voice input ---------- */
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function toggleMic() {
  if (!SR) { toast(MSG.noVoiceIn); $('#msgInput').focus(); return; }
  if (state === 'LISTENING' && rec) { rec.stop(); return; }
  if (busy) return;
  stopSpeak();
  let finalText = '', heard = false;
  rec = new SR(); rec.lang = S.lang; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
  rec.onstart = () => setState('LISTENING');
  rec.onresult = (e) => {
    let interim = ''; finalText = '';
    for (let i = 0; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += t; else interim += t; }
    heard = true; $('#msgInput').value = finalText || interim;
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') toast('Microphone permission is blocked. Allow it in Chrome site settings, or type your message.');
    else if (e.error === 'no-speech') toast('I did not hear anything. Tap the microphone and try again.');
    else if (e.error !== 'aborted') toast('Voice input failed. You can type your message.');
  };
  rec.onend = () => {
    rec = null;
    if (state === 'LISTENING') setState('IDLE');
    if (heard && finalText.trim()) sendMessage(finalText);
  };
  try { rec.start(); } catch { toast(MSG.noVoiceIn); setState('IDLE'); }
}

/* ---------- memory / settings views ---------- */
const fmt = (t) => new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
function renderMemory() {
  const h = $('#historyList'); h.textContent = '';
  const convs = S.conversations.filter((c) => c.messages.length);
  if (!convs.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'No saved conversations yet.'; h.append(p); }
  convs.forEach((c) => {
    const d = document.createElement('div'); d.className = 'item' + (c.id === S.currentId ? ' cur' : '');
    const o = document.createElement('button'); o.className = 't'; o.dataset.open = c.id;
    o.textContent = c.title; const sm = document.createElement('small'); sm.textContent = c.messages.length + ' messages · ' + fmt(c.updated); o.append(sm);
    const x = document.createElement('button'); x.className = 'x'; x.dataset.del = c.id; x.textContent = '✕'; x.setAttribute('aria-label', 'Delete conversation ' + c.title);
    d.append(o, x); h.append(d);
  });
  const n = $('#notesList'); n.textContent = '';
  if (!S.notes.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'Say "JARVIS, remember this: ..." to save a note.'; n.append(p); }
  S.notes.forEach((note) => {
    const d = document.createElement('div'); d.className = 'item';
    const t = document.createElement('div'); t.className = 'n'; t.textContent = note.text;
    const x = document.createElement('button'); x.className = 'x'; x.dataset.note = note.id; x.textContent = '✕'; x.setAttribute('aria-label', 'Delete note');
    d.append(t, x); n.append(d);
  });
}
function newChat() { stopSpeak(); const c = { id: uid(), title: 'New chat', messages: [], updated: Date.now() }; S.conversations.unshift(c); S.currentId = c.id; save(); renderChat(); showView('chat'); }
function clearAll() {
  if (!confirm('Clear all conversations and remembered notes on this device?')) return;
  stopSpeak(); S.conversations = []; S.notes = []; S.currentId = null; save(); cur(); renderChat(); renderMemory(); toast('Memory cleared.');
}
function syncSettings() {
  $('#langSel').value = S.lang; $('#rateRange').value = S.rate; $('#rateOut').textContent = Number(S.rate).toFixed(1) + 'x';
  $('#autoSpeak').checked = S.autoSpeak;
  const vt = $('#voiceToggle'); vt.textContent = S.autoSpeak ? 'Voice ON' : 'Voice OFF'; vt.setAttribute('aria-pressed', String(S.autoSpeak));
}

/* ---------- install (PWA) ---------- */
let deferred = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone;
function updateInstallUi() {
  const show = !standalone();
  $('#installBtn').hidden = !show; $('#installBtn2').hidden = !show; $('#installHelp').hidden = !show || !!deferred;
}
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; updateInstallUi(); });
window.addEventListener('appinstalled', () => { deferred = null; updateInstallUi(); toast('JARVIS installed.'); });
async function install() {
  if (deferred) { deferred.prompt(); try { await deferred.userChoice; } catch { /* ignore */ } deferred = null; updateInstallUi(); }
  else { $('#installHelp').hidden = false; showView('settings'); toast('Chrome → ⋮ → Add to Home screen'); }
}

/* ---------- lock / unlock ---------- */
function lock(msg) {
  stopSpeak(); sessionStorage.removeItem(TOKEN);
  $('#app').hidden = true; $('#lock').hidden = false; $('#lockError').textContent = msg || ''; $('#passcode').value = '';
}
function unlock() { $('#lock').hidden = true; $('#app').hidden = false; setState('IDLE'); renderChat(); syncSettings(); updateInstallUi(); fitViewport(); }

/* ---------- keyboard-safe viewport ---------- */
function fitViewport() {
  const vv = window.visualViewport; if (!vv) return;
  document.documentElement.style.setProperty('--vh', vv.height + 'px');
  document.body.classList.toggle('kb', window.innerHeight - vv.height > 150);
  window.scrollTo(0, 0);
}
if (window.visualViewport) { visualViewport.addEventListener('resize', fitViewport); visualViewport.addEventListener('scroll', fitViewport); }

/* ---------- wire up ---------- */
$('#lockForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const btn = $('#unlockBtn'); btn.disabled = true; $('#lockError').textContent = '';
  try {
    const r = await api('/api/login', { passcode: $('#passcode').value });
    if (r.ok && r.data.token) { sessionStorage.setItem(TOKEN, r.data.token); $('#passcode').value = ''; unlock(); }
    else $('#lockError').textContent = r.data.error || 'Could not sign in. Try again.';
  } catch { $('#lockError').textContent = 'Cannot reach JARVIS. Check your connection.'; }
  btn.disabled = false;
});
$('#composer').addEventListener('submit', (e) => { e.preventDefault(); sendMessage($('#msgInput').value); });
$('#micBtn').addEventListener('click', toggleMic);
$('#stopSpeakBtn').addEventListener('click', stopSpeak);
$$('.nav button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
$('#newChatBtn').addEventListener('click', newChat);
$('#historyBtn').addEventListener('click', () => showView('memory'));
$('#clearChatBtn').addEventListener('click', () => { if (confirm('Clear this chat?')) { const c = cur(); c.messages = []; c.title = 'New chat'; save(); renderChat(); } });
$('#clearAllBtn').addEventListener('click', clearAll);
$('#clearMemBtn2').addEventListener('click', clearAll);
$('#logoutBtn').addEventListener('click', () => lock(''));
$('#installBtn').addEventListener('click', install);
$('#installBtn2').addEventListener('click', install);
$('#voiceToggle').addEventListener('click', () => { S.autoSpeak = !S.autoSpeak; if (!S.autoSpeak) stopSpeak(); save(); syncSettings(); });
$('#autoSpeak').addEventListener('change', (e) => { S.autoSpeak = e.target.checked; if (!S.autoSpeak) stopSpeak(); save(); syncSettings(); });
$('#langSel').addEventListener('change', (e) => { S.lang = e.target.value; S.voiceURI = ''; save(); fillVoices(); });
$('#voiceSel').addEventListener('change', (e) => { S.voiceURI = e.target.value; save(); });
$('#rateRange').addEventListener('input', (e) => { S.rate = Number(e.target.value); $('#rateOut').textContent = S.rate.toFixed(1) + 'x'; save(); });
$('#testVoiceBtn').addEventListener('click', () => speak(S.lang === 'hi-IN' ? 'नमस्ते, मैं जार्विस हूँ।' : S.lang === 'mr-IN' ? 'नमस्कार, मी जार्विस आहे.' : 'Hello, I am JARVIS. How can I help you?'));
$('#messages').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const m = cur().messages[Number(b.dataset.i)]; if (!m) return;
  if (b.dataset.act === 'speak') speak(m.text);
  else if (b.dataset.act === 'stop') stopSpeak();
  else if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(m.text).then(() => toast('Copied.'), () => toast('Copy failed.'));
  else { const t = document.createElement('textarea'); t.value = m.text; document.body.append(t); t.select(); try { document.execCommand('copy'); toast('Copied.'); } catch { toast('Copy failed.'); } t.remove(); }
});
$('#view-memory').addEventListener('click', (e) => {
  const o = e.target.closest('[data-open]'), d = e.target.closest('[data-del]'), n = e.target.closest('[data-note]');
  if (o) { S.currentId = o.dataset.open; save(); renderChat(); showView('chat'); }
  else if (d) { S.conversations = S.conversations.filter((c) => c.id !== d.dataset.del); if (S.currentId === d.dataset.del) S.currentId = null; save(); cur(); renderMemory(); }
  else if (n) { S.notes = S.notes.filter((x) => x.id !== n.dataset.note); save(); renderMemory(); }
});
if (synth) { loadVoices(); synth.onvoiceschanged = loadVoices; }
if (!SR) $('#stateHint').textContent = 'Voice input is not supported here. Type your message below.';
if ('serviceWorker' in navigator) window.addEventListener('load', () => navigator.serviceWorker.register('/service-worker.js').catch(() => {}));

(async () => {
  if (sessionStorage.getItem(TOKEN)) { try { const r = await api('/api/session'); if (r.ok) { unlock(); return; } } catch { /* fall through */ } }
  lock('');
})();
})();
