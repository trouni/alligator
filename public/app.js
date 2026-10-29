// Alligator — two-way live translation on the Soniox real-time WebSocket API.
//
// Audio path:  mic (+ meeting tab audio) → AudioWorklet (16 kHz PCM s16le) → Soniox
// Text path:   Soniox token stream → Transcript (turns) → side-by-side panes or one stacked column

const SONIOX_WS = "wss://stt-rt.soniox.com/transcribe-websocket";
const MODEL = "stt-rt-v5";
const KEEPALIVE_MS = 10_000; // docs: at least once every 20 s while no audio is sent
const MAX_RECONNECTS = 3;

// Soniox translation languages (docs: /translation/supported-languages), shown by autonym.
const LANGS = {
  af: ["Afrikaans", "Afrikaans"],
  sq: ["Albanian", "Shqip"],
  ar: ["Arabic", "العربية"],
  az: ["Azerbaijani", "Azərbaycanca"],
  eu: ["Basque", "Euskara"],
  be: ["Belarusian", "Беларуская"],
  bn: ["Bengali", "বাংলা"],
  bs: ["Bosnian", "Bosanski"],
  bg: ["Bulgarian", "Български"],
  ca: ["Catalan", "Català"],
  zh: ["Chinese", "中文"],
  hr: ["Croatian", "Hrvatski"],
  cs: ["Czech", "Čeština"],
  da: ["Danish", "Dansk"],
  nl: ["Dutch", "Nederlands"],
  en: ["English", "English"],
  et: ["Estonian", "Eesti"],
  fi: ["Finnish", "Suomi"],
  fr: ["French", "Français"],
  gl: ["Galician", "Galego"],
  de: ["German", "Deutsch"],
  el: ["Greek", "Ελληνικά"],
  gu: ["Gujarati", "ગુજરાતી"],
  he: ["Hebrew", "עברית"],
  hi: ["Hindi", "हिन्दी"],
  hu: ["Hungarian", "Magyar"],
  id: ["Indonesian", "Bahasa Indonesia"],
  it: ["Italian", "Italiano"],
  ja: ["Japanese", "日本語"],
  kn: ["Kannada", "ಕನ್ನಡ"],
  kk: ["Kazakh", "Қазақ тілі"],
  ko: ["Korean", "한국어"],
  lv: ["Latvian", "Latviešu"],
  lt: ["Lithuanian", "Lietuvių"],
  mk: ["Macedonian", "Македонски"],
  ms: ["Malay", "Bahasa Melayu"],
  ml: ["Malayalam", "മലയാളം"],
  mr: ["Marathi", "मराठी"],
  no: ["Norwegian", "Norsk"],
  fa: ["Persian", "فارسی"],
  pl: ["Polish", "Polski"],
  pt: ["Portuguese", "Português"],
  pa: ["Punjabi", "ਪੰਜਾਬੀ"],
  ro: ["Romanian", "Română"],
  ru: ["Russian", "Русский"],
  sr: ["Serbian", "Српски"],
  sk: ["Slovak", "Slovenčina"],
  sl: ["Slovenian", "Slovenščina"],
  es: ["Spanish", "Español"],
  sw: ["Swahili", "Kiswahili"],
  sv: ["Swedish", "Svenska"],
  tl: ["Tagalog", "Tagalog"],
  ta: ["Tamil", "தமிழ்"],
  te: ["Telugu", "తెలుగు"],
  th: ["Thai", "ไทย"],
  tr: ["Turkish", "Türkçe"],
  uk: ["Ukrainian", "Українська"],
  ur: ["Urdu", "اردو"],
  vi: ["Vietnamese", "Tiếng Việt"],
  cy: ["Welsh", "Cymraeg"],
};
const RTL = new Set(["ar", "he", "fa", "ur"]);
const autonym = (code) => LANGS[code]?.[1] ?? code.toUpperCase();

const $ = (sel) => document.querySelector(sel);
const body = document.body;
const ui = {
  langA: $("#lang-a"),
  langB: $("#lang-b"),
  swap: $("#swap"),
  main: $("#main"),
  stop: $("#stop"),
  clock: $("#clock"),
  status: $("#status"),
  save: $("#save"),
  toast: $("#toast"),
  paneA: $("#pane-a"),
  paneB: $("#pane-b"),
  paneS: $("#pane-s"),
  optsBtn: $("#opts-btn"),
  opts: $("#opts"),
  diarSwitch: $("#opt-diar"),
  diarNote: $("#opt-diar-note"),
  keyBtn: $("#opt-key"),
  keyNote: $("#opt-key-note"),
  keySheet: $("#key-sheet"),
  keyForm: $("#key-form"),
  keyInput: $("#key-input"),
  keyShow: $("#key-show"),
  keyStatus: $("#key-status"),
  keyLead: $("#key-lead"),
  keyHowto: $("#key-howto"),
  keyRemove: $("#key-remove"),
  keyCancel: $("#key-cancel"),
  keySave: $("#key-save"),
  mark: $("#mark"),
  stage: $(".stage"),
  pop: $("#pop"),
  popped: $("#popped"),
  popBack: $("#pop-back"),
  nameNote: $("#name-note"),
  aboutSheet: $("#about-sheet"),
  aboutClose: $("#about-close"),
};

// ───────────────────────── Preferences ─────────────────────────

