import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test as nodeTest } from "node:test";

const test = (name, check) => nodeTest(name, { timeout: 1500 }, check);
import vm from "node:vm";

// Exercise the browser's actual classes without exporting them or loading keys.
// Boundaries fail loudly if app sections are renamed or reorganized.
const source = readFileSync(process.env.ALLIGATOR_TEST_APP || new URL("../public/app.js", import.meta.url), "utf8");
function section(from, to) {
  const start = source.indexOf(from);
  const end = source.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `Missing app section: ${from}`);
  return source.slice(start, end);
}
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const flush = () => new Promise(setImmediate);

class Element {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.className = "";
    this.textContent = "";
    this.listeners = {};
    this.scrollHeight = this.scrollTop = this.clientHeight = 0;
    this.classList = {
      contains: (c) => this.className.split(" ").includes(c),
      add: (c) => { if (!this.classList.contains(c)) this.className += ` ${c}`; },
      remove: (c) => { this.className = this.className.split(" ").filter((x) => x !== c).join(" "); },
      toggle: (c, on) => on ? this.classList.add(c) : this.classList.remove(c),
    };
  }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  after(n) { n.parent = this.parent; this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, n); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
  querySelector(selector) {
    const matches = (n) => selector.split(".").slice(1).every((c) => n.classList.contains(c));
    for (const n of this.children) {
      if (matches(n)) return n;
      const found = n.querySelector(selector);
      if (found) return found;
    }
    return null;
  }
  closest(selector) { return this.classList.contains(selector.slice(1)) ? this : this.parent?.closest(selector); }
  setAttribute(k, v) { this[k] = v; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
  focus() {}
  get lastElementChild() { return this.children.at(-1); }
  get previousElementSibling() { return this.parent.children[this.parent.children.indexOf(this) - 1]; }
}

