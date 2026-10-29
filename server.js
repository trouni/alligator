// Alligator — tiny zero-dependency server.
// Serves the static app. If SONIOX_API_KEY is set, it also mints short-lived
// Soniox keys so that key never reaches the browser; otherwise each person
// adds their own key in the app's Options. If TRANSCRIPT_DIR is set, it also
// keeps each session's transcript up to date in that folder while it runs.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { transcriptStore } from "./transcripts.js";

const PORT = Number(process.env.PORT) || 5173;
const API_KEY = process.env.SONIOX_API_KEY;
const PUBLIC_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const transcripts = process.env.TRANSCRIPT_DIR
  ? transcriptStore(process.env.TRANSCRIPT_DIR, process.env.TRANSCRIPT_LANG || "en")
  : null;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function createTemporaryKey() {
  const res = await fetch("https://api.soniox.com/v1/auth/temporary-api-key", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      usage_type: "transcribe_websocket",
      expires_in_seconds: 60,
      single_use: true,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw Object.assign(
      new Error(body.error_message || `Soniox returned ${res.status}`),
      {
        status: res.status,
      },
    );
  }
  return body;
}

async function readJson(req, limit) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(new Error("Transcript too large."), { status: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Malformed JSON."), { status: 400 });
  }
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(
    typeof body === "string" || Buffer.isBuffer(body)
      ? body
      : JSON.stringify(body),
  );
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/status") {
    // Lets the page know whether this server holds a key, or whether the user
    // should add their own in Options.
    return send(res, 200, {
      serverKey: Boolean(API_KEY),
      transcripts: transcripts && { lang: transcripts.lang },
    });
  }

  if (url.pathname.startsWith("/api/transcripts")) {
    if (!transcripts) return send(res, 404, { error: "TRANSCRIPT_DIR is not set on the server." });
    const create = url.pathname === "/api/transcripts" && req.method === "POST";
    const update = url.pathname.startsWith("/api/transcripts/") && req.method === "PUT";
    if (!create && !update) return send(res, 405, { error: "Method not allowed" });
    try {
      const id = update && decodeURIComponent(url.pathname.slice("/api/transcripts/".length));
      const body = (await readJson(req, transcripts.maxBytes)) || {};
      if (create) return send(res, 200, await transcripts.create(body));
      await transcripts.write(id, body);
      return send(res, 200, { ok: true });
    } catch (err) {
      if (err instanceof URIError) err.status = 400;
      if (!err.status) console.error(err);
      return send(res, err.status || 500, { error: err.status ? err.message : "Couldn’t write the transcript." });
    }
  }

  if (url.pathname === "/api/temporary-key") {
    if (req.method !== "POST")
      return send(res, 405, { error: "Method not allowed" });
    if (!API_KEY)
      return send(res, 500, {
        error: "SONIOX_API_KEY is not set on the server.",
      });
    try {
      return send(res, 200, await createTemporaryKey());
    } catch (err) {
      return send(res, err.status || 502, { error: err.message });
    }
  }

  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  const file = join(PUBLIC_DIR, path);
  if (!file.startsWith(PUBLIC_DIR))
    return send(res, 403, "Forbidden", "text/plain");
  try {
    const data = await readFile(file);
    send(res, 200, data, TYPES[extname(file)] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
});

server.on("error", (err) => {
  if (err.code !== "EADDRINUSE") throw err;
  console.error(
    `Port ${PORT} is already in use (is Alligator already running?).\n` +
      `Stop the other process, or pick another port: PORT=5174 npm start`,
  );
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Alligator is running at http://localhost:${PORT}`);
  if (!API_KEY)
    console.log(
      "No SONIOX_API_KEY on the server: each person adds their own key in Options.",
    );
  if (transcripts)
    console.log(`Saving transcripts to ${process.env.TRANSCRIPT_DIR} (target language: ${transcripts.lang})`);
});
