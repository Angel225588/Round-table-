import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DEFAULT_PANEL, DEFAULT_TOPIC, MODERATOR, FALLBACK_VOICES } from './panel.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
const TTS_MODEL = process.env.ELEVENLABS_MODEL || 'eleven_v3';
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || '';
const HAS_CLAUDE = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const DEMO = process.env.DEMO === '1' || !HAS_CLAUDE;

const claude = DEMO ? null : new Anthropic();
// If a safety classifier declines a request, the API re-runs it on a fallback model in the same call.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const LANGS = { en: 'English', es: 'Spanish', fr: 'French' };
const sessions = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = (msg) => msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(here, 'public')));

app.get('/api/config', async (_req, res) => {
  let voices = FALLBACK_VOICES;
  if (ELEVEN_KEY) {
    try {
      const r = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': ELEVEN_KEY } });
      if (r.ok) {
        const list = (await r.json()).voices.map((v) => ({
          id: v.voice_id,
          name: [v.name, v.labels?.accent, v.labels?.gender].filter(Boolean).join(' · '),
        }));
        // Keep the defaults selectable even if the account list doesn't include them.
        voices = [...list, ...FALLBACK_VOICES.filter((f) => !list.some((v) => v.id === f.id))];
      }
    } catch { /* keep fallback list */ }
  }
  res.json({
    demo: DEMO, eleven: Boolean(ELEVEN_KEY), model: MODEL, ttsModel: TTS_MODEL,
    topic: DEFAULT_TOPIC, panel: DEFAULT_PANEL, moderator: MODERATOR, voices, langs: LANGS,
  });
});

// ---------- Session + parallel research ----------

app.post('/api/session', (req, res) => {
  const { topic, context = '', hostName = 'Host', lang = 'en', prepMinutes = 2, experts = [] } = req.body || {};
  if (!topic?.trim() || !experts.length) return res.status(400).json({ error: 'A topic and at least one expert are required.' });
  const session = {
    id: randomUUID(),
    topic: topic.trim(), context: context.trim(), hostName: hostName.trim() || 'Host',
    lang: LANGS[lang] ? lang : 'en',
    prepMinutes: Math.min(Math.max(Number(prepMinutes) || 2, 1), 10),
    experts: experts.slice(0, 8).map((e, i) => ({
      id: `e${i + 1}`, name: String(e.name || `Expert ${i + 1}`).trim(), role: String(e.role || '').trim(),
      persona: String(e.persona || '').trim(), voiceId: e.voiceId, color: e.color, briefing: '',
    })),
    transcript: [], events: [], listeners: new Set(), ready: false,
  };
  sessions.set(session.id, session);
  prepare(session);
  res.json({ id: session.id, experts: session.experts.map(({ briefing, ...e }) => e) });
});

function emit(session, event) {
  session.events.push(event);
  for (const send of session.listeners) send(event);
}

app.get('/api/session/:id/events', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).end();
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const send = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  session.events.forEach(send);
  session.listeners.add(send);
  req.on('close', () => session.listeners.delete(send));
});

async function prepare(session) {
  // Every expert researches at the same time, each in their own thread.
  await Promise.all(session.experts.map(async (expert) => {
    emit(session, { type: 'status', expertId: expert.id, state: 'researching', detail: 'Reading the brief' });
    try {
      expert.briefing = DEMO ? await demoResearch(session, expert) : await research(session, expert);
      emit(session, { type: 'status', expertId: expert.id, state: 'ready', briefing: expert.briefing });
    } catch (err) {
      console.error(`[prep] ${expert.name}:`, err.message);
      expert.briefing = 'No prepared notes. Speak from your professional experience and say so when you are unsure of a number.';
      emit(session, { type: 'status', expertId: expert.id, state: 'ready', briefing: `Research failed (${err.message}). This expert will speak from experience.` });
    }
  }));
  session.ready = true;
  emit(session, { type: 'ready' });
}