function transcriptHarness() {
  const pane = (lang) => {
    const p = new Element(); p.lang = lang;
    const feed = new Element(); feed.className = "feed"; p.append(feed); return p;
  };
  const context = vm.createContext({
    document: { createElement: (tag) => new Element(tag) },
    ui: { paneA: pane("en"), paneB: pane("es"), paneS: pane(""), save: {} },
    body: { dataset: { state: "live" } }, prefs: { a: "en", b: "es" },
    LANGS: { en: [], es: [], ja: [] }, RTL: new Set(), SPLIT_AFTER_CHARS: 240, SENTENCE_END: /[.!?。！？…][”"'»)\]]*\s*$/u,
    SPEAKER_COLORS: ["blue", "green"],
  });
  vm.runInContext(section("class Transcript {", "const transcript =") + "globalThis.transcript = new Transcript();", context);
  return context;
}
const original = (text, is_final = true) => ({ text, is_final, language: "en", speaker: "1", translation_status: "original" });
const translation = (text, is_final = true) => ({ text, is_final, language: "es", source_language: "en", speaker: "1", translation_status: "translation" });

for (const view of [0, 2]) {
  for (const action of ["Enter", "Escape", "blur"]) {
    test(`incoming tokens while renaming in view ${view}, then ${action}`, () => {
      const { transcript: t } = transcriptHarness();
      t.ingest([original("Hello"), translation("Hola")]);
      const el = t.turns[0].els[view];
      t.rename("0:1", el.querySelector(".who"));
      const input = el.querySelector(".who-edit");
      input.value = "Alex";
      t.ingest([original(" world"), translation(" mundo"), original("!", false)]);
      assert.equal(t.turns[0].els[0].querySelector(".f").textContent, "Hello world");
      assert.equal(t.turns[0].els[2].querySelector(".src").children[1].textContent, "Hello world");
      assert.equal(t.turns[0].els[2].querySelector(".dst").children[1].textContent, "Hola mundo");
      if (action === "blur") input.listeners.blur();
      else input.listeners.keydown({ key: action, stopPropagation() {} });
      assert.equal(el.querySelector(".who-edit"), null);
      assert.equal(t.speakerName(t.turns[0]), action === "Escape" ? "Speaker 1" : "Alex");
      assert.match(t.toText(), /Hello world/);
    });
  }
}

function audioHarness(failure, gates = {}) {
  const track = () => ({ stopped: false, stop() { this.stopped = true; } });
  const micTrack = track(), tabTrack = track(), videoTrack = track();
  const mic = { getTracks: () => [micTrack] };
  const display = { getAudioTracks: () => [tabTrack], getVideoTracks: () => [videoTrack], getTracks: () => [tabTrack, videoTrack] };
  const contexts = [];
  class AudioContext {
    constructor() {
      this.state = "running";
      this.audioWorklet = { addModule: async () => { if (gates.module) await gates.module; if (failure === "module") throw new Error("module failed"); } };
      contexts.push(this);
    }
    createMediaStreamSource() { return { connect() {} }; }
    createGain() { return { gain: {}, connect() {} }; }
    async resume() { if (gates.resume) await gates.resume; if (failure === "resume") throw new Error("resume failed"); }
    async close() { this.state = "closed"; }
  }
  class Worklet {
    constructor() { if (failure === "worklet") throw new Error("worklet failed"); this.port = {}; }
    connect(sink) { return sink; }
  }
  const devices = { getDisplayMedia: async () => display, getUserMedia: async () => {
    if (failure === "mic") throw new Error("mic denied"); return mic;
  } };
  const context = vm.createContext({ navigator: { mediaDevices: devices }, AudioContext, AudioWorkletNode: Worklet,
    MediaStream: class { constructor(tracks) { this.getTracks = () => tracks; } } });
  vm.runInContext(section("async function openAudio(", "// ───────────────────────── Soniox session"), context);
  return { ...context, devices, mic, display, contexts, micTrack, tabTrack, videoTrack };
}
for (const failure of ["mic", "module", "worklet", "resume"]) {
  test(`capture startup cleans up after ${failure} failure`, async () => {
    const h = audioHarness(failure);
    await assert.rejects(h.openAudio("meeting", () => {}), /denied|failed/);
    assert.ok(h.tabTrack.stopped && h.videoTrack.stopped);
    if (failure !== "mic") assert.ok(h.micTrack.stopped);
    assert.ok(h.contexts.every((ctx) => ctx.state === "closed"));
  });
}
for (const permission of ["getDisplayMedia", "getUserMedia"]) {
  test(`Stop during pending ${permission} releases streams returned later`, async () => {
    const h = audioHarness(); const pending = deferred(); const abort = new AbortController();
    h.devices[permission] = () => pending.promise;
    const opening = h.openAudio("meeting", () => {}, abort.signal);
    await flush(); abort.abort();
    if (permission === "getUserMedia") assert.ok(h.tabTrack.stopped && h.videoTrack.stopped);
    pending.resolve(permission === "getDisplayMedia" ? h.display : h.mic);
    await assert.rejects(opening, { name: "AbortError" });
    assert.ok(h.tabTrack.stopped && h.videoTrack.stopped);
    if (permission === "getUserMedia") assert.ok(h.micTrack.stopped);
    assert.equal(h.contexts.length, 0);
  });
}
test("successful capture closes all tracks and its audio context on abort", async () => {
  const h = audioHarness(); const abort = new AbortController();
  const audio = await h.openAudio("meeting", () => {}, abort.signal);
  abort.abort();
  assert.ok(h.micTrack.stopped && h.tabTrack.stopped && h.videoTrack.stopped);
  assert.equal(h.contexts[0].state, "closed");
  audio.close();
});

function sessionHarness(overrides = {}) {
  const sockets = [], states = [], errors = [], timers = [];
  class WebSocket {
    static OPEN = 1;
    constructor(url, protocols) { this.url = url; this.protocols = protocols; this.readyState = 0; this.sent = []; sockets.push(this); }
    send(data) { this.sent.push(data); }
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const audio = { closed: false, close() { this.closed = true; } };
  const context = vm.createContext({
    AbortController, WebSocket, Int16Array, SONIOX_WS: "wss://stt-rt.soniox.com/transcribe-websocket",
    MODEL: "stt-rt-v5", KEEPALIVE_MS: 10000, MAX_RECONNECTS: 3,
    transcript: { newEpoch() {}, clearDrafts() {}, closeTurn() {}, ingest() {} },
    openAudio: async () => audio, getStreamKey: async () => "snx_temp_synthetic",
    setTimeout: (fn) => { timers.push(fn); return fn; },
    setInterval: (fn) => fn, clearInterval() {}, friendlyError: () => "Authentication failed",
    ...overrides,
  });
  vm.runInContext(section("class Session {", "function friendlyError") + "globalThis.Session = Session;", context);
  const s = new context.Session({ a: "en", b: "es", source: "room", diarize: true });
  s.onState = (state) => states.push(state); s.onError = (message) => errors.push(message);
  return { context, s, sockets, states, errors, timers, audio };
}

test("Stop during startup closes late audio without opening a socket", async () => {
  const pending = deferred(); const h = sessionHarness({ openAudio: () => pending.promise });
  const starting = h.s.start(); await h.s.stop(); pending.resolve(h.audio); await flush();
  h.sockets.forEach((ws) => ws.open()); await starting;
  assert.ok(h.audio.closed); assert.equal(h.sockets.length, 0);
  assert.deepEqual(h.states, ["stopping", "idle"]);
});
test("Stop during key minting prevents a late socket", async () => {
  const pending = deferred(); const h = sessionHarness({ getStreamKey: () => pending.promise });
  const starting = h.s.start(); await flush(); await h.s.stop();
  pending.resolve("snx_temp_late"); await starting;
  assert.equal(h.sockets.length, 0); assert.ok(h.audio.closed);
  assert.deepEqual(h.states, ["stopping", "idle"]);
});
test("Stop during socket handshake settles startup and ignores a late open", async () => {
  const h = sessionHarness(); const starting = h.s.start(); await flush();
  await h.s.stop(); h.sockets[0].open(); await starting;
  assert.equal(h.sockets[0].sent.length, 0); assert.equal(h.sockets[0].readyState, 3);
  assert.deepEqual(h.states, ["stopping", "idle"]);
});
test("close before socket open rejects startup without scheduling reconnect", async () => {
  const h = sessionHarness(); const starting = h.s.start(); await flush(); h.sockets[0].close();
  await assert.rejects(starting, /reach Soniox/); h.s.teardown();
  assert.equal(h.timers.length, 0); assert.ok(h.audio.closed);
});
test("Stop during reconnect delay prevents another connection", async () => {
  const h = sessionHarness(); const starting = h.s.start(); await flush(); h.sockets[0].open(); await starting;
  h.sockets[0].close(); await h.s.stop(); h.timers.shift()(); await flush();
  assert.equal(h.sockets.length, 1); assert.equal(h.states.at(-1), "idle");
});
test("Stop during reconnect key minting prevents another connection", async () => {
  const h = sessionHarness(); const starting = h.s.start(); await flush(); h.sockets[0].open(); await starting;
  const key = deferred(); h.context.getStreamKey = () => key.promise;
  h.sockets[0].close(); h.timers.shift()(); await flush(); await h.s.stop(); key.resolve("snx_temp_late"); await flush();
  assert.equal(h.sockets.length, 1); assert.equal(h.states.at(-1), "idle");
});
test("normal pause/resume and Stop flush remain intact", async () => {
  const h = sessionHarness(); const starting = h.s.start(); await flush(); h.sockets[0].open(); await starting;
  const ws = h.sockets[0]; h.s.pause();
  assert.equal(ws.sent[1].byteLength, 9600); assert.deepEqual(JSON.parse(ws.sent[2]), { type: "finalize" });
  h.s.keepalive(); assert.deepEqual(JSON.parse(ws.sent[3]), { type: "keepalive" }); h.s.resume();
  const stopping = h.s.stop(); assert.equal(ws.sent.at(-1), "");
  ws.onmessage({ data: JSON.stringify({ finished: true }) }); await stopping;
  assert.ok(h.audio.closed); assert.equal(ws.readyState, 3);
  assert.deepEqual(h.states, ["live", "paused", "live", "stopping", "idle"]);
});

test("cancelled controller startup cannot tear down a newer session", async () => {
  const old = deferred(); const instances = [];
  class Session {
    constructor() { this.pending = instances.length ? deferred() : old; instances.push(this); }
    start() { return this.pending.promise; }
    teardown() { this.tornDown = true; this.onState("idle"); }
  }
  const context = vm.createContext({
    navigator: { mediaDevices: { getUserMedia() {} } }, prefs: { source: "room" },
    hasAnyKey: () => true, clock: {}, transcript: { addBreak() {}, closeTurn() {} }, autosave: { begin() {} }, Session,
    body: { style: { setProperty() {} } }, setState: () => {}, toast() {}, KeyError: class extends Error {},
  });
  vm.runInContext("let session = null;\n" + section("async function start() {", "ui.main.addEventListener") + "globalThis.getSession = () => session;", context);
  const first = context.start();
  instances[0].stopping = true; instances[0].onState("idle");
  const second = context.start();
  old.reject(new Error("late failure")); await first;
  assert.equal(context.getSession(), instances[1]); assert.ok(!instances[1].tornDown);
  instances[1].pending.resolve(); await second;
});

for (const path of ["temporary", "direct", "server"]) {
  test(`connection authentication with ${path} key, including reconnect`, async () => {
    const requests = [];
    let minted = 0;
    const keys = vm.createContext({
      SONIOX_API: "https://api.soniox.com/v1", KEY_PREF: "alligator.apiKey",
      serverHasKey: path === "server",
      store: { get: () => path === "server" ? "" : "synthetic-user-key" },
      fetch: async (url, options) => {
        requests.push({ url, options }); minted++;
        return { ok: path !== "direct", status: path === "direct" ? 403 : 200,
          json: async () => ({ api_key: `snx_temp_synthetic_${minted}` }) };
      },
    });
    vm.runInContext(section("class KeyError extends Error", "const hasAnyKey"), keys);
    const h = sessionHarness({ getStreamKey: keys.getStreamKey });
    const starting = h.s.start(); await flush(); h.sockets[0].open(); await starting;
    h.sockets[0].close(); h.timers.shift()(); await flush(); h.sockets[1].open(); await flush();
    for (let i = 0; i < h.sockets.length; i++) {
      const ws = h.sockets[i];
      assert.deepEqual(Array.from(ws.protocols), ["soniox-api-key", path === "direct" ? "synthetic-user-key" : `snx_temp_synthetic_${i + 1}`]);
      assert.equal(ws.url, "wss://stt-rt.soniox.com/transcribe-websocket");
      const config = JSON.parse(ws.sent[0]);
      assert.ok(!Object.hasOwn(config, "api_key"));
      assert.equal(config.model, "stt-rt-v5");
      assert.deepEqual(config.translation, { type: "two_way", language_a: "en", language_b: "es" });
      assert.equal(config.enable_speaker_diarization, true);
      assert.equal(config.enable_endpoint_detection, false);
      assert.ok(!ws.sent[0].includes("synthetic"));
    }
    assert.equal(requests.length, 2);
    assert.ok(requests.every((r) => r.url === (path === "server" ? "api/temporary-key" : "https://api.soniox.com/v1/auth/temporary-api-key")));
    if (path !== "server") {
      assert.equal(requests[0].options.headers.Authorization, "Bearer synthetic-user-key");
      assert.deepEqual(JSON.parse(requests[0].options.body), { usage_type: "transcribe_websocket", expires_in_seconds: 60, single_use: true });
    }
    h.s.teardown();
  });
}
test("authentication error frame after open stops capture without retry", async () => {
  const h = sessionHarness(); const starting = h.s.start(); await flush(); h.sockets[0].open(); await starting;
  h.sockets[0].onmessage({ data: JSON.stringify({ error_code: 401, error_type: "unauthenticated" }) });
  h.sockets[0].close();
  assert.deepEqual(h.errors, ["Authentication failed"]);
  assert.ok(h.audio.closed); assert.equal(h.states.at(-1), "idle");
  assert.equal(h.timers.length, 0);
});

for (const stage of ["module", "resume"]) {
  test(`Stop while audio ${stage} is pending closes capture immediately`, async () => {
    const pending = deferred(); const h = audioHarness(undefined, { [stage]: pending.promise });
    const abort = new AbortController(); const opening = h.openAudio("meeting", () => {}, abort.signal);
    await flush(); abort.abort();
    assert.ok(h.micTrack.stopped && h.tabTrack.stopped && h.videoTrack.stopped);
    assert.equal(h.contexts[0].state, "closed");
    pending.resolve(); await assert.rejects(opening, { name: "AbortError" });
  });
}
test("meeting selection without audio closes the display before reporting failure", async () => {
  const h = audioHarness(); h.display.getAudioTracks = () => [];
  await assert.rejects(h.openAudio("meeting", () => {}), /No meeting audio/);
  assert.ok(h.videoTrack.stopped); assert.equal(h.contexts.length, 0);
});
test("retired sockets cannot append transcript or update input levels", async () => {
  let ingested = 0, levels = 0;
  const h = sessionHarness({ transcript: { newEpoch() {}, clearDrafts() {}, ingest() { ingested++; } } });
  h.s.onLevel = () => levels++;
  const starting = h.s.start(); await flush(); h.sockets[0].open(); await starting; h.s.teardown();
  h.sockets[0].onmessage({ data: JSON.stringify({ tokens: [original("Synthetic late text")] }) });
  h.s.onFrame({ pcm: new ArrayBuffer(2), level: 1 });
  assert.equal(ingested, 0); assert.equal(levels, 0);
});

const speech = (text, speaker, language = "en") => ({
  text, speaker, language, is_final: true, translation_status: "original",
});
const translated = (text, speaker, source_language = "en", is_final = true) => ({
  text, speaker, source_language, language: source_language === "en" ? "es" : "en",
  is_final, translation_status: "translation",
});

test("a delayed translation with a speaker can find its source beyond four turns", () => {
  const { transcript: t } = transcriptHarness();
  for (let speaker = 1; speaker <= 7; speaker++) t.ingest([speech(`Message ${speaker}.`, String(speaker))]);
  t.ingest([translated("Traducción del primer mensaje.", "1")]);
  assert.equal(t.turns[0].trans, "Traducción del primer mensaje.");
  for (const turn of t.turns.slice(1)) assert.equal(turn.trans, "");
});

test("an unknown speaker retains the owner-approved best-effort language fallback", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("A message.", "1")]);
  t.ingest([translated("Un mensaje.", "9")]);
  assert.equal(t.turns[0].trans, "Un mensaje.");
});