const store = {
  get(k, d) {
    try {
      return localStorage.getItem(k) ?? d;
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
  remove(k) {
    try {
      localStorage.removeItem(k);
    } catch {}
  },
};

const browserLang = (navigator.language || "en").slice(0, 2);
const prefs = {
  a: store.get("alligator.a", LANGS[browserLang] ? browserLang : "en"),
  b: store.get("alligator.b", browserLang === "es" ? "en" : "es"),
  source: store.get("alligator.source", "room"),
  layout: store.get("alligator.layout", "split"), // "split" | "stacked"
  textSize: store.get("alligator.textSize", "large"), // today's size is the maximum
  theme: store.get("alligator.theme", "auto"), // "auto" | "light" | "dark"
  diarize: store.get("alligator.diarize", "on") !== "off", // label who is speaking
};
if (prefs.a === prefs.b) prefs.b = prefs.a === "en" ? "es" : "en";
if (!["small", "medium", "large"].includes(prefs.textSize)) prefs.textSize = "large";

function fillSelect(select, value) {
  const opts = Object.entries(LANGS)
    .sort((x, y) => x[1][0].localeCompare(y[1][0]))
    .map(
      ([code, [en, native]]) =>
        new Option(en === native ? en : `${native} — ${en}`, code),
    );
  select.replaceChildren(...opts);
  select.value = value;
}

function applyPrefs() {
  ui.langA.value = prefs.a;
  ui.langB.value = prefs.b;
  for (const side of ["a", "b"]) {
    const code = prefs[side];
    // The stacked pane may be in the pop-out window, so label it directly too.
    [...document.querySelectorAll(`[data-for="${side}"]`), ...ui.paneS.querySelectorAll(`[data-for="${side}"]`)]
      .forEach((el) => (el.textContent = autonym(code)));
    const pane = side === "a" ? ui.paneA : ui.paneB;
    pane.lang = code;
    pane.dir = RTL.has(code) ? "rtl" : "ltr";
  }
  body.dataset.source = prefs.source;
  document
    .querySelectorAll(".source button")
    .forEach((b) =>
      b.setAttribute("aria-checked", String(b.dataset.source === prefs.source)),
    );
  body.dataset.layout = prefs.layout;
  body.dataset.textSize = prefs.textSize;
  if (prefs.theme === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = prefs.theme;
  renderOptions();
  syncPip();
  store.set("alligator.a", prefs.a);
  store.set("alligator.b", prefs.b);
  store.set("alligator.source", prefs.source);
  store.set("alligator.layout", prefs.layout);
  store.set("alligator.textSize", prefs.textSize);
  store.set("alligator.theme", prefs.theme);
  store.set("alligator.diarize", prefs.diarize ? "on" : "off");
  transcript.rerender();
  setStatus();
}

fillSelect(ui.langA, prefs.a);
fillSelect(ui.langB, prefs.b);

// ── Session lock ──
// The language pair and audio source are part of a running stream's setup, so
// they're locked until it stops: disabled for mouse, keyboard and screen
// readers alike, with the handlers refusing changes as a second line of defence.
const sessionLocked = () => body.dataset.state !== "idle";

function syncSessionLock() {
  const locked = sessionLocked();
  for (const el of [ui.langA, ui.langB, ui.swap, ...document.querySelectorAll(".source button")]) {
    el.disabled = locked;
  }
  for (const group of document.querySelectorAll(".pair, .source")) {
    if (locked) group.setAttribute("aria-disabled", "true");
    else group.removeAttribute("aria-disabled");
  }
}

ui.langA.addEventListener("change", () => pickLang("a", ui.langA.value));
ui.langB.addEventListener("change", () => pickLang("b", ui.langB.value));
ui.swap.addEventListener("click", () => {
  if (sessionLocked()) return;
  [prefs.a, prefs.b] = [prefs.b, prefs.a];
  applyPrefs();
});
document.querySelectorAll(".source button").forEach((b) =>
  b.addEventListener("click", () => {
    if (sessionLocked()) return;
    prefs.source = b.dataset.source;
    applyPrefs();
  }),
);

function pickLang(side, code) {
  if (sessionLocked()) {
    // Put the pickers back to what the running stream is using.
    ui.langA.value = prefs.a;
    ui.langB.value = prefs.b;
    return;
  }
  const other = side === "a" ? "b" : "a";
  if (prefs[other] === code) prefs[other] = prefs[side]; // picking the other side's language swaps them
  prefs[side] = code;
  applyPrefs();
}

// ───────────────────────── Options ─────────────────────────

function renderOptions() {
  ui.opts.querySelectorAll(".seg").forEach((seg) => {
    const value = prefs[seg.dataset.pref];
    seg.querySelectorAll("button").forEach((b) => {
      const on = b.dataset.value === value;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
  });
  ui.diarSwitch.setAttribute("aria-checked", String(prefs.diarize));
  // Diarization is part of the stream's setup, so a change mid-session waits
  // for the next one.
  const pending = session && session.diarize !== prefs.diarize;
  ui.diarNote.textContent = pending ? "Takes effect next time you press play." : "";
}

// View and theme changes crossfade where the browser supports it.
function smoothly(update) {
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!document.startViewTransition || reduce) return update();
  document.startViewTransition(update);
}

function setPref(name, value) {
  if (prefs[name] === value) return;
  smoothly(() => {
    prefs[name] = value;
    applyPrefs();
    if (name === "layout") {
      // A pane that was hidden lost its scroll position; show the latest lines.
      for (const pane of [ui.paneA, ui.paneB, ui.paneS]) {
        const feed = pane.querySelector(".feed");
        feed.scrollTop = feed.scrollHeight;
      }
    }
  });
}

ui.opts.querySelectorAll(".seg").forEach((seg) => {
  seg.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) setPref(seg.dataset.pref, b.dataset.value);
  });
  // Arrow keys move between choices, as in a native radio group.
  seg.addEventListener("keydown", (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const buttons = [...seg.querySelectorAll("button")];
    const i = buttons.findIndex((b) => b.dataset.value === prefs[seg.dataset.pref]);
    const next = buttons[(i + dir + buttons.length) % buttons.length];
    setPref(seg.dataset.pref, next.dataset.value);
    next.focus();
  });
});

ui.diarSwitch.addEventListener("click", () => {
  prefs.diarize = !prefs.diarize;
  applyPrefs();
});

const tip = ui.opts.querySelector(".tip");
tip.querySelector(".tip-btn").addEventListener("click", (e) => {
  e.stopPropagation();
  tip.classList.toggle("open"); // tap to show on touch screens
});

function setOptionsOpen(open) {
  if (open) setNameNoteOpen(false);
  ui.opts.hidden = !open;
  ui.optsBtn.setAttribute("aria-expanded", String(open));
  tip.classList.remove("open");
  if (open) ui.opts.querySelector('.seg [aria-checked="true"]')?.focus();
}
ui.optsBtn.addEventListener("click", () => setOptionsOpen(ui.opts.hidden));
document.addEventListener("pointerdown", (e) => {
  if (!ui.opts.hidden && !e.target.closest("#opts, #opts-btn")) setOptionsOpen(false);
  if (!ui.nameNote.hidden && !e.target.closest("#name-note, #mark")) setNameNoteOpen(false);
});

// Why "Alligator"? A little note behind the logo.
function setNameNoteOpen(open) {
  if (open) setOptionsOpen(false);
  ui.nameNote.hidden = !open;
  ui.mark.setAttribute("aria-expanded", String(open));
}
ui.mark.addEventListener("click", () => setNameNoteOpen(ui.nameNote.hidden));

// ───────────────────────── Transcript ─────────────────────────
// A "turn" is one speaker's utterance in one spoken language plus its
// translation. Final tokens are committed; non-final tokens are drawn as a
// lighter, provisional layer that is replaced on every server message.

// Long monologues are split at a sentence end once the turn passes this length
// (and its translation has caught up), so the newest line stays readable.
const SPLIT_AFTER_CHARS = 240;
const SENTENCE_END = /[.!?。！？…][”"'»)\]]*\s*$/u;
// Muted hues that read on porcelain and graphite alike; cycled past six speakers.
const SPEAKER_COLORS = [
  "#5b82b8",
  "#c0714f",
  "#6e9a72",
  "#9a73b0",
  "#b8973d",
  "#4a9c9a",
];

class Transcript {
  constructor() {
    this.turns = [];
    this.committed = 0; // turns[0..committed) are final; the rest are drafts
    this.open = -1; // index of the committed turn still accepting speech
    this.pendingDirty = new Set();
    this.epoch = 0; // bumps per Soniox stream; speaker numbers restart with each stream
    this.names = new Map(); // "epoch:speaker" → name the user typed
    this.segmenters = new Map();
  }

  newEpoch() {
    this.epoch += 1;
    this.open = -1;
  }

  newTurn(fields, pending, reuse) {
    const turn = reuse.shift() ?? this.createTurn();
    Object.assign(turn, {
      ...fields,
      epoch: this.epoch,
      orig: "",
      origP: "",
      trans: "",
      transP: "",
      transLang: null,
      at: new Date(),
    });
    this.turns.push(turn);
    if (!pending) this.committed = this.turns.length;
    return this.turns.length - 1;
  }

  createTurn() {
    const mk = (pane) => {
      const el = document.createElement("div");
      el.className = "turn";
      el.hidden = true;
      const who = document.createElement("button");
      who.type = "button";
      who.className = "who";
      who.title = "Rename speaker";
      const line = document.createElement("p");
      line.className = "line";
      for (const cls of ["tag", "f", "p"]) {
        const span = document.createElement("span");
        span.className = cls;
        line.append(span);
      }
      el.append(who, line);
      pane.querySelector(".feed").append(el);
      return el;
    };
    const mkStacked = () => {
      const el = document.createElement("div");
      el.className = "turn turn-s";
      el.hidden = true;
      const who = document.createElement("button");
      who.type = "button";
      who.className = "who";
      who.title = "Rename speaker";
      el.append(who);
      for (const cls of ["src", "dst"]) {
        const line = document.createElement("p");
        line.className = `line ${cls}`;
        for (const part of ["code", "f", "p"]) {
          const span = document.createElement("span");
          span.className = part;
          line.append(span);
        }
        el.append(line);
      }
      ui.paneS.querySelector(".feed").append(el);
      return el;
    };
    // One element per view: side-by-side pane A, pane B, and the stacked column.
    return { els: [mk(ui.paneA), mk(ui.paneB), mkStacked()] };
  }

  apply(tok, pending, ctx, reuse) {
    const { text } = tok;
    if (text === "<end>" || text === "<fin>") {
      if (!pending) ctx.open = -1;
      return;
    }
    if (tok.translation_status === "translation") {
      const t = this.translationTarget(tok, pending);
      if (!t) return;
      t.transLang = tok.language;
      if (pending) t.transP += text;
      else t.trans += text;
      this.touch(t, pending);
      return;
    }
    const open = ctx.open >= 0 ? this.turns[ctx.open] : null;
    const lang = tok.language || open?.lang || prefs.a;
    const speaker = tok.speaker ?? open?.speaker ?? null;
    if (
      !open ||
      open.lang !== lang ||
      open.speaker !== speaker ||
      this.readyToSplit(open, pending)
    ) {
      const status = tok.translation_status || "none";
      ctx.open = this.newTurn({ lang, speaker, status }, pending, reuse);
    }
    const t = this.turns[ctx.open];
    if (pending) t.origP += text;
    else t.orig += text;
    this.touch(t, pending);
  }

  readyToSplit(t, pending) {
    const orig = t.orig + (pending ? t.origP : "");
    if (orig.length < SPLIT_AFTER_CHARS || !SENTENCE_END.test(orig))
      return false;
    return (
      t.status !== "original" ||
      this.translationCaughtUp(t, pending)
    );
  }

  sentenceCount(text, lang) {
    if (!text.trim()) return 0;
    if (!Intl.Segmenter) {
      const ends = text.match(/[.!?。！？…]+[”"'»)\]]*(?=\s|$)|[。！？…]+/gu) || [];
      return Math.max(1, ends.length + (SENTENCE_END.test(text) ? 0 : 1));
    }
    if (!this.segmenters.has(lang)) {
      const locale = LANGS[lang] ? lang : undefined;
      this.segmenters.set(lang, new Intl.Segmenter(locale, { granularity: "sentence" }));
    }
    return [...this.segmenters.get(lang).segment(text)].filter((s) => s.segment.trim()).length;
  }

  translationCaughtUp(t, pending) {
    const orig = t.orig + (pending ? t.origP : "");
    const trans = t.trans + (pending ? t.transP : "");
    // This is a progress estimate, not an alignment guarantee: a translation
    // can merge or split sentences. Provisional punctuation never routes finals.
    return (
      SENTENCE_END.test(trans) &&
      this.sentenceCount(trans, t.transLang) >= this.sentenceCount(orig, t.lang)
    );
  }

  // Translation tokens trail the speech they translate, so by the time one
  // arrives a newer turn (another speaker, same language) may already exist.
  // Prefer the speaker's own turn when the token says who it is; otherwise hand
  // it to the oldest unfinished source turn. Count the source's sentences too:
  // one translated full stop does not finish a multi-sentence utterance.
  translationTarget(tok, pending) {
    const recent = [];
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const t = this.turns[i];
      if (t.epoch !== this.epoch) break;
      if (t.status === "original" && t.lang === tok.source_language) recent.push(t);
    }
    recent.reverse();
    if (!recent.length) return null;
    const own =
      tok.speaker != null
        ? recent.filter((t) => t.speaker === tok.speaker)
        : [];
    const pool = own.length ? own : recent;
    let lastStarted = pool.length - 1;
    while (lastStarted > 0 && !(pool[lastStarted].trans || (pending && pool[lastStarted].transP))) {
      lastStarted -= 1;
    }
    for (let i = lastStarted; i < pool.length - 1; i++) {
      if (!this.translationCaughtUp(pool[i], pending)) return pool[i];
    }
    return pool.at(-1);
  }

  touch(t, pending) {
    t.dirty = true;
    if (pending) this.pendingDirty.add(t);
  }

  ingest(tokens) {
    // Retire the previous provisional layer. Draft turns are kept for reuse so
    // their DOM nodes don't flicker in and out between messages.
    for (const t of this.pendingDirty) {
      t.origP = "";
      t.transP = "";
      t.dirty = true;
    }
    this.pendingDirty.clear();
    const reuse = this.turns.splice(this.committed);

    const committedCtx = this;
    for (const tok of tokens)
      if (tok.is_final) this.apply(tok, false, committedCtx, reuse);

    const draftCtx = { open: this.open };
    for (const tok of tokens)
      if (!tok.is_final) this.apply(tok, true, draftCtx, reuse);

    for (const t of reuse) t.els.forEach((el) => el.remove());
    this.render();
  }

  closeTurn() {
    this.open = -1;
  }

  clearDrafts() {
    for (const t of this.pendingDirty) {
      t.origP = "";
      t.transP = "";
      t.dirty = true;
    }
    this.pendingDirty.clear();
    for (const t of this.turns.splice(this.committed))
      t.els.forEach((el) => el.remove());
    this.open = -1;
    this.render();
  }

  addBreak() {
    if (!this.turns.length) return;
    const label = new Date().toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
    for (const pane of [ui.paneA, ui.paneB]) {
      const div = document.createElement("div");
      div.className = "break";
      div.textContent = label;
      pane.querySelector(".feed").append(div);
    }
  }

  rerender() {
    this.turns.forEach((t) => (t.dirty = true));
    this.render();
  }

  speakerKey(t) {
    return t.speaker == null ? null : `${t.epoch}:${t.speaker}`;
  }

  speakerName(t) {
    return this.names.get(this.speakerKey(t)) || `Speaker ${t.speaker}`;
  }

  // Inline rename: the label turns into a text field; Enter or blur saves,
  // Escape cancels. The name applies to every turn by that speaker.
  rename(key, labelEl) {
    const turnEl = labelEl.closest(".turn");
    const t = this.turns.find((x) => this.speakerKey(x) === key);
    if (!t || turnEl.dataset.editing) return;
    const input = document.createElement("input");
    input.className = "who-edit";
    input.value = this.names.get(key) ?? "";
    input.placeholder = `Speaker ${t.speaker}`;
    input.maxLength = 40;
    input.setAttribute("aria-label", `Name for speaker ${t.speaker}`);
    turnEl.dataset.editing = "";
    labelEl.after(input);
    input.focus();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      if (save) {
        const name = input.value.trim();
        if (name) this.names.set(key, name);
        else this.names.delete(key);
        this.turns.forEach(
          (x) => this.speakerKey(x) === key && (x.dirty = true),
        );
      }
      input.remove();
      delete turnEl.dataset.editing;
      this.render();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
  }

  render() {
    const panes = [ui.paneA, ui.paneB];
    const views = [ui.paneA, ui.paneB, ui.paneS];
    const feeds = views.map((p) => p.querySelector(".feed"));
    const stick = feeds.map((f) => f.scrollHeight - f.scrollTop - f.clientHeight < 160);

    // A speaker label opens each run of turns by the same speaker. Recompute it
    // for the tail too, since an earlier turn's speaker can still settle.
    const tailFrom = Math.max(0, this.turns.length - 8);
    this.turns.forEach((t, idx) => {
      if (idx < tailFrom && !t.dirty) return;
      const prev = this.turns[idx - 1];
      const label =
        t.speaker == null ||
        (prev && prev.epoch === t.epoch && prev.speaker === t.speaker)
          ? ""
          : this.speakerName(t);
      if (label !== t.label) {
        t.label = label;
        t.dirty = true;
      }
    });

    for (const t of this.turns) {
      if (!t.dirty) continue;
      t.dirty = false;
      const color =
        t.speaker == null
          ? ""
          : SPEAKER_COLORS[
              (parseInt(t.speaker, 10) - 1 || 0) % SPEAKER_COLORS.length
            ];
      panes.forEach((pane, i) => {
        const el = t.els[i];
        const who = el.querySelector(".who");
        const line = el.querySelector(".line");
        const paneLang = pane.lang;
        const outsidePair =
          t.status === "none" || (t.lang !== prefs.a && t.lang !== prefs.b);
        let f,
          p,
          kind,
          tag = "";
        if (outsidePair) {
          [f, p, kind, tag] = [
            t.orig,
            t.origP,
            "spoken",
            t.lang?.toUpperCase() ?? "",
          ];
        } else if (t.lang === paneLang) {
          [f, p, kind] = [t.orig, t.origP, "spoken"];
        } else {
          [f, p, kind] = [t.trans, t.transP, "translated"];
        }
        if (!f) p = p.trimStart();
        line.children[0].textContent = tag;
        line.children[1].textContent = f.trimStart();
        line.children[2].textContent = p;
        who.textContent = t.label;
        who.hidden = !t.label;
        who.dataset.key = this.speakerKey(t) ?? "";
        el.classList.remove("spoken", "translated");
        el.classList.add(kind);
        if (color) el.style.setProperty("--spk", color);
        else el.style.removeProperty("--spk");
        el.hidden = !(f.trim() || p.trim());
      });
      this.renderStacked(t, color);
    }

    // Before scrolling: in the face-to-face layout, showing Save adds room at
    // the bottom of the pane, and the scroll must take that room into account.
    ui.save.hidden = !(body.dataset.state === "idle" && this.committed > 0);
    views.forEach((pane, i) => {
      pane.querySelector(".turn.recent")?.classList.remove("recent");
      let last = feeds[i].lastElementChild;
      while (last && (last.hidden || !last.classList.contains("turn")))
        last = last.previousElementSibling;
      last?.classList.add("recent");
      pane.classList.toggle("has-content", Boolean(last));
      if (stick[i]) feeds[i].scrollTop = feeds[i].scrollHeight;
    });
    this.onChange?.();
  }

  // Stacked view: what was said on top, its translation right underneath.
  renderStacked(t, color) {
    const el = t.els[2];
    const who = el.querySelector(".who");
    const src = el.querySelector(".src");
    const dst = el.querySelector(".dst");
    const fill = (line, lang, f, p) => {
      line.children[0].textContent = lang ? lang.toUpperCase() : "";
      line.children[1].textContent = f.trimStart();
      line.children[2].textContent = f ? p : p.trimStart();
      line.lang = lang || "";
      line.dir = RTL.has(lang) ? "rtl" : "ltr";
      return Boolean(f.trim() || p.trim());
    };
    const hasSrc = fill(src, t.lang, t.orig, t.origP);
    const other = t.lang === prefs.a ? prefs.b : prefs.a;
    dst.hidden = !fill(dst, t.transLang || other, t.trans, t.transP);
    who.textContent = t.label;
    who.hidden = !t.label;
    who.dataset.key = this.speakerKey(t) ?? "";
    if (color) el.style.setProperty("--spk", color);
    else el.style.removeProperty("--spk");
    el.hidden = !hasSrc;
  }

  toText() {
    const time = (d) =>
      d.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    return this.turns
      .slice(0, this.committed)
      .map((t) => {
        const who = t.speaker == null ? "" : `${this.speakerName(t)} · `;
        const head = `[${time(t.at)}] ${who}`;
        const lines = [`${head}${t.lang?.toUpperCase()}  ${t.orig.trim()}`];
        if (t.trans.trim())
          lines.push(
            `${" ".repeat(head.length)}${t.transLang?.toUpperCase()}  ${t.trans.trim()}`,
          );
        return lines.join("\n");
      })
      .join("\n\n");
  }

  // Committed turns from index `from` as Markdown: as spoken when `lang` is
  // null, else every turn in `lang`, tagged where it was translated.
  toMarkdown(from, lang = null) {
    const time = (d) =>
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
    return this.turns
      .slice(from, this.committed)
      .filter((t) => t.orig.trim())
      .map((t) => {
        const src = t.lang?.toUpperCase() ?? "";
        let text = t.orig.trim();
        let tag = src;
        if (lang) {
          if (t.lang === lang) tag = "";
          else if (t.trans.trim() && t.transLang === lang) [text, tag] = [t.trans.trim(), `from ${src}`];
          else tag = `${src}, untranslated`;
        }
        const who = t.speaker == null ? "" : ` ${this.speakerName(t)}`;
        return `**[${time(t.at)}]${who}**${tag ? ` (${tag})` : ""}\n${text}`;
      })
      .join("\n\n");
  }
}

const transcript = new Transcript();

// ───────────────────────── Audio capture ─────────────────────────

async function openAudio(source, onFrame, signal) {
  const streams = [];
  let display = null;
  let ctx = null;
  let worklet = null;
  const close = () => {
    signal?.removeEventListener("abort", close);
    if (worklet) worklet.port.onmessage = null;
    streams.forEach((s) => s.getTracks().forEach((t) => t.stop()));
    display?.getTracks().forEach((t) => t.stop());
    if (ctx && ctx.state !== "closed") ctx.close().catch(() => {});
  };
  signal?.addEventListener("abort", close, { once: true });

  try {
    signal?.throwIfAborted();
    // Ask for the meeting tab first, while the click's user activation is fresh.
    if (source === "meeting") {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
        systemAudio: "include",
        selfBrowserSurface: "exclude",
        preferCurrentTab: false,
      });
      if (!display.getAudioTracks().length) {
        throw new Error(
          "No meeting audio was shared. Choose the meeting's tab and switch on “Share tab audio”.",
        );
      }
      signal?.throwIfAborted();
      display.getVideoTracks().forEach((t) => (t.enabled = false));
      streams.push(new MediaStream(display.getAudioTracks()));
    }

    const mic = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    streams.push(mic);
    signal?.throwIfAborted();

    ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.audioWorklet.addModule("pcm-worklet.js");
    signal?.throwIfAborted();
    worklet = new AudioWorkletNode(ctx, "pcm-worklet", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    for (const s of streams) ctx.createMediaStreamSource(s).connect(worklet); // summed into mono
    const sink = ctx.createGain();
    sink.gain.value = 0;
    worklet.connect(sink).connect(ctx.destination); // keeps the graph pulling without playing anything
    worklet.port.onmessage = (e) => onFrame(e.data);
    await ctx.resume();
    signal?.throwIfAborted();
    return { display, close };
  } catch (err) {
    // Includes streams returned after Stop while a permission prompt was open.
    close();
    throw err;
  }
}

// ───────────────────────── Soniox session ─────────────────────────

// Where a stream's key comes from, in order:
//   1. The user's own Soniox key (Options → Soniox API key), kept in this
//      browser. The browser trades it with Soniox for a 60-second, single-use
//      key, so the long-lived key is never sent over the stream itself.
//   2. The key configured on the server that serves Alligator, if any
//      (SONIOX_API_KEY), via /api/temporary-key.
const SONIOX_API = "https://api.soniox.com/v1";
const KEY_PREF = "alligator.apiKey";
let serverHasKey = false;

class KeyError extends Error {
  constructor(message, kind) {
    super(message);
    this.kind = kind; // "missing" | "invalid" | "network"
  }
}

async function mintTemporaryKey(userKey) {
  let res;
  try {
    res = await fetch(`${SONIOX_API}/auth/temporary-api-key`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ usage_type: "transcribe_websocket", expires_in_seconds: 60, single_use: true }),
    });
  } catch {
    throw new KeyError("Couldn’t reach Soniox. Check your internet connection.", "network");
  }
  const data = await res.json().catch(() => ({}));
  if (res.ok && data.api_key) return { key: data.api_key, direct: false };
  // 403: the key is real but lacks the "Temporary API keys" permission. It's
  // the user's own key on their own device, so stream with it directly.
  if (res.status === 403) return { key: userKey, direct: true };
  if (res.status === 401) {
    throw new KeyError("Soniox didn’t accept your API key. Check it in Options.", "invalid");
  }
  throw new KeyError(data.message || data.error_message || `Soniox returned an error (${res.status}).`, "network");
}