function researchPrompt(session, expert) {
  const others = session.experts.filter((e) => e.id !== expert.id).map((e) => `${e.name} (${e.role})`).join('; ');
  return {
    system: `You are ${expert.name}, ${expert.role}. ${expert.persona}

You have been invited to a live round-table discussion and have about ${session.prepMinutes} minutes to prepare. Research from your own professional angle so you arrive with current, specific material: real numbers, named examples and recent developments. Prefer a few strong facts over many weak ones, and note where each came from.

Then write your private prep notes, in plain text with no markdown, under 300 words, with these four sections:
MY POSITION: two sentences, opinionated.
EVIDENCE: four to six concrete facts, each with its source name.
WHERE I WILL PUSH BACK: one line on where you expect to disagree with the other panelists.
QUESTION FOR THE HOST: the one question you most need answered.

Write only the notes.`,
    user: `Round-table topic: ${session.topic}
${session.context ? `\nBackground from the host (${session.hostName}): ${session.context}\n` : ''}
Other panelists: ${others || 'none'}`,
  };
}

async function research(session, expert) {
  const { system, user } = researchPrompt(session, expert);
  const deadline = AbortSignal.timeout((session.prepMinutes + 1.5) * 60_000);
  const run = async (withSearch) => {
    const messages = [{ role: 'user', content: user }];
    for (let hop = 0; hop < 5; hop++) {
      const stream = claude.beta.messages.stream({
        model: MODEL, max_tokens: 16000, system, messages, ...FALLBACK,
        output_config: { effort: 'medium' },
        ...(withSearch && { tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: Math.min(2 + session.prepMinutes * 2, 10) }] }),
      }, { signal: deadline });
      // Surface each search query live so the prep screen shows what the expert is looking up.
      const pending = new Map();
      for await (const ev of stream) {
        if (ev.type === 'content_block_start' && ev.content_block.type === 'server_tool_use') pending.set(ev.index, '');
        else if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta' && pending.has(ev.index)) pending.set(ev.index, pending.get(ev.index) + ev.delta.partial_json);
        else if (ev.type === 'content_block_stop' && pending.has(ev.index)) {
          try {
            const query = JSON.parse(pending.get(ev.index) || '{}').query;
            if (query) emit(session, { type: 'status', expertId: expert.id, state: 'researching', detail: `Searching: ${query}` });
          } catch { /* input was not a plain search query */ }
          pending.delete(ev.index);
        }
      }
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: msg.content }); continue; }
      if (msg.stop_reason === 'refusal') throw new Error('request declined');
      emit(session, { type: 'status', expertId: expert.id, state: 'researching', detail: 'Writing notes' });
      const notes = textOf(msg);
      if (!notes) throw new Error('empty notes');
      return notes;
    }
    throw new Error('research did not finish');
  };
  try {
    return await run(true);
  } catch (err) {
    if (deadline.aborted) throw new Error('ran out of prep time');
    // Web search may be disabled for this API key: prepare from knowledge instead.
    console.warn(`[prep] ${expert.name}: search unavailable (${err.message}), preparing without it`);
    emit(session, { type: 'status', expertId: expert.id, state: 'researching', detail: 'Preparing from experience' });
    return run(false);
  }
}

// ---------- Live conversation ----------