test("a speaker-tagged translation keeps multiple sentences on its unique source", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("Hello. How are you?", "1"), translated("Hola.", "1")]);
  t.ingest([speech("My turn.", "2"), translated(" ¿Cómo estás?", "1")]);
  assert.equal(t.turns[0].trans, "Hola. ¿Cómo estás?");
  assert.equal(t.turns[1].trans, "");
});

test("speakerless delayed second sentence stays with the multi-sentence source", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("Hello. How are you?", "1"), translated("Hola.")]);
  t.ingest([speech("My turn.", "2"), translated(" ¿Cómo estás?")]);
  t.ingest([translated("Mi turno.")]);
  assert.equal(t.turns[0].trans, "Hola. ¿Cómo estás?");
  assert.equal(t.turns[1].trans, "Mi turno.");
  assert.equal(t.turns[0].els[1].querySelector(".f").textContent, "Hola. ¿Cómo estás?");
  assert.equal(t.turns[0].els[2].querySelector(".dst").children[1].textContent, "Hola. ¿Cómo estás?");
  assert.match(t.toText(), /Hola\. ¿Cómo estás\?/);
});

test("a trailing source fragment also waits for its translation", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("Hello. Another thought", "1"), translated("Hola.")]);
  t.ingest([speech("Next speaker.", "2"), translated(" Otro pensamiento.")]);
  assert.equal(t.turns[0].trans, "Hola. Otro pensamiento.");
  assert.equal(t.turns[1].trans, "");
});