async function getStreamKey() {
  const userKey = store.get(KEY_PREF, "");
  if (userKey) return (await mintTemporaryKey(userKey)).key;
  if (!serverHasKey) throw new KeyError("Add your Soniox API key to start translating.", "missing");
  let res;
  try {
    res = await fetch("api/temporary-key", { method: "POST" });
  } catch {
    throw new KeyError("Couldn’t reach the Alligator server.", "network");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.api_key) throw new KeyError(data.error || "Couldn’t get a session key from the server.", "network");
  return data.api_key;
}

const hasAnyKey = () => Boolean(store.get(KEY_PREF, "")) || serverHasKey;

// When Alligator is served by server.js, ask whether it holds a key. On a
// static host this request simply fails and the user brings their own key.
fetch("api/status")
  .then((r) => (r.ok ? r.json() : {}))
  .then((d) => {
    serverHasKey = Boolean(d.serverKey);
    autosave.lang = d.transcripts?.lang ?? null;
  })
  .catch(() => {})
  .finally(renderKeyOption);

function renderKeyOption() {
  const key = store.get(KEY_PREF, "");
  ui.keyBtn.textContent = key ? "Change" : "Add";
  ui.keyNote.textContent = key
    ? `Saved · ends in ${key.slice(-4)}`
    : serverHasKey
      ? "Using the key set up on this server"
      : "Not added yet";
}

