# Alligator

**Two-way live speech translation for conversations and online meetings.**

**Use it now: [alligator.chat](https://alligator.chat)**. There's nothing to download. Open the link in Chrome or Edge, press play, and paste your Soniox API key when asked; the app walks you through getting one. To keep Alligator in your Dock or Start menu, click **Install** in the address bar (on iPhone and iPad: Share → **Add to Home Screen**).

Alligator listens to a conversation, either people in the room or a meeting in another browser tab, and shows what each person says alongside its translation, live. It's built on the Soniox real-time API (`stt-rt-v5`, `translation.type = "two_way"`).

- **Side by side** (the default view): one pane per language. Each pane shows the whole conversation in that language. What was said in that language appears as-is (● filled dot), and what the other side said appears translated (○ ring).
- **Stacked:** a single centred column. Each turn shows what was said, with its translation right underneath in italics.
- **Pop-out:** the ⧉ button next to play opens a small window that stays on top of everything, including Google Meet, Microsoft Teams and the Zoom desktop app, so you can read the conversation while you're in the meeting. It has its own pause and stop buttons. Chrome and Edge on a computer only.
- **Speakers:** voices are told apart automatically (speaker diarization). Each speaker gets a colour and a label such as **Speaker 1**; click a label to give that speaker a name.

### Why "Alligator"?

Because it sounds like *translator*. Say them back to back: **alligator**, **translator**. Once you hear it, you can't un-hear it. 🐊 (Click the gator logo in the app for the same story.)

## Private by design

- **Nothing is stored.** Alligator has no servers of its own, no accounts, no database and no analytics. Conversations exist only on screen until you close the page, unless you choose *Save transcript*, which downloads a file to your device.
- **Audio goes straight to Soniox.** The browser sends speech directly to Soniox for transcription and translation; it never passes through Alligator. Soniox [states](https://soniox.com/docs/security-and-privacy) that it doesn't store real-time audio or transcripts and doesn't train on customer data.
- **Your key and settings stay on your device.** They're kept in your browser's local storage, and you can remove the key at any time in Options.
- **No third-party requests.** Fonts and icons are served with the app itself. The only other site the page talks to is Soniox.
- **Open source.** The code is all here, under the [MIT License](LICENSE).

## Run it yourself

The hosted version is just the `public/` folder served as static files. GitHub Pages publishes it on every push to `main` (see `.github/workflows/pages.yml`). Any static host works the same way.

To run it locally (Node 20.6+, no dependencies):

```bash
npm start                   # → http://localhost:5173
```

To preview the UI without a key, open `http://localhost:5173/#demo`. It replays a short three-person English/Spanish conversation.

### Where the API key lives

- **Each person's own key (default).** The key is saved in that browser only (`localStorage`). For each session, the browser trades it with Soniox for a 60-second, single-use key and streams with that. If the key lacks the **Temporary API keys** permission, the browser streams with the key itself. Either way, the key goes only to Soniox.
- **One key on the server (optional).** When you run `server.js` for people who shouldn't need their own key, set `SONIOX_API_KEY` in `.env` (see `.env.example`). The server then mints the short-lived keys, and its key never reaches the browser. A key someone adds in Options takes priority over the server's.

### Saving transcripts on the server (optional)

Set `TRANSCRIPT_DIR` when you run `server.js`, and every session's transcript is kept up to date in that folder while it runs, a few seconds behind the screen. Each session writes two Markdown files, named by its start time and language pair:

- `2026-10-29 1031 ja-en original.md`: what was said, in the language it was said in, each turn tagged `(JA)` or `(EN)`.
- `2026-10-29 1031 ja-en en.md`: the whole conversation in `TRANSCRIPT_LANG` (default `en`; the pair's second language when the pair doesn't include it). Translated turns are tagged `(from JA)`.

Only committed text is written, and speaker names you set later still reach the files until the next Play. Without `TRANSCRIPT_DIR`, nothing is stored, as above. Anyone who can reach the server can start a transcript there, so keep such a server on a private network.

## Use

| Control                      | What it does                                                             |
| ---------------------------- | ------------------------------------------------------------------------ |
| Language pair                | Pick both languages; ⇄ swaps them. Locked while a session runs.          |
| In the room / Online meeting | Where the audio comes from (see below).                                  |
| ▶ / ❚❚                       | Start, pause and resume. **Space** does the same.                        |
| ■                            | End the session. **Esc** does the same.                                  |
| Speaker label                | Click to rename that speaker everywhere. **Enter** saves, **Esc** cancels. |
| ⧉ Pop out                    | Moves the conversation into a small always-on-top window (Chrome and Edge on desktop). Press again, or close that window, to bring it back. |
| Options (sliders icon)       | **View:** Side by side or Stacked. **Transcript size:** Small, Medium or Large (the original size and default), including the pop-out. **Appearance:** Auto (follows your system), Light or Dark. **Tell speakers apart:** turns speaker diarization on or off; the ⓘ explains it in plain language. **Soniox API key:** add, change or remove your key, with step-by-step help. Your choices are remembered in this browser. |
| Save transcript              | Appears once a session ends and downloads a `.txt` file with timestamps and speaker names. |

**In the room:** only the microphone is used. On a phone or tablet in portrait, the top pane turns 180° so you can lay the device flat between two people, each reading their own half.

**Online meeting:** the microphone is mixed with the meeting's audio. After you press play, the browser asks you to share a screen. Pick the Meet/Teams/Zoom **browser tab** and turn on **Share tab audio**.

- Use Chrome or Edge on desktop. Safari and Firefox can't capture tab audio.
- For a desktop meeting app (Zoom or Teams): on Windows, share _Entire screen_ with _Share system audio_. On macOS, browsers can't capture system audio, so join the meeting in a browser tab instead.
- Headphones prevent the room microphone from picking up the meeting a second time.

## How it works

```
mic (+ tab audio) → AudioWorklet → 16 kHz PCM s16le → wss://stt-rt.soniox.com/transcribe-websocket
                                                                ↓ tokens
                         pane A  ←  Transcript (turns)  →  pane B
```

- **`server.js`** (optional) serves `public/`, plus `GET /api/status` and `POST /api/temporary-key` when it holds a key.
- **`public/sw.js`** is a service worker that lets the installed app open offline. It handles only the app's own files, network first, and never touches Soniox traffic.
- **`public/pcm-worklet.js`** downmixes and resamples audio to 16 kHz mono PCM, sent in 100 ms frames. It also reports the input level used for the halo around the play button.
- **`public/app.js`**
  - WebSocket authentication: the browser sends `["soniox-api-key", key]` as connection subprotocols, using the temporary key (or the user's own key in the existing HTTP 403 fallback). The start message contains no `api_key`. This follows Soniox's [authentication migration](https://soniox.com/docs/guides/migrate-websocket-authentication) ahead of the January 15, 2027 cutoff for message-based authentication.
  - Session config: two-way translation, language hints for the pair, and `enable_speaker_diarization` from the Options switch. With diarization off, endpoint detection comes back on to split turns at natural pauses. The setting is part of a stream's setup, so changing it mid-session applies from the next Play.
  - Views: every turn has an element in each view (pane A, pane B and the stacked column). Switching views is instant and keeps the transcript. Where the browser supports View Transitions, view and theme changes crossfade.
  - Endpoint detection is off while diarization is on, because Soniox notes that early finalization makes speaker attribution less accurate. A new turn starts when the speaker or the language changes. A long monologue is split at a sentence end after about 240 characters, once its translation has caught up.
  - Token handling: final tokens are committed. Non-final tokens are drawn as a lighter layer that each message replaces. Speech in a language outside the pair is shown untranslated, with a language tag.
  - Translation tokens arrive after the speech they translate, sometimes several turns later. Matching considers all source turns in the current stream, preferring the token's speaker when available. Otherwise it uses source language and sentence progress: a multi-sentence turn waits for more than its first translated sentence. Provisional text is replaced without changing committed matching progress. This is best-effort: Soniox provides no timestamps or source-turn IDs for translations, and translations can split or combine sentences, so some attribution can still be wrong.
  - Speaker numbers restart with every new Soniox stream: each Play, and each automatic reconnect. Names you give apply to the stream they were given in.
  - **Pause** sends about 300 ms of silence and then `{"type":"finalize"}`, so the sentence in progress settles. It then sends `{"type":"keepalive"}` every 10 s, which makes resuming instant. Soniox bills for the whole time the stream is open, including pauses.
  - **Stop** sends an empty frame and waits for `finished`.
  - If the connection drops, the app reconnects up to 3 times with a new key and keeps the transcript.
  - A screen wake lock keeps the display on during a session.

## Regression checks

Run `npm test` with Node.js 20.6+; no dependencies, API key, microphone, or network are needed. The checks exercise the app's actual transcript, capture, and session code with simulated browser APIs, including startup cancellation, partial capture failures, speaker renaming during incoming text, and WebSocket authentication. They do not replace real Chrome/Edge and Soniox session testing.