test("speakerless translations can catch up over more than four waiting turns", () => {
  const { transcript: t } = transcriptHarness();
  for (let i = 1; i <= 7; i++) t.ingest([speech(`Message ${i}.`, String(i))]);
  for (let i = 1; i <= 7; i++) t.ingest([translated(`Mensaje ${i}.`)]);
  assert.deepEqual(Array.from(t.turns, (turn) => turn.trans), Array.from({ length: 7 }, (_, i) => `Mensaje ${i + 1}.`));
});

test("speaker-tagged repeated turns still use the source's full sentence progress", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("First. Second?", "1"), translated("Primero.", "1")]);
  t.ingest([speech("Interruption.", "2"), speech("Third.", "1")]);
  t.ingest([translated(" ¿Segundo?", "1"), translated("Tercero.", "1")]);
  assert.equal(t.turns[0].trans, "Primero. ¿Segundo?");
  assert.equal(t.turns[1].trans, "");
  assert.equal(t.turns[2].trans, "Tercero.");
});

test("provisional translation completion is replaced without moving later finals", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("First. Second?", "1"), translated("Primero.")]);
  t.ingest([speech("Next turn.", "2"), translated(" ¿Segundo?", undefined, "en", false), translated("Siguiente.", undefined, "en", false)]);
  assert.equal(t.turns[0].transP, " ¿Segundo?");
  assert.equal(t.turns[1].transP, "Siguiente.");
  t.ingest([translated(" Segundo", undefined, "en", false)]);
  assert.equal(t.turns[0].transP, " Segundo");
  assert.equal(t.turns[1].transP, "");
  t.ingest([translated(" ¿Segundo?"), translated("Siguiente.")]);
  assert.equal(t.turns[0].trans, "Primero. ¿Segundo?");
  assert.equal(t.turns[1].trans, "Siguiente.");
  assert.equal(t.turns[0].transP + t.turns[1].transP, "");
});

