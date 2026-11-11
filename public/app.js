const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids);
  return node;
};
const COLORS = ['#6ea8fe', '#f58fb0', '#7fd8a6', '#f2a65a', '#b79cf7', '#5fd0d6', '#e8d26a', '#ef8a7a'];
const SPEECH_LANG = { en: 'en-US', es: 'es-ES', fr: 'fr-FR' };
const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
const stripTags = (text) => text.replace(/\[[^\]]{1,30}\]\s*/g, '').trim();

let config;
let draft = [];        // experts being edited on the setup screen
let session = null;    // { id, people: {id: {name, role, voiceId, color}}, lang, hostName }

// ---------- Setup ----------

init();
async function init() {
  config = await (await fetch('/api/config')).json();
  $('topic').value = config.topic;
  for (const [code, name] of Object.entries(config.langs)) $('lang').append(el('option', { value: code, textContent: name }));
  const badges = $('badges');
  badges.append(config.demo
    ? el('span', { className: 'badge warn', textContent: 'Demo mode: add ANTHROPIC_API_KEY for real experts' })
    : el('span', { className: 'badge', textContent: `Experts: ${config.model}` }));
  badges.append(config.eleven
    ? el('span', { className: 'badge', textContent: `Voices: ElevenLabs ${config.ttsModel}` })
    : el('span', { className: 'badge warn', textContent: 'Browser voice: add ELEVENLABS_API_KEY' }));
  draft = structuredClone(config.panel);
  renderDraft();
}

function renderDraft() {
  const wrap = $('experts');
  wrap.replaceChildren(...draft.map((expert, i) => {
    const field = (label, key, tag = 'input', extra = {}) => {
      const input = el(tag, { value: expert[key] || '', ...extra });
      input.addEventListener('input', () => { expert[key] = input.value; });
      return el('label', {}, label, input);
    };
    const voice = el('select');
    for (const v of config.voices) voice.append(el('option', { value: v.id, textContent: v.name, selected: v.id === expert.voiceId }));
    voice.addEventListener('change', () => { expert.voiceId = voice.value; });
    const remove = el('button', { className: 'remove', type: 'button', textContent: 'Remove' });
    remove.addEventListener('click', () => { draft.splice(i, 1); renderDraft(); });
    const card = el('div', { className: 'card' }, remove,
      field('Name', 'name'), field('Role', 'role'),
      field('Personality and point of view', 'persona', 'textarea', { rows: 4 }),
      el('label', {}, 'Voice', voice));
    card.style.setProperty('--c', expert.color);
    return card;
  }));
  $('addExpert').disabled = draft.length >= 8;
}

$('addExpert').addEventListener('click', () => {
  draft.push({ name: '', role: '', persona: '', voiceId: config.voices[draft.length % config.voices.length].id, color: COLORS[draft.length % COLORS.length] });
  renderDraft();
});