// ── Key dialog ──

function openKeySheet(reason = "") {
  setOptionsOpen(false);
  const saved = store.get(KEY_PREF, "");
  ui.keyInput.value = "";
  ui.keyInput.placeholder = saved ? `Current key ends in ${saved.slice(-4)}` : "Paste your key here";
  ui.keyInput.type = "password";
  ui.keyShow.textContent = "Show";
  ui.keyShow.setAttribute("aria-pressed", "false");
  ui.keyLead.textContent =
    reason ||
    "Alligator uses Soniox to hear and translate speech. Paste your API key to connect your Soniox account.";
  ui.keyHowto.open = !saved; // first time: show the steps right away
  ui.keyRemove.hidden = !saved;
  setKeyStatus("");
  ui.keySave.disabled = false;
  ui.keySheet.showModal();
  ui.keyInput.focus();
}

function setKeyStatus(text, tone = "") {
  ui.keyStatus.textContent = text;
  ui.keyStatus.dataset.tone = tone;
}

ui.keyBtn.addEventListener("click", () => openKeySheet());
ui.keyCancel.addEventListener("click", () => ui.keySheet.close());
ui.keyShow.addEventListener("click", () => {
  const show = ui.keyInput.type === "password";
  ui.keyInput.type = show ? "text" : "password";
  ui.keyShow.textContent = show ? "Hide" : "Show";
  ui.keyShow.setAttribute("aria-pressed", String(show));
  ui.keyInput.focus();
});
ui.keyRemove.addEventListener("click", () => {
  store.remove(KEY_PREF);
  renderKeyOption();
  ui.keySheet.close();
  toast("Your Soniox API key was removed from this device.");
});
// Click on the dimmed backdrop closes the dialog.
ui.keySheet.addEventListener("click", (e) => {
  if (e.target === ui.keySheet) ui.keySheet.close();
});