test("bidirectional translation backlogs remain separate", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("Hello. How are you?", "1"), translated("Hola.")]);
  t.ingest([speech("Bien. ¿Y tú?", "2", "es"), speech("Wait.", "3")]);
  t.ingest([translated("Fine.", undefined, "es"), translated(" ¿Cómo estás?")]);
  t.ingest([translated(" And you?", undefined, "es"), translated("Espera.")]);
  assert.equal(t.turns[0].trans, "Hola. ¿Cómo estás?");
  assert.equal(t.turns[1].trans, "Fine. And you?");
  assert.equal(t.turns[2].trans, "Espera.");
});

test("a reconnect starts a new matching epoch without changing old translations", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("First. Still waiting?", "1"), translated("Primero.")]);
  t.clearDrafts(); t.newEpoch();
  t.ingest([speech("New stream.", "1"), translated("Nueva conexión.")]);
  assert.equal(t.turns[0].trans, "Primero.");
  assert.equal(t.turns[1].trans, "Nueva conexión.");
});

test("language-native sentence endings work without spaces between sentences", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("こんにちは。元気ですか？", "1", "ja"), translated("Hello.", undefined, "ja")]);
  t.ingest([speech("次です。", "2", "ja"), translated(" How are you?", undefined, "ja"), translated("Next.", undefined, "ja")]);
  assert.equal(t.turns[0].trans, "Hello. How are you?");
  assert.equal(t.turns[1].trans, "Next.");
});