$('start').addEventListener('click', async () => {
  const experts = draft.filter((e) => e.name.trim());
  const error = $('setupError');
  error.hidden = true;
  if (!$('topic').value.trim() || !experts.length) {
    error.textContent = 'Add a topic and at least one named expert.';
    error.hidden = false;
    return;
  }
  $('start').disabled = true;
  const body = {
    topic: $('topic').value, context: $('context').value, hostName: $('hostName').value || 'Host',
    lang: $('lang').value, prepMinutes: Number($('prep').value), experts,
  };
  try {
    const r = await fetch('/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    const people = { mod: config.moderator, host: { name: body.hostName, role: 'You', color: '#e9ecf3' } };
    for (const e of data.experts) people[e.id] = e;
    session = { id: data.id, people, experts: data.experts, lang: body.lang, hostName: body.hostName };
    showPrep(body.prepMinutes);
  } catch (err) {
    error.textContent = err.message;
    error.hidden = false;
    $('start').disabled = false;
  }
});

// ---------- Prep ----------

function showPrep(minutes) {
  $('setup').hidden = true;
  $('prepScreen').hidden = false;
  $('prepSub').textContent = `Each expert is researching the topic on their own, in parallel, for up to ${minutes} minute${minutes > 1 ? 's' : ''}.`;
  const cards = {};
  $('prepCards').replaceChildren(...session.experts.map((e) => {
    const state = el('div', { className: 'state' }, el('span', { className: 'spinner' }), el('span', { textContent: 'Taking a seat' }));
    const card = el('div', { className: 'card' }, el('h3', { textContent: e.name }), el('div', { className: 'role', textContent: e.role }), state);
    card.style.setProperty('--c', e.color);
    cards[e.id] = { card, state };
    return card;
  }));
  const source = new EventSource(`/api/session/${session.id}/events`);
  source.onmessage = (msg) => {
    const ev = JSON.parse(msg.data);
    if (ev.type === 'status') {
      const { card, state } = cards[ev.expertId];
      if (ev.state === 'ready') {
        card.classList.add('ready');
        state.replaceChildren('Ready');
        if (!card.querySelector('details')) card.append(el('details', {}, el('summary', { textContent: 'Prep notes' }), el('pre', { textContent: ev.briefing })));
      } else {
        state.lastChild.textContent = ev.detail;
      }
    } else if (ev.type === 'ready') {
      source.close();
      $('join').disabled = false;
      $('join').textContent = 'Join the call';
    }
  };
}

$('join').addEventListener('click', () => {
  $('prepScreen').hidden = true;
  $('call').hidden = false;
  buildTable();
  runTurn('open');
});

// ---------- Call ----------

const seats = {};
function buildTable() {
  const order = ['mod', ...session.experts.map((e) => e.id)];
  const total = order.length + 1; // the host sits at the bottom
  const place = (id, slot) => {
    const person = session.people[id];
    const angle = Math.PI / 2 + (2 * Math.PI * slot) / total;
    const seat = el('div', { className: 'seat' },
      el('div', { className: 'avatar', textContent: initials(person.name) }),
      el('div', { className: 'name', textContent: person.name }),
      el('div', { className: 'role', textContent: person.role }));
    seat.style.left = `${50 + 44 * Math.cos(angle)}%`;
    seat.style.top = `${50 + 41 * Math.sin(angle)}%`;
    seat.style.setProperty('--c', person.color);
    $('table').append(seat);
    seats[id] = seat;
  };
  place('host', 0);
  order.forEach((id, i) => place(id, i + 1));
}

function setSpeaking(id) {
  for (const [key, seat] of Object.entries(seats)) seat.classList.toggle('speaking', key === id);
}
function setCaption(id, text) {
  $('caption').replaceChildren(...(id ? [el('small', { textContent: session.people[id].name }), stripTags(text)] : []));
}
function logLine(id, text = '') {
  const span = el('span', { textContent: text });
  const line = el('div', { className: `line ${id === 'host' ? 'host' : ''}` }, el('b', { textContent: session.people[id].name }), span);
  line.style.setProperty('--c', session.people[id].color);
  $('log').append(line);
  $('log').scrollTop = $('log').scrollHeight;
  return span;
}

// One turn = one streamed response that may contain several speakers.
// Each finished utterance is sent for speech right away and played back in order.
let turn = null;       // { abort, queue, streaming, mode }
let playing = null;    // { audio } or { synth: true }
let autoStreak = 0;
let voiceProblem = null; // set when ElevenLabs rejects a request

function stopEverything() {
  if (turn) { turn.abort.abort(); turn.queue.length = 0; turn = null; }
  if (playing?.audio) { playing.audio.pause(); playing.resolve(); }
  speechSynthesis?.cancel();
  playing = null;
  setSpeaking(null);
}

async function runTurn(mode, userText = '') {
  stopEverything();
  const mine = { abort: new AbortController(), queue: [], streaming: true, mode, player: null };
  turn = mine;
  if (userText) { logLine('host', userText); autoStreak = 0; }
  $('status').textContent = 'The table is thinking…';
  let span = null;
  try {
    const r = await fetch(`/api/session/${session.id}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, userText }), signal: mine.abort.signal,
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const raw of lines.filter(Boolean)) {
        const ev = JSON.parse(raw);
        if (ev.t === 'speaker') span = logLine(ev.id);
        else if (ev.t === 'delta') { span.textContent = stripTags(span.textContent + ev.text); $('log').scrollTop = $('log').scrollHeight; }
        else if (ev.t === 'utterance') {
          mine.queue.push({ id: ev.id, text: ev.text, audio: fetchSpeech(ev.id, ev.text, mine.abort.signal) });
          mine.player ??= playQueue(mine);
        } else if (ev.t === 'error') throw new Error(ev.message);
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') $('status').textContent = `Something went wrong: ${err.message}`;
  }
  mine.streaming = false;
  mine.player ??= playQueue(mine);
}

function fetchSpeech(id, text, signal) {
  if (!config.eleven) return Promise.resolve(null);
  return fetch('/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voiceId: session.people[id].voiceId }), signal,
  }).then(async (r) => {
    if (r.ok) return r.blob();
    // Fall back to the browser voice, and say why once.
    const { error, detail = '' } = await r.json().catch(() => ({}));
    voiceProblem ??= /payment/i.test(detail) ? 'ElevenLabs reports an unpaid invoice on this account' : (error || 'ElevenLabs voice failed');
    return null;
  }).catch(() => null);
}

async function playQueue(mine) {
  while (turn === mine) {
    const item = mine.queue.shift();
    if (!item) {
      if (!mine.streaming) break;
      await new Promise((r) => setTimeout(r, 80));
      continue;
    }
    const blob = await item.audio;
    if (turn !== mine) return;
    setSpeaking(item.id);
    setCaption(item.id, item.text);
    $('status').textContent = '';
    await (blob ? playBlob(blob) : speakWithBrowser(item.text));
  }
  if (turn !== mine) return;
  turn = null;
  setSpeaking(null);
  if (mine.mode === 'wrap') { $('status').textContent = 'Call ended. The transcript is on the right.'; return; }
  $('status').textContent = voiceProblem
    ? `Using the browser voice: ${voiceProblem}.`
    : 'Your turn. Speak, type, or let them keep going.';
  // Free-flow: the experts carry on by themselves for a couple of rounds, then wait for the host.
  if ($('auto').checked && autoStreak < 2) {
    autoStreak++;
    setTimeout(() => { if (!turn && !listening) runTurn('continue'); }, 1200);
  }
}

function playBlob(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const done = () => { URL.revokeObjectURL(url); resolve(); };
    playing = { audio, resolve: done };
    audio.onended = done;
    audio.onerror = done;
    audio.play().catch(done);
  });
}

function speakWithBrowser(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return setTimeout(resolve, 1500 + text.length * 35);
    const utter = new SpeechSynthesisUtterance(stripTags(text));
    utter.lang = SPEECH_LANG[session.lang];
    utter.onend = utter.onerror = resolve;
    playing = { synth: true };
    speechSynthesis.speak(utter);
    // Some browsers never fire onend when no voice is installed.
    setTimeout(resolve, 4000 + text.length * 90);
  });
}

// ---------- Host input ----------

$('say').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('sayText').value.trim();
  if (!text) return;
  $('sayText').value = '';
  runTurn('reply', text);
});
$('continue').addEventListener('click', () => { autoStreak = 0; runTurn('continue'); });
$('end').addEventListener('click', () => {
  $('auto').checked = false;
  runTurn('wrap');
});

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let listening = null;
if (!Recognition) $('mic').hidden = true;
$('mic').addEventListener('click', () => {
  if (listening) return listening.stop();
  stopEverything(); // speaking up interrupts the table
  const rec = new Recognition();
  rec.lang = SPEECH_LANG[session.lang];
  rec.interimResults = true;
  let heard = '';
  rec.onresult = (e) => {
    heard = Array.from(e.results).map((r) => r[0].transcript).join(' ');
    $('sayText').value = heard;
  };
  rec.onerror = (e) => { $('status').textContent = e.error === 'not-allowed' ? 'Microphone access was blocked. You can type instead.' : `Didn't catch that (${e.error}).`; };
  rec.onend = () => {
    listening = null;
    $('mic').classList.remove('listening');
    $('mic').textContent = 'Speak';
    if (heard.trim()) { $('sayText').value = ''; runTurn('reply', heard.trim()); }
  };
  listening = rec;
  $('mic').classList.add('listening');
  $('mic').textContent = 'Listening… tap to send';
  $('status').textContent = '';
  rec.start();
});
