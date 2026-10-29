// Live transcript files, written by server.js when TRANSCRIPT_DIR is set.
// Each session gets two Markdown files: what was said, in the languages it was
// said in, and the whole conversation in one target language.
import { open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const LANG = /^[a-z]{2,3}$/;
const MAX_BYTES = 2_000_000;

export function transcriptStore(dir, targetLang = "en") {
  if (!LANG.test(targetLang)) throw new Error(`TRANSCRIPT_LANG must be a language code, got "${targetLang}"`);
  // Only ids issued by this process are writable, so another client on the
  // network can't overwrite a file by guessing its name.
  const issued = new Set();
  const path = (name) => join(dir, `${name}.md`);

  async function create({ a, b }) {
    if (!LANG.test(a) || !LANG.test(b)) throw httpError(400, "Unknown language pair.");
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())} ${a}-${b}`;
    for (let n = 1; n < 100; n++) {
      const id = n === 1 ? base : `${base} (${n})`;
      try {
        // "wx" claims the name atomically, so two sessions in the same minute get separate files.
        await (await open(path(`${id} original`), "wx")).close();
      } catch (err) {
        if (err.code === "EEXIST") continue;
        throw err;
      }
      issued.add(id);
      return { id };
    }
    throw httpError(409, "Too many transcripts this minute.");
  }

  async function write(id, { lang, original, translation }) {
    if (!issued.has(id)) throw httpError(404, "Unknown transcript.");
    if (!LANG.test(lang) || typeof original !== "string" || typeof translation !== "string")
      throw httpError(400, "Malformed transcript.");
    await replace(path(`${id} original`), original);
    await replace(path(`${id} ${lang}`), translation);
  }

  return { lang: targetLang, create, write, maxBytes: MAX_BYTES };
}

// Write beside the file, then rename over it, so a reader (or Syncthing) never
// sees a half-written transcript.
async function replace(file, text) {
  const tmp = join(file, "..", `.${file.split("/").pop()}.tmp`);
  await writeFile(tmp, text);
  await rename(tmp, file);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}