ui.keyForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const key = ui.keyInput.value.trim().replace(/^Bearer\s+/i, "");
  if (!key) {
    setKeyStatus("Paste your key first.", "error");
    ui.keyInput.focus();
    return;
  }
  ui.keySave.disabled = true;
  setKeyStatus("Checking with Soniox…");
  let note = "Key saved. You’re ready to go.";
  try {
    await mintTemporaryKey(key);
  } catch (err) {
    if (err.kind === "invalid") {
      ui.keySave.disabled = false;
      setKeyStatus("Soniox didn’t accept this key. Make sure you copied all of it.", "error");
      ui.keyInput.select();
      return;
    }
    note = "Key saved. Soniox couldn’t be reached to check it, so it will be checked when you press play.";
  }
  store.set(KEY_PREF, key);
  renderKeyOption();
  setKeyStatus("Connected", "ok");
  setTimeout(() => {
    ui.keySheet.close();
    toast(note);
  }, 450);
});

class Session {
  constructor({ a, b, source, diarize }) {
    Object.assign(this, { a, b, source, diarize });
    this.ws = null;
    this.audio = null;
    this.paused = false;
    this.stopping = false;
    this.closed = false;
    this.capture = new AbortController();
    this.reconnects = 0;
    this.keepalive = null;
    this.onState = () => {};
    this.onError = () => {};
  }

