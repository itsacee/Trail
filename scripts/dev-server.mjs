// Local development server for the AP Academy site.
//
// On Vercel, static files are served from the repo root and each file in
// `api/` runs as a serverless function. This script reproduces that behavior
// locally so the whole site — pages plus API endpoints — runs with a single
// `npm run dev`, no Vercel account or deploy required.
//
// Requests to `/api/<name>` are routed to `api/<name>.js` and invoked with a
// Vercel-compatible (req, res) shim. Everything else is served as a static
// file from the project root. Functions that need secrets (Stripe, Resend,
// Vercel Blob) degrade gracefully when those env vars are absent, exactly as
// they do in production before those integrations are connected.

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = process.cwd();
const API_DIR = join(ROOT, "api");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

// Collect the raw request body, then expose it the way Vercel does: parsed
// JSON (or urlencoded) object under req.body.
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function parseBody(raw, contentType) {
  if (!raw) return undefined;
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("application/json")) {
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (ct.includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  // Best effort: many clients POST JSON without the header.
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Wrap Node's ServerResponse so handlers can use the Vercel/Express-style
// helpers they were written against: res.status().json()/send()/setHeader().
function makeRes(nodeRes) {
  const res = {
    statusCode: 200,
    _headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(key, value) {
      this._headers[key.toLowerCase()] = value;
      nodeRes.setHeader(key, value);
      return this;
    },
    json(obj) {
      if (!this._headers["content-type"]) {
        this.setHeader("Content-Type", "application/json; charset=utf-8");
      }
      nodeRes.statusCode = this.statusCode;
      nodeRes.end(JSON.stringify(obj));
      return this;
    },
    send(data) {
      const payload =
        data == null
          ? ""
          : typeof data === "string" || Buffer.isBuffer(data)
          ? data
          : JSON.stringify(data);
      if (!this._headers["content-type"] && typeof payload === "string") {
        this.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      nodeRes.statusCode = this.statusCode;
      nodeRes.end(payload);
      return this;
    },
    end(data) {
      nodeRes.statusCode = this.statusCode;
      nodeRes.end(data);
      return this;
    },
  };
  return res;
}

async function runApi(name, req, nodeRes, url) {
  const file = join(API_DIR, `${name}.js`);
  // Guard against path traversal via the URL (e.g. /api/../secret).
  if (!file.startsWith(API_DIR + sep)) {
    nodeRes.statusCode = 400;
    nodeRes.end("Bad request");
    return;
  }
  try {
    await stat(file);
  } catch {
    nodeRes.statusCode = 404;
    nodeRes.setHeader("Content-Type", "application/json; charset=utf-8");
    nodeRes.end(JSON.stringify({ error: `No API route: /api/${name}` }));
    return;
  }

  let mod;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    console.error(`Failed to load api/${name}.js:`, err);
    nodeRes.statusCode = 500;
    nodeRes.end("Failed to load API route");
    return;
  }

  const handler = mod.default;
  if (typeof handler !== "function") {
    nodeRes.statusCode = 500;
    nodeRes.end(`api/${name}.js has no default export handler`);
    return;
  }

  const raw = ["GET", "HEAD"].includes(req.method) ? "" : await readBody(req);
  req.query = Object.fromEntries(url.searchParams);
  req.body = parseBody(raw, req.headers["content-type"]);

  const res = makeRes(nodeRes);
  try {
    await handler(req, res);
  } catch (err) {
    console.error(`Error in api/${name}.js:`, err);
    if (!nodeRes.headersSent) {
      nodeRes.statusCode = 500;
      nodeRes.setHeader("Content-Type", "application/json; charset=utf-8");
      nodeRes.end(JSON.stringify({ error: "Internal server error" }));
    }
  }
}

async function serveStatic(pathname, nodeRes) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  // Normalize and confine to the project root.
  const filePath = normalize(join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    nodeRes.statusCode = 403;
    nodeRes.end("Forbidden");
    return;
  }

  let target = filePath;
  try {
    const info = await stat(target);
    if (info.isDirectory()) target = join(target, "index.html");
  } catch {
    // Vercel serves clean URLs (/book -> book.html); mirror that fallback.
    if (!extname(target)) {
      target = `${filePath}.html`;
    }
  }

  try {
    const data = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] || "application/octet-stream";
    nodeRes.statusCode = 200;
    nodeRes.setHeader("Content-Type", type);
    nodeRes.end(data);
  } catch {
    nodeRes.statusCode = 404;
    nodeRes.setHeader("Content-Type", "text/html; charset=utf-8");
    nodeRes.end("<h1>404 — Not found</h1>");
  }
}

const server = createServer(async (req, nodeRes) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const { pathname } = url;

  if (pathname.startsWith("/api/")) {
    const name = pathname.slice("/api/".length).replace(/\/+$/, "");
    await runApi(name, req, nodeRes, url);
    return;
  }

  await serveStatic(pathname, nodeRes);
});

server.listen(PORT, HOST, () => {
  console.log(`AP Academy dev server running at http://${HOST}:${PORT}`);
  console.log(`Static site + /api/* serverless functions are live.`);
});
