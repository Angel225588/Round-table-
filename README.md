# Round Table

A live voice call with a table of AI experts. You set the topic and seat the experts, they research it in parallel, then you join the call: they debate, you speak or type, they answer you.

## Run it

```bash
npm install
cp .env.example .env      # add your two keys
npm start                 # http://localhost:3000
```

| Key | What it unlocks | Without it |
|---|---|---|
| `ANTHROPIC_API_KEY` | Real experts: web research and live conversation | Demo mode with scripted lines |
| `ELEVENLABS_API_KEY` | One realistic voice per expert | The browser's built-in voice |

`npm run demo` starts demo mode on purpose, to click through the screens with no keys.

## How it works

1. **Setup.** Topic, background, your name, language (English, Spanish, French), prep time, and the experts. Each seat has a name, role, personality and voice, all editable. `panel.js` holds the default table.
2. **Prep.** Every expert researches at the same time in their own thread, using web search, and writes private notes: position, evidence with sources, where they'll push back, a question for you. The screen shows what each one is searching for, and you can read the notes.
3. **Call.** The moderator opens, experts argue from their notes. Press **Speak** (Chrome or Edge, uses the microphone) or type. Speaking interrupts whoever is talking. **Keep going** lets them continue, **Free-flow** lets them carry on for a couple of rounds unprompted, **Wrap up** gets the moderator's takeaways.

## Settings

Optional, in `.env`:

- `CLAUDE_MODEL`, default `claude-opus-5-5`.
- `ELEVENLABS_MODEL`, default `eleven_v3`. `eleven_flash_v2_5` answers faster with less expressive voices.
- `PORT`, default `3000`.

## Layout

- `server.js`: sessions, parallel research, the streamed conversation turn, the ElevenLabs proxy. Keys stay on the server.
- `panel.js`: default topic, experts, voices.
- `public/`: the three screens.

Sessions live in memory, so restarting the server ends any call in progress.

## Artifact version

`artifact/index.html` is the same app as one self-contained page for a Claude artifact. It needs no keys: the experts run on the viewer's Claude plan, with Claude's built-in voices and dictation. It has no web search, so experts prepare from what Claude knows, and it does not use ElevenLabs.

## ElevenLabs voice call

The artifact's prep screen has a "Join the voice call" link. It opens an ElevenLabs agent ("Expert Round Table") and passes the host, topic, invited experts, their voices and their prep notes as dynamic variables (`var_host_name`, `var_topic`, `var_context`, `var_roster`, `var_table`). The agent speaks for every expert, switching voice per speaker, and runs on ElevenLabs credits with no Anthropic key.

## French agents

- "Table ronde (FR)": receives the table from the artifact through dynamic variables.
- "Table ronde à la voix (FR)": starts by asking the caller for the subject and participants. Its prompt is `elevenlabs/table-ronde-prompt.md`; the researched dossiers in `research/` are inserted into it.