function sceneSystem(session) {
  const lang = LANGS[session.lang];
  const dossiers = session.experts.map((e) => `@${e.id} — ${e.name}, ${e.role}
Personality: ${e.persona}
Their private prep notes:
${e.briefing}`).join('\n\n');
  return `You are writing the live dialogue of a voice round-table. Everything you write is turned into speech immediately, one voice per speaker, and played to the host, ${session.hostName}, who is on the call and can speak at any time.

Topic: ${session.topic}
${session.context ? `Background from the host: ${session.context}\n` : ''}
At the table:
@mod — ${MODERATOR.name}, the moderator. Keeps things moving, draws people in, hands the floor to the host. Has no opinions of their own.

${dossiers}

Output format, which a program parses: a line containing only @id, then that speaker's words on the following lines. Repeat for each speaker in the turn. Nothing else.

How the conversation should sound:
- Speak ${lang}. This is talk, not writing: contractions, short sentences, no lists, no markdown, no stage directions, no speaker names inside the words.
- Each speaker says one to three sentences, about 20 to 55 words. A turn has one or two speakers unless the direction says otherwise.
- Each expert stays in character and argues from their own prep notes: a specific number, a named example, a hard-won opinion. They only cite facts that are in their notes or common knowledge, and say "I'd want to check that" rather than invent one.
- Experts react to each other and to the host by name, disagree when their views differ, and never repeat a point already made.
- When the host addresses someone by name, that person answers first. When the host asks a question, answer it directly before adding anything.${TTS_MODEL === 'eleven_v3' ? '\n- Now and then, when it is natural, a speaker may include one audio tag in square brackets, such as [chuckles], [sighs] or [thoughtful]. Most utterances have none.' : ''}`;
}

const DIRECTIONS = {
  open: (s) => `The call has just connected. @mod welcomes ${s.hostName} and frames the topic in two sentences, then one expert gives the sharpest opening take, then a second expert pushes back on it. Three speakers this turn.`,
  reply: (s) => `${s.hostName} has just spoken. Respond: the most relevant expert answers directly, and a second expert may briefly add or disagree if it sharpens things.`,
  continue: (s) => `${s.hostName} is listening. Continue: one or two experts who have spoken least build on or challenge the last point. The last speaker ends with a pointed question for ${s.hostName}.`,
  wrap: (s) => `${s.hostName} is ending the call. Only @mod speaks: the three takeaways that matter most and the single next step the table would recommend, in under 110 words, then a warm goodbye.`,
};

app.post('/api/session/:id/turn', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found. Start a new table.' });
  if (!session.ready) return res.status(409).json({ error: 'The experts are still preparing.' });
  const mode = DIRECTIONS[req.body?.mode] ? req.body.mode : 'reply';
  const userText = String(req.body?.userText || '').trim();
  if (userText) session.transcript.push({ id: 'host', text: userText });

  res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  const send = (obj) => res.write(JSON.stringify(obj) + '\n');
  const abort = new AbortController();
  res.on('close', () => abort.abort());

  const valid = new Set(['mod', ...session.experts.map((e) => e.id)]);
  let current = null; // { id, text }
  let buffer = '';
  const flush = () => {
    const text = current?.text.trim();
    if (text) { session.transcript.push({ id: current.id, text }); send({ t: 'utterance', id: current.id, text }); }
    current = null;
  };
  const handleLine = (line) => {
    const tag = line.trim().match(/^@([\w-]+):?$/);
    if (tag) {
      flush();
      current = { id: valid.has(tag[1]) ? tag[1] : 'mod', text: '' };
      send({ t: 'speaker', id: current.id });
    } else if (line.trim()) {
      if (!current) { current = { id: 'mod', text: '' }; send({ t: 'speaker', id: 'mod' }); }
      const piece = (current.text ? ' ' : '') + line.trim();
      current.text += piece;
      send({ t: 'delta', id: current.id, text: piece });
    }
  };
  const feed = (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    lines.forEach(handleLine);
  };

  try {
    if (DEMO) {
      for (const chunk of demoTurn(session, mode)) { if (abort.signal.aborted) break; feed(chunk); await sleep(350); }
    } else {
      const names = Object.fromEntries([['host', session.hostName], ['mod', MODERATOR.name], ...session.experts.map((e) => [e.id, e.name])]);
      const history = session.transcript.map((t) => `${names[t.id]}: ${t.text}`).join('\n') || '(nothing yet)';
      const stream = claude.beta.messages.stream({
        model: MODEL, max_tokens: 4000, ...FALLBACK,
        output_config: { effort: 'low' },
        system: [{ type: 'text', text: sceneSystem(session), cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: `Conversation so far:\n${history}\n\nDirection for this turn: ${DIRECTIONS[mode](session)}` }],
      }, { signal: abort.signal });
      stream.on('text', feed);
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') feed('\n@mod\nLet\'s take that from a different angle. Could you rephrase the question?\n');
    }
    if (buffer) handleLine(buffer);
    flush();
    send({ t: 'done' });
  } catch (err) {
    if (!abort.signal.aborted) {
      console.error('[turn]', err.message);
      flush();
      send({ t: 'error', message: err instanceof Anthropic.RateLimitError ? 'Rate limited. Give it a few seconds and try again.' : err.message });
    }
  }
  res.end();
});