  async start() {
    this.audio = await openAudio(this.source, (frame) => this.onFrame(frame), this.capture.signal);
    if (this.stopping) {
      this.audio.close();
      return;
    }
    this.audio.display?.getAudioTracks()[0].addEventListener("ended", () => {
      if (!this.stopping) {
        this.onError("Meeting audio sharing ended.");
        this.stop();
      }
    });
    await this.connect();
  }

  async connect() {
    if (this.stopping) return;
    const apiKey = await getStreamKey();
    if (this.stopping) return;
    transcript.newEpoch(); // a new stream numbers its speakers from 1 again
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(SONIOX_WS, ["soniox-api-key", apiKey]);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        if (this.stopping || ws !== this.ws) {
          ws.close();
          resolve();
          return;
        }
        opened = true;
        ws.send(
          JSON.stringify({
            model: MODEL,
            audio_format: "pcm_s16le",
            sample_rate: 16000,
            num_channels: 1,
            language_hints: [this.a, this.b],
            enable_language_identification: true,
            // Diarization labels who is speaking. Endpoint detection is left off
            // because early finalization makes speaker attribution less accurate
            // (per Soniox docs); turns break on speaker and language changes instead.
            enable_speaker_diarization: this.diarize,
            enable_endpoint_detection: !this.diarize,
            translation: {
              type: "two_way",
              language_a: this.a,
              language_b: this.b,
            },
          }),
        );
        this.onState(this.paused ? "paused" : "live");
        if (this.paused) this.startKeepalive();
        resolve();
      };
      ws.onmessage = (e) => {
        if (!this.closed && ws === this.ws) this.onMessage(e.data);
      };
      ws.onerror = () => {
        if (this.stopping) resolve();
        else reject(new Error("Couldn’t reach Soniox."));
      };
      ws.onclose = () => {
        if (!opened) {
          if (this.stopping) resolve();
          else reject(new Error("Couldn’t reach Soniox."));
          return;
        }
        this.onClose(ws);
      };
    });
  }

  onFrame({ pcm, level }) {
    if (this.stopping) return;
    if (!this.paused) this.onLevel?.(level);
    if (this.paused || this.stopping || this.ws?.readyState !== WebSocket.OPEN)
      return;
    this.ws.send(pcm);
  }

  onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.error_code) {
      this.lastError = msg;
      // Transient server-side conditions are retried by onClose; others surface now.
      if (![408, 500, 503].includes(msg.error_code)) this.fatal = true;
      if (this.fatal) this.onError(friendlyError(msg));
      return;
    }
    if (msg.tokens?.length) transcript.ingest(msg.tokens);
    if (msg.finished) this.finished?.();
  }

  async onClose(ws) {
    if (ws !== this.ws) return;
    this.stopKeepalive();
    if (this.stopping) return this.finished?.();
    transcript.clearDrafts();
    if (this.fatal || this.reconnects >= MAX_RECONNECTS) {
      if (!this.fatal) this.onError("The connection to Soniox was lost.");
      return this.teardown();
    }
    // Stream dropped (network blip, server restart): reconnect, keeping the transcript.
    this.reconnects += 1;
    this.onState("connecting");
    await new Promise((r) => setTimeout(r, 400 * this.reconnects));
    if (this.stopping) return;
    try {
      await this.connect();
    } catch (err) {
      if (this.stopping) return;
      this.onError(err.message);
      this.teardown();
    }
  }

  pause() {
    if (this.paused || this.stopping) return;
    this.paused = true;
    // ~300 ms of silence, then finalize, so the sentence in flight settles cleanly.
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(new Int16Array(4800).buffer);
      this.ws.send(JSON.stringify({ type: "finalize" }));
    }
    this.startKeepalive();
    this.onState("paused");
  }

  resume() {
    if (!this.paused || this.stopping) return;
    this.paused = false;
    this.stopKeepalive();
    transcript.closeTurn();
    this.onState("live");
  }

  startKeepalive() {
    this.stopKeepalive();
    this.keepalive = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify({ type: "keepalive" }));
    }, KEEPALIVE_MS);
  }

  stopKeepalive() {
    clearInterval(this.keepalive);
    this.keepalive = null;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    this.capture.abort();
    this.onState("stopping");
    this.stopKeepalive();
    if (this.ws?.readyState === WebSocket.OPEN) {
      await new Promise((resolve) => {
        this.finished = resolve;
        this.ws.send(""); // empty frame: end of audio; server flushes and sends `finished`
        setTimeout(resolve, 4000);
      });
    }
    this.teardown();
  }

  teardown() {
    if (this.closed) return;
    this.closed = true;
    this.stopKeepalive();
    this.stopping = true;
    this.capture.abort();
    try {
      this.ws?.close();
    } catch {}
    this.audio?.close();
    transcript.clearDrafts();
    this.onState("idle");
  }
}

function friendlyError(msg) {
  switch (msg.error_type) {
    case "unauthenticated":
      return "Soniox didn’t accept the API key. Check it in Options.";
    case "permission_denied":
      return "This Soniox API key isn’t allowed to use real-time speech-to-text.";
    case "organization_balance_exhausted":
    case "organization_monthly_budget_exhausted":
    case "project_monthly_budget_exhausted":
      return "Your Soniox balance or monthly budget has run out.";
    case "limit_exceeded":
      return "Too many live sessions right now. Try again in a moment.";
    default:
      return msg.error_message || "Something went wrong.";
  }
}

// ───────────────────────── Autosave ─────────────────────────
// When server.js has TRANSCRIPT_DIR set, it keeps each session's transcript
// there while the session runs: one file as spoken, one all in its language.

const AUTOSAVE_MS = 3000;