test("an unfinished translation prevents premature splitting of a long monologue", () => {
  const { transcript: t } = transcriptHarness();
  const first = `${"This is a long sentence with several words ".repeat(6)}. Another sentence?`;
  t.ingest([speech(first, "1"), translated("Una frase.", "1")]);
  t.ingest([speech(" A continuation.", "1")]);
  assert.equal(t.turns.length, 1);
  t.ingest([translated(" ¿Otra frase? Una continuación.", "1"), speech(" A new turn.", "1")]);
  assert.equal(t.turns.length, 2);
});

test("the sentence estimate treats decimal punctuation as part of a sentence", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("It costs 3.50 dollars.", "1"), speech("Next speaker.", "2")]);
  t.ingest([translated("Cuesta 3,50 dólares."), translated("Siguiente persona.")]);
  assert.equal(t.turns[0].trans, "Cuesta 3,50 dólares.");
  assert.equal(t.turns[1].trans, "Siguiente persona.");
});

test("speaker metadata can advance the stream without reopening an older backlog", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([speech("First. Second?", "1"), translated("Primero.")]);
  t.ingest([speech("New turn.", "2"), translated("Nuevo", "2")]);
  t.ingest([translated(" turno.")]);
  assert.equal(t.turns[0].trans, "Primero.");
  assert.equal(t.turns[1].trans, "Nuevo turno.");
});

test("sentence-progress fallback works when Intl.Segmenter is unavailable", () => {
  const h = transcriptHarness(); vm.runInContext("Intl.Segmenter = undefined;", h);
  const t = h.transcript;
  t.ingest([speech("First. Second?", "1"), translated("Primero.")]);
  t.ingest([speech("Next turn.", "2"), translated(" ¿Segundo?"), translated("Siguiente.")]);
  assert.equal(t.turns[0].trans, "Primero. ¿Segundo?");
  assert.equal(t.turns[1].trans, "Siguiente.");
});

test("untranslated source turns do not consume delayed translations", () => {
  const { transcript: t } = transcriptHarness();
  t.ingest([{ ...speech("Untranslated text.", "1"), translation_status: "none" }]);
  t.ingest([speech("Translate this.", "2"), translated("Traduce esto.")]);
  assert.equal(t.turns[0].trans, "");
  assert.equal(t.turns[1].trans, "Traduce esto.");
});

// Session lock: language pair and audio source can't change mid-session,
// whether by mouse, keyboard or a stray event.
function lockHarness(state) {
  const control = (extra = {}) => ({
    disabled: false, listeners: {}, attrs: {},
    addEventListener(k, fn) { this.listeners[k] = fn; },
    setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; },
    ...extra,
  });
  const sources = [control({ dataset: { source: "room" } }), control({ dataset: { source: "meeting" } })];
  const groups = [control(), control()];
  const context = vm.createContext({
    body: { dataset: { state } },
    ui: { langA: control({ value: "en" }), langB: control({ value: "es" }), swap: control() },
    prefs: { a: "en", b: "es", source: "room" },
    applied: 0,
    document: {
      querySelectorAll: (sel) => (sel === ".source button" ? sources : sel === ".pair, .source" ? groups : []),
    },
  });
  vm.runInContext("function applyPrefs() { applied++; }", context);
  vm.runInContext(section("// ── Session lock ──", "// ───────────────────────── Options"), context);
  return { context, sources, groups };
}