// ---------- Voice ----------

app.post('/api/tts', async (req, res) => {
  const { text, voiceId } = req.body || {};
  if (!ELEVEN_KEY) return res.status(503).json({ error: 'ELEVENLABS_API_KEY is not set.' });
  if (!text || !/^[\w-]{10,40}$/.test(voiceId || '')) return res.status(400).json({ error: 'text and a valid voiceId are required.' });
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: String(text).slice(0, 2500), model_id: TTS_MODEL }),
    });
    if (!r.ok) {
      const detail = (await r.text()).slice(0, 300);
      console.error('[tts]', r.status, detail);
      return res.status(502).json({ error: `ElevenLabs returned ${r.status}`, detail });
    }
    res.set('Content-Type', 'audio/mpeg');
    Readable.fromWeb(r.body).pipe(res);
  } catch (err) {
    console.error('[tts]', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ---------- Demo mode (no Anthropic key): scripted lines so every screen can be tried ----------

async function demoResearch(session, expert) {
  for (const detail of [`Searching: ${session.topic.slice(0, 48)}`, 'Searching: recent industry data', 'Writing notes']) {
    await sleep(500 + Math.random() * 900);
    emit(session, { type: 'status', expertId: expert.id, state: 'researching', detail });
  }
  await sleep(400);
  return `MY POSITION: (demo notes) As ${expert.role}, I have a strong view on this.\nEVIDENCE: Add ANTHROPIC_API_KEY to .env and restart to get real, web-researched notes.\nWHERE I WILL PUSH BACK: On anything that ignores my side of the business.\nQUESTION FOR THE HOST: What does success look like in twelve months?`;
}

function* demoTurn(session, mode) {
  const said = session.transcript.filter((t) => t.id !== 'host').length;
  const pick = (n) => session.experts[(said + n) % session.experts.length];
  const say = (id, text) => `@${id}\n${text}\n`;
  if (mode === 'open') {
    yield say('mod', `Welcome, ${session.hostName}. This is demo mode, so we're reading scripted lines until a Claude key is added.`);
    yield say(pick(0).id, `I'm ${pick(0).name}. With a key in place I'd open with my sharpest take on the topic, straight from my research.`);
    yield say(pick(1).id, `And I'm ${pick(1).name}. I'd be pushing back on that right about now.`);
  } else if (mode === 'wrap') {
    yield say('mod', `That's the table for today. Add your keys and we'll do this for real. Thanks, ${session.hostName}.`);
  } else {
    yield say(pick(0).id, mode === 'reply' ? 'Good point. In the real call I would answer that directly, with a number from my notes.' : 'Building on that, here is where I would add a concrete example.');
    yield say(pick(1).id, `I see it differently, and I'd say why. ${session.hostName}, what's your read?`);
  }
}

app.listen(PORT, () => {
  console.log(`Round table on http://localhost:${PORT}`);
  console.log(`  experts: ${DEMO ? 'DEMO MODE (set ANTHROPIC_API_KEY for real experts)' : MODEL}`);
  console.log(`  voices:  ${ELEVEN_KEY ? `ElevenLabs ${TTS_MODEL}` : 'browser voice (set ELEVENLABS_API_KEY for realistic voices)'}`);
});