const autosave = {
  lang: null, // the server's target language; null when it keeps no transcripts
  file: null, // the latest session's { id, from, a, b, created }
  timer: null,
  inflight: null,
  again: null, // null, or the options of the flush that waits for the one in flight

  begin({ a, b }) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.lang) return void (this.file = null);
    // The transcript outlives sessions, so this file starts where this session does.
    const file = { id: null, from: transcript.committed, a, b, warned: false };
    file.created = this.create(file);
    this.file = file;
  },

  async create(file) {
    try {
      const res = await fetch("api/transcripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a: file.a, b: file.b }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) throw new Error(data.error || `The server returned ${res.status}.`);
      file.id = data.id;
    } catch (err) {
      this.warn(file, err);
    }
  },

  // Speaker renames after the session still reach the file, until the next Play.
  schedule() {
    if (this.file && !this.timer) this.timer = setTimeout(() => this.flush(), AUTOSAVE_MS);
  },

  // One write at a time, so an older snapshot never lands after a newer one.
  async flush({ keepalive = false } = {}) {
    clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    if (this.inflight) {
      // The tab may be closing (pagehide): the deferred write must keep keepalive.
      this.again = { keepalive: keepalive || Boolean(this.again?.keepalive) };
      return;
    }
    this.inflight = this.write(this.file, keepalive);
    await this.inflight;
    this.inflight = null;
    const again = this.again;
    this.again = null;
    if (again) await this.flush(again);
  },

  async write(file, keepalive) {
    await file.created;
    if (!file.id) return;
    const original = transcript.toMarkdown(file.from);
    if (!original) return; // a session nobody spoke in leaves no files behind
    const lang = [file.a, file.b].includes(this.lang) ? this.lang : file.b;
    try {
      const res = await fetch(`api/transcripts/${encodeURIComponent(file.id)}`, {
        method: "PUT",
        keepalive,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lang,
          original: original + "\n",
          translation: transcript.toMarkdown(file.from, lang) + "\n",
        }),
      });
      // The server restarted and forgot this id: continue in a new pair of files.
      if (res.status === 404 && file === this.file) {
        file.id = null;
        file.created = this.create(file);
        this.again = { keepalive };
      } else if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `The server returned ${res.status}.`);
      }
    } catch (err) {
      this.warn(file, err);
    }
  },

  warn(file, err) {
    if (file.warned) return;
    file.warned = true;
    toast(`Couldn’t save the transcript to the server: ${err.message}`);
  },
};
transcript.onChange = () => autosave.schedule();
addEventListener("pagehide", () => autosave.flush({ keepalive: true }));

// ───────────────────────── Controller ─────────────────────────

let session = null;
let wakeLock = null;
const clock = { ms: 0, since: 0, timer: null };

function setState(state) {
  body.dataset.state = state;
  syncSessionLock();
  ui.main.setAttribute(
    "aria-label",
    state === "live" ? "Pause" : state === "paused" ? "Resume" : "Start",
  );
  ui.main.title = state === "live" ? "Pause (Space)" : "Start (Space)";

  if (state === "live") {
    clock.since = performance.now();
    clock.timer ??= setInterval(tickClock, 250);
    requestWakeLock();
  } else {
    if (clock.since) clock.ms += performance.now() - clock.since;
    clock.since = 0;
    clearInterval(clock.timer);
    clock.timer = null;
    body.style.setProperty("--lv", 0);
  }
  if (state === "idle") {
    session = null;
    autosave.flush();
    wakeLock?.release().catch(() => {});
    wakeLock = null;
  }
  tickClock();
  setStatus();
  renderOptions();
  syncPip();
  transcript.render();
}

function setStatus() {
  const s = body.dataset.state;
  const meeting = prefs.source === "meeting";
  ui.status.textContent = {
    idle: meeting
      ? "Press play, then pick the meeting tab and share its audio"
      : "Press play and speak naturally",
    connecting: "Connecting…",
    live: meeting ? "Listening to you and the meeting" : "Listening",
    paused: "Paused",
    stopping: "Finishing…",
  }[s];
}