test("session lock disables the language and source controls while a session runs", () => {
  for (const state of ["connecting", "live", "paused", "stopping"]) {
    const { context, sources, groups } = lockHarness(state);
    vm.runInContext("syncSessionLock()", context);
    const { ui } = context;
    assert.ok([ui.langA, ui.langB, ui.swap, ...sources].every((c) => c.disabled), `controls disabled when ${state}`);
    assert.ok(groups.every((g) => g.attrs["aria-disabled"] === "true"), `groups marked when ${state}`);
  }
  const { context, sources, groups } = lockHarness("idle");
  for (const c of [context.ui.langA, sources[0]]) c.disabled = true;
  groups[0].attrs["aria-disabled"] = "true";
  vm.runInContext("syncSessionLock()", context);
  assert.ok([context.ui.langA, context.ui.langB, context.ui.swap, ...sources].every((c) => !c.disabled));
  assert.ok(groups.every((g) => !("aria-disabled" in g.attrs)));
});

test("session lock refuses language, swap and source changes mid-session and allows them when idle", () => {
  const { context, sources } = lockHarness("live");
  const { ui, prefs } = context;
  ui.langA.value = "ja";
  ui.langA.listeners.change();
  ui.swap.listeners.click();
  sources[1].listeners.click();
  assert.deepEqual({ ...prefs }, { a: "en", b: "es", source: "room" });
  assert.equal(ui.langA.value, "en", "picker restored to the running language");
  assert.equal(context.applied, 0);

  context.body.dataset.state = "idle";
  ui.langA.value = "ja";
  ui.langA.listeners.change();
  ui.swap.listeners.click();
  sources[1].listeners.click();
  assert.deepEqual({ ...prefs }, { a: "es", b: "ja", source: "meeting" });
  assert.equal(context.applied, 3);
});

const ja = (text, speaker = "1") => ({ text, is_final: true, language: "ja", speaker, translation_status: "original" });
const toEn = (text, speaker = "1") => ({ text, is_final: true, language: "en", source_language: "ja", speaker, translation_status: "translation" });
const en = (text, speaker = "2") => ({ text, is_final: true, language: "en", speaker, translation_status: "original" });
const toJa = (text, speaker = "2") => ({ text, is_final: true, language: "ja", source_language: "en", speaker, translation_status: "translation" });

function jaEnTranscript() {
  const h = transcriptHarness();
  Object.assign(h.prefs, { a: "ja", b: "en" });
  h.ui.paneA.lang = "ja"; h.ui.paneB.lang = "en";
  return h.transcript;
}
const stamp = String.raw`\*\*\[\d{2}:\d{2}:\d{2}\]`;

test("Markdown transcript as spoken tags every turn with its language", () => {
  const t = jaEnTranscript();
  t.ingest([ja("おはようございます。"), toEn("Good morning."), en("Hello.", "2"), toJa("こんにちは。")]);
  t.names.set(t.speakerKey(t.turns[1]), "Me");
  const md = t.toMarkdown(0);
  assert.match(md, new RegExp(`^${stamp} Speaker 1\\*\\* \\(JA\\)\\nおはようございます。\\n\\n${stamp} Me\\*\\* \\(EN\\)\\nHello\\.$`));
});

test("Markdown transcript in one language marks translated and untranslated turns", () => {
  const t = jaEnTranscript();
  t.ingest([ja("おはようございます。"), toEn("Good morning."), en("Hello.", "2"), toJa("こんにちは。"), ja("失礼します。", "3")]);
  const md = t.toMarkdown(0, "en").split("\n\n");
  assert.match(md[0], new RegExp(`^${stamp} Speaker 1\\*\\* \\(from JA\\)\\nGood morning\\.$`));
  assert.match(md[1], new RegExp(`^${stamp} Speaker 2\\*\\*\\nHello\\.$`));
  assert.match(md[2], new RegExp(`^${stamp} Speaker 3\\*\\* \\(JA, untranslated\\)\\n失礼します。$`));
});

test("Markdown transcript starts at the given turn and leaves out drafts", () => {
  const t = jaEnTranscript();
  t.ingest([ja("前の会話です。"), toEn("An earlier talk.")]);
  const from = t.committed;
  t.newEpoch();
  t.ingest([ja("新しい会話です。"), toEn("A new talk."), { ...ja("まだ"), is_final: false }]);
  const md = t.toMarkdown(from, "en");
  assert.doesNotMatch(md, /earlier|まだ/);
  assert.match(md, /A new talk\./);
});

test("transcript store names files by start time and pair, and writes both", async () => {
  const { mkdtemp, readdir, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { transcriptStore } = await import("../transcripts.js");
  const dir = await mkdtemp(`${tmpdir()}/alligator-`);
  const store = transcriptStore(dir, "en");
  const first = await store.create({ a: "ja", b: "en" });
  const second = await store.create({ a: "ja", b: "en" });
  assert.match(first.id, /^\d{4}-\d{2}-\d{2} \d{4} ja-en$/);
  assert.equal(second.id, `${first.id} (2)`);
  await store.write(first.id, { lang: "en", original: "said\n", translation: "english\n" });
  await store.write(first.id, { lang: "en", original: "said more\n", translation: "english more\n" });
  assert.equal(await readFile(`${dir}/${first.id} original.md`, "utf8"), "said more\n");
  assert.equal(await readFile(`${dir}/${first.id} en.md`, "utf8"), "english more\n");
  assert.deepEqual((await readdir(dir)).filter((f) => f.startsWith(".")), [], "no temp file left behind");
});

test("transcript store refuses ids it did not issue and malformed bodies", async () => {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { transcriptStore } = await import("../transcripts.js");
  const store = transcriptStore(await mkdtemp(`${tmpdir()}/alligator-`), "en");
  const body = { lang: "en", original: "", translation: "" };
  await assert.rejects(store.write("../../etc/passwd", body), (e) => e.status === 404);
  await assert.rejects(store.create({ a: "../x", b: "en" }), (e) => e.status === 400);
  const { id } = await store.create({ a: "ja", b: "en" });
  await assert.rejects(store.write(id, { ...body, lang: "../x" }), (e) => e.status === 400);
  await assert.rejects(store.write(id, { ...body, original: 5 }), (e) => e.status === 400);
  assert.throws(() => transcriptStore("/tmp", "english"));
});

function autosaveHarness(respond) {
  const requests = [], timers = [], toasts = [];
  const context = vm.createContext({
    transcript: { committed: 3, toMarkdown: (from, lang) => `${lang ?? "orig"} from ${from}` },
    fetch: async (url, opts) => { const r = { url, ...opts, body: JSON.parse(opts.body) }; requests.push(r); return respond(r); },
    setTimeout: (fn) => { timers.push(fn); return fn; }, clearTimeout() {},
    toast: (m) => toasts.push(m), addEventListener() {},
  });
  vm.runInContext(section("const AUTOSAVE_MS", "// ───────────────────────── Controller") + "globalThis.autosave = autosave;", context);
  context.autosave.lang = "en";
  return { autosave: context.autosave, requests, timers, toasts };
}
const reply = (status, body = {}) => ({ ok: status < 300, status, json: async () => body });

test("autosave writes this session's turns in the server's language, one write at a time", async () => {
  let release;
  const h = autosaveHarness((r) => r.method === "POST" ? reply(200, { id: "2026-10-29 1031 ja-en" })
    : new Promise((ok) => (release = () => ok(reply(200)))));
  h.autosave.begin({ a: "ja", b: "en" });
  h.autosave.schedule(); h.autosave.schedule();
  assert.equal(h.timers.length, 1, "changes within the interval share one write");
  const first = h.autosave.flush(); await flush();
  const second = h.autosave.flush(); await flush();
  assert.equal(h.requests.filter((r) => r.method === "PUT").length, 1, "second write waits for the first");
  release(); await flush(); release(); await first; await second;
  const puts = h.requests.filter((r) => r.method === "PUT");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].url, "api/transcripts/2026-10-29%201031%20ja-en");
  assert.deepEqual(puts[0].body, { lang: "en", original: "orig from 3\n", translation: "en from 3\n" });
});

test("autosave falls back to the pair's second language and recovers from a server restart", async () => {
  let ids = 0, lost = true;
  const h = autosaveHarness((r) => {
    if (r.method === "POST") return reply(200, { id: `t${++ids}` });
    if (lost) { lost = false; return reply(404, { error: "Unknown transcript." }); }
    return reply(200);
  });
  h.autosave.begin({ a: "ja", b: "es" });
  await h.autosave.flush();
  const puts = h.requests.filter((r) => r.method === "PUT");
  assert.deepEqual(puts.map((r) => r.url), ["api/transcripts/t1", "api/transcripts/t2"]);
  assert.equal(puts[1].body.lang, "es");
  assert.deepEqual(h.toasts, []);
});

test("autosave is off when the server keeps no transcripts, and warns once on failure", async () => {
  const off = autosaveHarness(() => reply(200));
  off.autosave.lang = null;
  off.autosave.begin({ a: "ja", b: "en" }); off.autosave.schedule(); await off.autosave.flush();
  assert.equal(off.requests.length, 0);
  const failing = autosaveHarness((r) => r.method === "POST" ? reply(200, { id: "t" }) : reply(500, { error: "disk full" }));
  failing.autosave.begin({ a: "ja", b: "en" });
  await failing.autosave.flush(); await failing.autosave.flush();
  assert.equal(failing.toasts.length, 1);
  assert.match(failing.toasts[0], /disk full/);
});