function tickClock() {
  const ms = clock.ms + (clock.since ? performance.now() - clock.since : 0);
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  ui.clock.textContent = `${h ? h + ":" : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
  if (pip) pip.clock.textContent = ui.clock.textContent;
}

async function requestWakeLock() {
  if (wakeLock || !("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
  } catch {}
}

async function start() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast(
      "This browser can’t capture audio here. Open Alligator over http://localhost or HTTPS.",
    );
  }
  if (prefs.source === "meeting" && !navigator.mediaDevices.getDisplayMedia) {
    return toast(
      "Capturing meeting audio needs a desktop browser such as Chrome or Edge.",
    );
  }
  if (!hasAnyKey()) {
    return openKeySheet("Add your Soniox API key to start translating. It takes about a minute.");
  }
  clock.ms = 0;
  transcript.addBreak();
  transcript.closeTurn();
  autosave.begin(prefs);
  const current = new Session(prefs);
  session = current;
  current.onState = (state) => {
    if (session === current) setState(state);
  };
  current.onError = (message) => {
    if (session === current) toast(message);
  };
  let lv = 0;
  current.onLevel = (level) => {
    if (session !== current) return;
    lv = Math.max(Math.sqrt(level), lv * 0.7);
    body.style.setProperty("--lv", lv.toFixed(3));
  };
  setState("connecting");
  try {
    await current.start();
  } catch (err) {
    if (current.stopping || session !== current) return;
    if (err instanceof KeyError && err.kind !== "network") {
      current.teardown();
      return openKeySheet(err.message);
    }
    const denied = err.name === "NotAllowedError";
    toast(
      denied
        ? "Permission was declined. Allow microphone (and screen audio for meetings) to continue."
        : err.message,
    );
    current.teardown();
  }
}

ui.main.addEventListener("click", () => {
  const s = body.dataset.state;
  if (s === "idle") start();
  else if (s === "live") session?.pause();
  else if (s === "paused") session?.resume();
});
ui.stop.addEventListener("click", () => session?.stop());
for (const pane of [ui.paneA, ui.paneB, ui.paneS]) {
  pane.querySelector(".feed").addEventListener("click", (e) => {
    const who = e.target.closest(".who");
    if (who?.dataset.key) transcript.rename(who.dataset.key, who);
  });
}

document.addEventListener("keydown", onKeydown);
function onKeydown(e) {
  // In the pop-out, Space pauses and resumes; starting happens in the main window.
  const inPopOut = e.target.ownerDocument !== document;
  if (inPopOut && e.code === "Space" && body.dataset.state === "idle") return;
  if (ui.keySheet.open || ui.aboutSheet.open) return; // dialogs handle their own keys (Esc closes them)
  if (e.key === "Escape" && !ui.opts.hidden) {
    setOptionsOpen(false);
    ui.optsBtn.focus();
    return;
  }
  if (e.key === "Escape" && !ui.nameNote.hidden) {
    setNameNoteOpen(false);
    ui.mark.focus();
    return;
  }
  if (e.target.closest("select, input, textarea")) return;
  if (e.code === "Space" && !e.target.closest("button")) {
    e.preventDefault();
    ui.main.click();
  } else if (e.key === "Escape" && session) {
    session.stop();
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && body.dataset.state === "live")
    requestWakeLock();
});

ui.save.addEventListener("click", () => {
  const blob = new Blob([transcript.toText() + "\n"], {
    type: "text/plain;charset=utf-8",
  });
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.href = URL.createObjectURL(blob);
  a.download = `alligator-${prefs.a}-${prefs.b}-${stamp}.txt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

let toastTimer;
function toast(message) {
  if (pip) showPipMessage(message);
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  ui.toast.style.animation = "none";
  void ui.toast.offsetWidth;
  ui.toast.style.animation = "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.hidden = true), 6000);
}

// ───────────────────────── Pop-out ─────────────────────────
// Document Picture-in-Picture: a small always-on-top window that floats over
// Meet, Teams or Zoom (their desktop apps too). The stacked transcript pane
// moves into it, so the same live rendering keeps working there, and moves
// back when the window closes. Chrome and Edge on desktop only.

const canPopOut = "documentPictureInPicture" in window;
let pip = null; // { win, doc, clock, langs, msg }
ui.pop.hidden = !canPopOut;

const PIP_BAR = `
  <header class="pip-bar">
    <span class="pip-status"><span class="dot" aria-hidden="true"></span><span class="pip-clock">0:00</span></span>
    <span class="pip-langs"></span>
    <span class="pip-hint">Press play in Alligator to start</span>
    <span class="spacer"></span>
    <button class="pip-btn pip-main" type="button" aria-label="Pause">
      <svg class="i-play" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.8v12.4a1 1 0 0 0 1.5.86l10-6.2a1 1 0 0 0 0-1.72l-10-6.2a1 1 0 0 0-1.5.86Z" /></svg>
      <svg class="i-pause" viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="3.6" height="14" rx="1.2" /><rect x="13.9" y="5" width="3.6" height="14" rx="1.2" /></svg>
    </button>
    <button class="pip-btn pip-stop" type="button" aria-label="Stop">
      <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" /></svg>
    </button>
  </header>
  <p class="pip-msg" role="alert" hidden></p>`;

async function popOut() {
  if (pip) return popIn(); // the button toggles
  setOptionsOpen(false);
  setNameNoteOpen(false);
  let win;
  try {
    win = await documentPictureInPicture.requestWindow({ width: 420, height: 360 });
  } catch {
    return toast("Couldn’t open the pop-out window.");
  }
  const doc = win.document;
  // Same look as the main window: copy the stylesheets with absolute URLs.
  for (const link of document.head.querySelectorAll('link[rel="stylesheet"]')) {
    const copy = doc.createElement("link");
    copy.rel = "stylesheet";
    copy.href = link.href;
    doc.head.append(copy);
  }
  doc.title = "Alligator";
  doc.body.className = "pip";
  doc.body.innerHTML = PIP_BAR;
  doc.body.append(ui.paneS);
  pip = {
    win,
    doc,
    clock: doc.querySelector(".pip-clock"),
    langs: doc.querySelector(".pip-langs"),
    msg: doc.querySelector(".pip-msg"),
  };
  doc.querySelector(".pip-main").addEventListener("click", () => {
    if (body.dataset.state === "live") session?.pause();
    else if (body.dataset.state === "paused") session?.resume();
  });
  doc.querySelector(".pip-stop").addEventListener("click", () => session?.stop());
  doc.addEventListener("keydown", onKeydown);
  win.addEventListener("pagehide", popIn);
  body.dataset.pip = "";
  ui.pop.setAttribute("aria-pressed", "true");
  ui.pop.setAttribute("aria-label", "Bring the conversation back");
  syncPip();
  scrollToLatest(ui.paneS);
}

function popIn() {
  if (!pip) return;
  const { win } = pip;
  pip = null;
  ui.stage.insertBefore(ui.paneS, ui.popped); // back to its place in the stage
  delete body.dataset.pip;
  ui.pop.setAttribute("aria-pressed", "false");
  ui.pop.setAttribute("aria-label", "Pop out");
  scrollToLatest(ui.paneS);
  if (!win.closed) win.close();
}

function syncPip() {
  if (!pip) return;
  const { doc } = pip;
  doc.body.dataset.state = body.dataset.state;
  doc.body.dataset.textSize = prefs.textSize;
  if (document.documentElement.dataset.theme) doc.documentElement.dataset.theme = document.documentElement.dataset.theme;
  else delete doc.documentElement.dataset.theme;
  pip.langs.textContent = `${autonym(prefs.a)} ⇄ ${autonym(prefs.b)}`;
  pip.clock.textContent = ui.clock.textContent;
  doc.querySelector(".pip-main").setAttribute("aria-label", body.dataset.state === "live" ? "Pause" : "Resume");
}

let pipMsgTimer;
function showPipMessage(message) {
  pip.msg.textContent = message;
  pip.msg.hidden = false;
  clearTimeout(pipMsgTimer);
  pipMsgTimer = setTimeout(() => pip && (pip.msg.hidden = true), 6000);
}

function scrollToLatest(pane) {
  const feed = pane.querySelector(".feed");
  feed.scrollTop = feed.scrollHeight;
}

ui.pop.addEventListener("click", popOut);
ui.popBack.addEventListener("click", popIn);

// ───────────────────────── Privacy & install ─────────────────────────

document.querySelectorAll("[data-about]").forEach((el) =>
  el.addEventListener("click", () => {
    setOptionsOpen(false);
    if (ui.keySheet.open) ui.keySheet.close();
    ui.aboutSheet.showModal();
  }),
);
ui.aboutClose.addEventListener("click", () => ui.aboutSheet.close());
ui.aboutSheet.addEventListener("click", (e) => {
  if (e.target === ui.aboutSheet) ui.aboutSheet.close();
});

// Lets Alligator be installed as an app and open without a network.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

applyPrefs();

// Open /#demo to replay a scripted three-person English ⇄ Spanish exchange
// through the real token pipeline: non-final text streams in, speakers are
// diarized, and each turn's last translated words arrive only after the next
// speaker has started, as they do live. No key needed.
if (location.hash === "#demo") {
  prefs.a = "en";
  prefs.b = "es";
  applyPrefs();
  const script = [
    ["1", "en", "Thanks for making the time today. Shall we start with the delivery schedule?",
      "es", "Gracias por sacar tiempo hoy. ¿Empezamos con el calendario de entregas?"],
    ["2", "es", "Claro. El primer envío sale el lunes y el segundo a finales de mes.",
      "en", "Of course. The first shipment leaves on Monday and the second at the end of the month."],
    ["1", "en", "Perfect. Can we move the second one a week earlier?",
      "es", "Perfecto. ¿Podemos adelantar el segundo una semana?"],
    ["3", "en", "I checked this morning, and the warehouse has room for it.",
      "es", "Lo revisé esta mañana y el almacén tiene espacio."],
    ["2", "es", "Entonces lo confirmo hoy mismo.",
      "en", "Then I'll confirm it today."],
  ];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Like a live stream, tokens only carry a speaker when diarization is on.
  const said = (text, language, speaker, is_final) => ({
    text,
    language,
    is_final,
    translation_status: "original",
    ...(prefs.diarize && { speaker }),
  });
  const meant = (text, language, source_language, is_final) =>
    ({ text, language, source_language, is_final, translation_status: "translation" });
  (async () => {
    await sleep(900);
    setState("live");
    let carry = []; // previous turn's trailing translation, still in flight
    for (const [spk, sl, text, tl, translation] of script) {
      const words = text.split(/(?=\s)/);
      const trans = translation.split(/(?=\s)/);
      const cut = trans.length - 2;
      for (let i = 0; i < words.length; i++) {
        const shown = Math.floor((i / words.length) * cut * 0.8);
        transcript.ingest([
          ...carry,
          ...(i ? [said(words[i - 1], sl, spk, true)] : []),
          said(words[i], sl, spk, false),
          ...trans.slice(0, shown).map((w) => meant(w, tl, sl, false)),
        ]);
        carry = [];
        await sleep(170);
      }
      transcript.ingest([
        said(words.at(-1), sl, spk, true),
        ...trans.slice(0, cut).map((w) => meant(w, tl, sl, true)),
      ]);
      carry = trans.slice(cut).map((w) => meant(w, tl, sl, true));
      await sleep(1400);
    }
    transcript.ingest(carry);
    setState("idle");
  })();
}
