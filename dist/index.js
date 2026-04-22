#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import sharp from "sharp";
import { createServer } from "http";
import { randomUUID } from "crypto";
import { writeFile, readFile, mkdir, readdir, copyFile, stat } from "fs/promises";
import { join, extname } from "path";
import { homedir } from "os";
const SAVE_DIR = join(homedir(), "Pictures", "pixel-surgeon");
/** Platform-aware "open URL/path in default app" with fallback chain for Linux */
function openExternal(target) {
    import("child_process").then(({ execFile }) => {
        if (process.platform === "darwin") {
            execFile("open", [target]);
        }
        else if (process.platform === "win32") {
            execFile("cmd", ["/c", "start", "", target]);
        }
        else {
            // Linux: try xdg-open, then common DE-specific openers, then browsers
            const candidates = ["xdg-open", "gio", "kde-open5", "gnome-open", "wslview"];
            (function tryNext(i) {
                if (i >= candidates.length)
                    return;
                execFile(candidates[i], [target], (err) => { if (err)
                    tryNext(i + 1); });
            })(0);
        }
    });
}
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY ?? "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";
const MODELS = {
    "gemini-3.1-flash-image": {
        id: "gemini-3.1-flash-image-preview",
        label: "Gemini 3.1 Flash Image",
        provider: "gemini",
        tier: "paid",
    },
    "gemini-2.5-flash-image": {
        id: "gemini-2.5-flash-image",
        label: "Gemini 2.5 Flash Image",
        provider: "gemini",
        tier: "free",
    },
    "gpt-image-1": {
        id: "gpt-image-1",
        label: "GPT Image 1 (OpenAI)",
        provider: "openai",
        tier: "paid",
    },
    "gpt-image-2": {
        id: "gpt-image-2",
        label: "GPT Image 2 (OpenAI)",
        provider: "openai",
        tier: "paid",
    },
};
const MODEL_KEYS = Object.keys(MODELS);
const GEMINI_DEFAULT = "gemini-3.1-flash-image";
const GEMINI_FALLBACK = "gemini-2.5-flash-image";
const MODEL_PRIMARY = MODELS[GEMINI_DEFAULT].id;
const MODEL_FALLBACK = MODELS[GEMINI_FALLBACK].id;
function isGeminiModel(modelId) {
    const entry = Object.values(MODELS).find(m => m.id === modelId);
    return entry?.provider === "gemini";
}
function getDefaultModelKey() {
    const envModel = process.env.DEFAULT_IMAGE_MODEL;
    if (envModel && envModel in MODELS)
        return envModel;
    return GEMINI_DEFAULT;
}
const providers = {};
function getProvider(modelKey) {
    const key = modelKey ?? getDefaultModelKey();
    const entry = MODELS[key];
    if (!entry)
        throw new Error(`Unknown model "${key}". Available: ${MODEL_KEYS.join(", ")}`);
    const provider = providers[entry.provider];
    if (!provider) {
        const envHint = entry.provider === "gemini" ? "GOOGLE_API_KEY" : "OPENAI_API_KEY";
        throw new Error(`Provider "${entry.provider}" not available. Set ${envHint} env var.`);
    }
    return { provider, modelId: entry.id, modelKey: key };
}
const geminiEndpoint = (model) => `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
const RESPIN_SIZES = ["512", "1K", "2K", "4K"];
const RESPIN_ASPECTS = ["1:1", "16:9", "9:16", "3:4", "4:3", "2:3", "3:2", "4:5", "5:4"];
const VEO_MODEL = "veo-3.1-generate-preview";
const VEO_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VEO_ENDPOINT = `${VEO_BASE}/models/${VEO_MODEL}:predictLongRunning`;
const VEO_POLL_INTERVAL = 10_000; // 10 seconds
const VEO_MAX_POLLS = 60; // 10 minutes max
const MAX_MCP_BYTES = 950_000;
function log(msg) {
    console.error(`[pixel-surgeon ${new Date().toISOString()}] ${msg}`);
}
const imageStore = [];
const videoStore = [];
let viewerPort = null;
const sseClients = new Set();
const pendingSelections = new Map();
const pendingCrops = new Map();
function notifyViewerClients(img) {
    void writeSidecar(img);
    const event = JSON.stringify({ id: img.id, prompt: img.prompt, type: "image", modelUsed: img.modelUsed, imageSize: img.imageSize, aspectRatio: img.aspectRatio });
    for (const client of sseClients) {
        client.write(`data: ${event}\n\n`);
    }
}
async function writeSidecar(img) {
    const sidecarName = img.filename.replace(/\.[^./]+$/, "") + ".json";
    const meta = {
        id: img.id,
        filename: img.filename,
        prompt: img.prompt,
        aspectRatio: img.aspectRatio ?? null,
        imageSize: img.imageSize ?? null,
        modelUsed: img.modelUsed ?? null,
        timestamp: img.timestamp,
    };
    try {
        await writeFile(join(SAVE_DIR, sidecarName), JSON.stringify(meta, null, 2));
    }
    catch (err) {
        log(`sidecar write failed for ${img.filename}: ${err instanceof Error ? err.message : String(err)}`);
    }
}
function notifyViewerClientsVideo(vid) {
    const event = JSON.stringify({ id: vid.id, prompt: vid.prompt, type: "video", filename: vid.filename });
    for (const client of sseClients) {
        client.write(`data: ${event}\n\n`);
    }
}
function startViewer() {
    return new Promise((resolve) => {
        const srv = createServer((req, res) => {
            const url = new URL(req.url ?? "/", `http://localhost`);
            if (url.pathname.startsWith("/img/")) {
                const id = url.pathname.slice(5);
                const img = imageStore.find((i) => i.id === id);
                if (img) {
                    res.writeHead(200, {
                        "Content-Type": "image/png",
                        "Cache-Control": "public, max-age=31536000, immutable",
                    });
                    res.end(img.fullPng);
                    return;
                }
                res.writeHead(404);
                res.end("Not found");
                return;
            }
            // Serve image files directly from disk by filename
            if (url.pathname.startsWith("/file/")) {
                const fname = decodeURIComponent(url.pathname.slice(6));
                const fpath = join(SAVE_DIR, fname);
                readFile(fpath)
                    .then((buf) => {
                    const ext = extname(fname).toLowerCase();
                    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
                    res.writeHead(200, { "Content-Type": mime, "Cache-Control": "public, max-age=31536000, immutable" });
                    res.end(buf);
                })
                    .catch(() => {
                    res.writeHead(404);
                    res.end("Not found");
                });
                return;
            }
            // Serve video files by filename
            if (url.pathname.startsWith("/video/")) {
                const fname = decodeURIComponent(url.pathname.slice(7));
                const fpath = join(SAVE_DIR, fname);
                readFile(fpath)
                    .then((buf) => {
                    res.writeHead(200, {
                        "Content-Type": "video/mp4",
                        "Content-Length": buf.length.toString(),
                        "Cache-Control": "public, max-age=31536000, immutable",
                    });
                    res.end(buf);
                })
                    .catch(() => {
                    res.writeHead(404);
                    res.end("Not found");
                });
                return;
            }
            // Interactive crop UI
            if (url.pathname.startsWith("/crop/")) {
                const fname = decodeURIComponent(url.pathname.slice(6));
                res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
                res.end(cropHtml(fname));
                return;
            }
            // Crop submission endpoint
            if (url.pathname === "/crop-submit" && req.method === "POST") {
                let body = "";
                req.on("data", (chunk) => { body += chunk.toString(); });
                req.on("end", async () => {
                    try {
                        const data = JSON.parse(body);
                        const { filename, x, y, width, height, prompt, shots } = data;
                        const pending = pendingCrops.get(filename);
                        if (pending) {
                            // Resolve the MCP tool's await with the crop data
                            pending.resolve({ x, y, width, height, prompt: prompt || "", shots: Math.max(1, Math.min(5, shots || 1)) });
                            // Hold this HTTP response open until Gemini processing completes
                            const result = await pending.onComplete;
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify(result));
                        }
                        else {
                            res.writeHead(404, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "No pending crop for this filename" }));
                        }
                    }
                    catch {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Invalid JSON" }));
                    }
                });
                return;
            }
            // Selection endpoint — user picks their preferred shot
            if (url.pathname === "/crop-select" && req.method === "POST") {
                let body = "";
                req.on("data", (chunk) => { body += chunk.toString(); });
                req.on("end", () => {
                    try {
                        const data = JSON.parse(body);
                        const { filename, selectedIndex } = data;
                        const pending = pendingSelections.get(filename);
                        if (pending) {
                            pending.resolve(selectedIndex);
                            pendingSelections.delete(filename);
                            res.writeHead(200, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ ok: true, filename: pending.filenames[selectedIndex] }));
                        }
                        else {
                            res.writeHead(404, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "No pending selection for this filename" }));
                        }
                    }
                    catch {
                        res.writeHead(400, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: "Invalid JSON" }));
                    }
                });
                return;
            }
            if (url.pathname === "/open-folder") {
                openExternal(SAVE_DIR);
                res.writeHead(204);
                res.end();
                return;
            }
            // History — paginated/searchable listing of persisted image sidecars
            if (url.pathname === "/history" && req.method === "GET") {
                (async () => {
                    try {
                        const offset = Math.max(0, parseInt(url.searchParams.get("offset") ?? "0", 10) || 0);
                        const limit = Math.min(500, Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20));
                        const q = (url.searchParams.get("q") ?? "").toLowerCase().trim();
                        await ensureSaveDir();
                        const files = await readdir(SAVE_DIR);
                        const jsonFiles = files.filter((f) => f.endsWith(".json")).sort().reverse();
                        const readMeta = async (f) => {
                            try {
                                const raw = await readFile(join(SAVE_DIR, f), "utf-8");
                                return JSON.parse(raw);
                            }
                            catch {
                                return null;
                            }
                        };
                        let items;
                        let total;
                        if (q) {
                            const all = [];
                            for (const f of jsonFiles) {
                                const meta = await readMeta(f);
                                if (meta && (meta.prompt ?? "").toLowerCase().includes(q))
                                    all.push(meta);
                            }
                            total = all.length;
                            items = all.slice(offset, offset + limit);
                        }
                        else {
                            total = jsonFiles.length;
                            const slice = jsonFiles.slice(offset, offset + limit);
                            const loaded = await Promise.all(slice.map(readMeta));
                            items = loaded.filter((m) => m !== null);
                        }
                        const hasMore = offset + items.length < total;
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ items, total, hasMore, offset, limit }));
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: msg }));
                    }
                })();
                return;
            }
            // Respin endpoint — regenerate an image with the same prompt
            if (url.pathname === "/respin" && req.method === "POST") {
                let body = "";
                req.on("data", (chunk) => { body += chunk.toString(); });
                req.on("end", async () => {
                    try {
                        const { id, prompt: customPrompt, size, aspect, model: respinModel } = JSON.parse(body);
                        const source = id ? imageStore.find((i) => i.id === id) : undefined;
                        const finalPrompt = (customPrompt && customPrompt.trim())
                            ? customPrompt.trim()
                            : source?.prompt;
                        if (!finalPrompt) {
                            res.writeHead(400, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "No prompt provided and source not in live store" }));
                            return;
                        }
                        const finalSize = (typeof size === "string" && size) ? size : (source?.imageSize ?? "1K");
                        const finalAspect = (typeof aspect === "string" && aspect) ? aspect : (source?.aspectRatio ?? "1:1");
                        const finalModel = (typeof respinModel === "string" && respinModel in MODELS) ? respinModel : undefined;
                        log(`respin: re-generating from "${finalPrompt.slice(0, 80)}..." (${finalSize}, ${finalAspect}${finalModel ? `, model=${finalModel}` : ""})`);
                        const result = await generateAndStore(finalPrompt, finalAspect, finalSize, finalModel);
                        res.writeHead(200, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ ok: true, id: imageStore[imageStore.length - 1].id, filename: result.filename }));
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        log(`respin error: ${msg}`);
                        res.writeHead(500, { "Content-Type": "application/json" });
                        res.end(JSON.stringify({ error: msg }));
                    }
                });
                return;
            }
            if (url.pathname === "/events") {
                res.writeHead(200, {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    Connection: "keep-alive",
                });
                const interval = setInterval(() => res.write(":\n\n"), 30000);
                sseClients.add(res);
                req.on("close", () => {
                    clearInterval(interval);
                    sseClients.delete(res);
                });
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(viewerHtml());
        });
        srv.listen(0, "127.0.0.1", () => {
            const addr = srv.address();
            const port = typeof addr === "object" && addr ? addr.port : 0;
            resolve(port);
        });
    });
}
function viewerHtml() {
    const items = [
        ...imageStore.map((i) => ({ type: "image", data: i })),
        ...videoStore.map((v) => ({ type: "video", data: v })),
    ].sort((a, b) => b.data.timestamp - a.data.timestamp);
    const itemTags = items
        .map((item) => {
        if (item.type === "video") {
            const vid = item.data;
            return `<div class="img-entry" id="vid-${vid.id}">
          <div class="prompt-row">
            <textarea class="prompt-edit" readonly>${esc(vid.prompt)}</textarea>
            <span class="video-badge">VIDEO</span>
          </div>
          <video src="/video/${encodeURIComponent(vid.filename)}" controls loop playsinline style="max-width:100%;"></video>
        </div>`;
        }
        const img = item.data;
        const isFallback = img.modelUsed && img.modelUsed !== MODEL_PRIMARY && isGeminiModel(img.modelUsed);
        const fallbackBanner = isFallback
            ? `<div class="fallback-banner">⚠️ Generated with <strong>${esc(img.modelUsed)}</strong> (free-tier fallback). Upgrade to <strong>${esc(MODEL_PRIMARY)}</strong> for higher-quality imagegen — <a href="https://aistudio.google.com/" target="_blank">top up credits</a>.</div>`
            : "";
        const curSize = img.imageSize ?? "1K";
        const curAspect = img.aspectRatio ?? "1:1";
        const curModel = img.modelUsed ?? "";
        const sizeOpts = RESPIN_SIZES.map(s => `<option value="${s}"${s === curSize ? " selected" : ""}>${s}</option>`).join("");
        const aspectOpts = RESPIN_ASPECTS.map(a => `<option value="${a}"${a === curAspect ? " selected" : ""}>${a}</option>`).join("");
        const modelOpts = MODEL_KEYS.map(k => `<option value="${k}"${MODELS[k].id === curModel ? " selected" : ""}>${esc(MODELS[k].label)}</option>`).join("");
        return `<div class="img-entry" id="img-${img.id}">
          <div class="prompt-row">
            <textarea class="prompt-edit" data-id="${img.id}">${esc(img.prompt)}</textarea>
            <div class="respin-controls">
              <select class="respin-select" data-size="${img.id}" title="Resolution">${sizeOpts}</select>
              <select class="respin-select" data-aspect="${img.id}" title="Aspect ratio">${aspectOpts}</select>
              <select class="respin-select" data-model="${img.id}" title="Model">${modelOpts}</select>
              <button class="respin-btn" onclick="respin('${img.id}', this)" title="Regenerate (edit prompt / size / aspect above)">&#x21bb; Respin</button>
            </div>
          </div>
          ${fallbackBanner}
          <div class="img-wrapper">
            <span class="model-label">${esc(curModel)}</span>
            <img src="/img/${img.id}" />
          </div>
        </div>`;
    })
        .join("\n");
    return `<!DOCTYPE html>
<html><head><title>pixel-surgeon-mcp</title>
<style>
  body { margin: 20px; background: #1a1a1a; color: #ccc; font-family: system-ui; }
  img { max-width: 100%; }
  video { max-width: 100%; border-radius: 4px; }
  div.img-entry { margin-bottom: 24px; }
  p { margin: 0 0 8px 0; font-size: 14px; color: #999; }
  #empty { display: ${items.length === 0 ? "block" : "none"}; }
  #open-folder { background: #333; color: #ccc; border: 1px solid #555; padding: 8px 16px; cursor: pointer; font-size: 14px; font-family: system-ui; margin-bottom: 20px; }
  #open-folder:hover { background: #444; }
  .prompt-row { display: flex; gap: 8px; align-items: flex-start; margin-bottom: 8px; }
  .prompt-edit { flex: 1; background: #252525; color: #bbb; border: 1px solid #444; padding: 8px; font-size: 13px; font-family: system-ui; border-radius: 4px; resize: vertical; min-height: 48px; line-height: 1.4; }
  .prompt-edit:focus { border-color: #3a6a9b; color: #ddd; outline: none; }
  .respin-controls { display: flex; flex-direction: column; gap: 4px; align-self: flex-start; }
  .respin-select { background: #252525; color: #bbb; border: 1px solid #444; padding: 4px 6px; font-size: 12px; font-family: system-ui; border-radius: 4px; cursor: pointer; min-width: 72px; }
  .respin-select:hover { border-color: #3a6a9b; color: #ddd; }
  .respin-btn { background: #2a4a6b; color: #8bc4ff; border: 1px solid #3a6a9b; padding: 8px 16px; cursor: pointer; font-size: 13px; font-family: system-ui; border-radius: 4px; transition: all 0.15s; white-space: nowrap; }
  .respin-btn:hover { background: #3a6a9b; color: #fff; }
  .respin-btn:disabled { opacity: 0.5; cursor: wait; }
  .video-badge { background: #6b2a2a; color: #ff8b8b; border: 1px solid #9b3a3a; padding: 8px 16px; font-size: 11px; font-family: system-ui; border-radius: 4px; white-space: nowrap; align-self: flex-start; font-weight: 600; letter-spacing: 0.5px; }
  .img-wrapper { position: relative; }
  .model-label { position: absolute; top: 8px; left: 8px; background: rgba(0,0,0,0.7); color: #8bc4ff; padding: 3px 8px; font-size: 11px; font-family: monospace; border-radius: 3px; z-index: 1; pointer-events: none; }
  .fallback-banner { background: #3a2e12; color: #f0c066; border: 1px solid #7a5c20; padding: 8px 12px; font-size: 12px; border-radius: 4px; margin-bottom: 8px; line-height: 1.5; }
  .fallback-banner a { color: #ffd988; text-decoration: underline; }
  .fallback-banner strong { color: #ffdf9e; }
  .tabs { display: flex; gap: 4px; margin-bottom: 16px; border-bottom: 1px solid #333; }
  .tab-btn { background: transparent; color: #888; border: none; border-bottom: 2px solid transparent; padding: 10px 18px; cursor: pointer; font-size: 14px; font-family: system-ui; transition: all 0.15s; }
  .tab-btn:hover { color: #ccc; }
  .tab-btn.active { color: #8bc4ff; border-bottom-color: #3a6a9b; }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }
  .history-toolbar { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; flex-wrap: wrap; }
  .history-search { flex: 1; min-width: 240px; background: #252525; color: #ddd; border: 1px solid #444; padding: 8px 12px; font-size: 13px; font-family: system-ui; border-radius: 4px; }
  .history-search:focus { border-color: #3a6a9b; outline: none; }
  .history-status { color: #777; font-size: 12px; }
  .history-load-more { background: #2a4a6b; color: #8bc4ff; border: 1px solid #3a6a9b; padding: 10px 24px; cursor: pointer; font-size: 13px; font-family: system-ui; border-radius: 4px; margin: 16px auto; display: block; }
  .history-load-more:hover { background: #3a6a9b; color: #fff; }
  .history-load-more:disabled { opacity: 0.5; cursor: wait; }
  .history-entry { margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid #2a2a2a; }
  .history-meta { color: #777; font-size: 11px; font-family: ui-monospace, monospace; margin-top: 4px; }
  .history-prompt { background: #252525; color: #bbb; border: 1px solid #444; padding: 8px; font-size: 12px; border-radius: 4px; margin-bottom: 8px; max-height: 140px; overflow-y: auto; white-space: pre-wrap; line-height: 1.4; }
</style></head><body>
<div class="tabs">
  <button class="tab-btn active" data-tab="live" onclick="switchTab('live')">Live</button>
  <button class="tab-btn" data-tab="history" onclick="switchTab('history')">History</button>
</div>
<div class="tab-pane active" id="tab-live">
  <button id="open-folder" onclick="fetch('/open-folder',{method:'POST'})">Open in Finder</button>
  <p id="empty">Waiting for images...</p>
  <div id="gallery">${itemTags}</div>
</div>
<div class="tab-pane" id="tab-history">
  <div class="history-toolbar">
    <input class="history-search" id="history-search" type="text" placeholder="Search prompts..." />
    <span class="history-status" id="history-status"></span>
  </div>
  <div id="history-gallery"></div>
  <button class="history-load-more" id="history-load-more" style="display:none;" onclick="loadMoreHistory()">Load 100 more</button>
</div>
<script>
const gallery = document.getElementById("gallery");
const empty = document.getElementById("empty");
const es = new EventSource("/events");
const PRIMARY_MODEL = ${JSON.stringify(MODEL_PRIMARY)};
const RESPIN_SIZES = ${JSON.stringify(RESPIN_SIZES)};
const RESPIN_ASPECTS = ${JSON.stringify(RESPIN_ASPECTS)};
const MODEL_OPTIONS = ${JSON.stringify(MODEL_KEYS.map(k => ({ key: k, label: MODELS[k].label, id: MODELS[k].id })))};
es.onmessage = (e) => {
  const data = JSON.parse(e.data);
  const { id, prompt, type, filename, modelUsed } = data;
  empty.style.display = "none";
  const div = document.createElement("div");
  div.className = "img-entry";

  if (type === "video") {
    div.id = "vid-" + id;
    const row = document.createElement("div");
    row.className = "prompt-row";
    const ta = document.createElement("textarea");
    ta.className = "prompt-edit";
    ta.readOnly = true;
    ta.value = prompt;
    const badge = document.createElement("span");
    badge.className = "video-badge";
    badge.textContent = "VIDEO";
    row.appendChild(ta);
    row.appendChild(badge);
    const vid = document.createElement("video");
    vid.src = "/video/" + encodeURIComponent(filename);
    vid.controls = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.style.maxWidth = "100%";
    div.appendChild(row);
    div.appendChild(vid);
  } else {
    div.id = "img-" + id;
    const row = document.createElement("div");
    row.className = "prompt-row";
    const ta = document.createElement("textarea");
    ta.className = "prompt-edit";
    ta.dataset.id = id;
    ta.value = prompt;
    const controls = document.createElement("div");
    controls.className = "respin-controls";
    const curSize = data.imageSize || "1K";
    const curAspect = data.aspectRatio || "1:1";
    const sizeSel = document.createElement("select");
    sizeSel.className = "respin-select";
    sizeSel.dataset.size = id;
    sizeSel.title = "Resolution";
    RESPIN_SIZES.forEach(function(s) {
      const o = document.createElement("option");
      o.value = s; o.textContent = s;
      if (s === curSize) o.selected = true;
      sizeSel.appendChild(o);
    });
    const aspectSel = document.createElement("select");
    aspectSel.className = "respin-select";
    aspectSel.dataset.aspect = id;
    aspectSel.title = "Aspect ratio";
    RESPIN_ASPECTS.forEach(function(a) {
      const o = document.createElement("option");
      o.value = a; o.textContent = a;
      if (a === curAspect) o.selected = true;
      aspectSel.appendChild(o);
    });
    const btn = document.createElement("button");
    btn.className = "respin-btn";
    btn.innerHTML = "&#x21bb; Respin";
    btn.title = "Regenerate (edit prompt / size / aspect above)";
    btn.onclick = function() { respin(id, this); };
    const modelSel = document.createElement("select");
    modelSel.className = "respin-select";
    modelSel.dataset.model = id;
    modelSel.title = "Model";
    MODEL_OPTIONS.forEach(function(m) {
      const o = document.createElement("option");
      o.value = m.key; o.textContent = m.label;
      if (m.id === modelUsed) o.selected = true;
      modelSel.appendChild(o);
    });
    controls.appendChild(sizeSel);
    controls.appendChild(aspectSel);
    controls.appendChild(modelSel);
    controls.appendChild(btn);
    row.appendChild(ta);
    row.appendChild(controls);
    div.appendChild(row);
    if (modelUsed && modelUsed !== PRIMARY_MODEL && modelUsed.startsWith('gemini')) {
      const banner = document.createElement("div");
      banner.className = "fallback-banner";
      banner.innerHTML = '\u26A0\uFE0F Generated with <strong>' + modelUsed + '</strong> (free-tier fallback). Upgrade to <strong>' + PRIMARY_MODEL + '</strong> for higher-quality imagegen \u2014 <a href="https://aistudio.google.com/" target="_blank">top up credits</a>.';
      div.appendChild(banner);
    }
    const wrapper = document.createElement("div");
    wrapper.className = "img-wrapper";
    const label = document.createElement("span");
    label.className = "model-label";
    label.textContent = modelUsed || "";
    wrapper.appendChild(label);
    const img = document.createElement("img");
    img.src = "/img/" + id;
    wrapper.appendChild(img);
    div.appendChild(wrapper);
  }
  gallery.prepend(div);
};
async function respin(id, btn) {
  btn.disabled = true;
  btn.textContent = "Generating...";
  const ta = document.querySelector('textarea[data-id="' + id + '"]');
  const prompt = ta ? ta.value : undefined;
  const sizeEl = document.querySelector('select[data-size="' + id + '"]');
  const aspectEl = document.querySelector('select[data-aspect="' + id + '"]');
  const modelEl = document.querySelector('select[data-model="' + id + '"]');
  const size = sizeEl ? sizeEl.value : undefined;
  const aspect = aspectEl ? aspectEl.value : undefined;
  const model = modelEl ? modelEl.value : undefined;
  try {
    const res = await fetch("/respin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, prompt, size, aspect, model }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Respin failed");
    btn.textContent = "\u21bb Respin";
    btn.disabled = false;
  } catch (err) {
    btn.textContent = "Failed — retry?";
    btn.disabled = false;
  }
}

// === Tabs + History ===
const HISTORY_INITIAL = 20;
const HISTORY_PAGE = 100;
const historyState = { offset: 0, query: "", total: 0, hasMore: false, loaded: false, pending: false };

function switchTab(name) {
  document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach(p => p.classList.toggle("active", p.id === "tab-" + name));
  if (name === "history" && !historyState.loaded) {
    historyState.loaded = true;
    resetAndLoadHistory(HISTORY_INITIAL);
  }
}

function escHtml(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtTs(ts) {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString(); } catch { return ""; }
}

async function resetAndLoadHistory(limit) {
  historyState.offset = 0;
  historyState.total = 0;
  historyState.hasMore = false;
  document.getElementById("history-gallery").innerHTML = "";
  await fetchHistoryPage(limit);
}

async function fetchHistoryPage(limit) {
  if (historyState.pending) return;
  historyState.pending = true;
  const btn = document.getElementById("history-load-more");
  const statusEl = document.getElementById("history-status");
  if (btn) btn.disabled = true;
  statusEl.textContent = "Loading...";
  try {
    const params = new URLSearchParams();
    params.set("offset", String(historyState.offset));
    params.set("limit", String(limit));
    if (historyState.query) params.set("q", historyState.query);
    const res = await fetch("/history?" + params.toString());
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "History fetch failed");
    historyState.total = data.total;
    historyState.hasMore = data.hasMore;
    historyState.offset += data.items.length;
    renderHistoryItems(data.items);
    statusEl.textContent = historyState.total + " match" + (historyState.total === 1 ? "" : "es") + " · showing " + historyState.offset;
    if (btn) btn.style.display = historyState.hasMore ? "block" : "none";
    if (historyState.total === 0) {
      document.getElementById("history-gallery").innerHTML = '<p style="color:#777;padding:20px 0;">No images found.</p>';
    }
  } catch (err) {
    statusEl.textContent = "Error: " + (err && err.message ? err.message : "failed");
  } finally {
    historyState.pending = false;
    if (btn) btn.disabled = false;
  }
}

function renderHistoryItems(items) {
  const gallery = document.getElementById("history-gallery");
  for (const it of items) {
    const div = document.createElement("div");
    div.className = "history-entry";
    const key = it.filename || "";
    const curSize = it.imageSize || "1K";
    const curAspect = it.aspectRatio || "1:1";
    const meta = [fmtTs(it.timestamp), curSize, curAspect, it.modelUsed || "?"].filter(Boolean).join(" · ");

    const row = document.createElement("div");
    row.className = "prompt-row";
    const ta = document.createElement("textarea");
    ta.className = "prompt-edit";
    ta.dataset.histId = key;
    ta.value = it.prompt || "";
    const controls = document.createElement("div");
    controls.className = "respin-controls";
    const sizeSel = document.createElement("select");
    sizeSel.className = "respin-select";
    sizeSel.dataset.histSize = key;
    sizeSel.title = "Resolution";
    RESPIN_SIZES.forEach((s) => {
      const o = document.createElement("option");
      o.value = s; o.textContent = s;
      if (s === curSize) o.selected = true;
      sizeSel.appendChild(o);
    });
    const aspectSel = document.createElement("select");
    aspectSel.className = "respin-select";
    aspectSel.dataset.histAspect = key;
    aspectSel.title = "Aspect ratio";
    RESPIN_ASPECTS.forEach((a) => {
      const o = document.createElement("option");
      o.value = a; o.textContent = a;
      if (a === curAspect) o.selected = true;
      aspectSel.appendChild(o);
    });
    const btn = document.createElement("button");
    btn.className = "respin-btn";
    btn.innerHTML = "&#x21bb; Respin";
    btn.title = "Regenerate and switch to Live tab";
    btn.onclick = function () { respinHistory(key, this); };
    const modelSel = document.createElement("select");
    modelSel.className = "respin-select";
    modelSel.dataset.histModel = key;
    modelSel.title = "Model";
    MODEL_OPTIONS.forEach((m) => {
      const o = document.createElement("option");
      o.value = m.key; o.textContent = m.label;
      if (m.id === (it.modelUsed || "")) o.selected = true;
      modelSel.appendChild(o);
    });
    controls.appendChild(sizeSel);
    controls.appendChild(aspectSel);
    controls.appendChild(modelSel);
    controls.appendChild(btn);
    row.appendChild(ta);
    row.appendChild(controls);

    const metaDiv = document.createElement("div");
    metaDiv.className = "history-meta";
    metaDiv.textContent = (it.filename || "") + " · " + meta;

    const wrapper = document.createElement("div");
    wrapper.className = "img-wrapper";
    const label = document.createElement("span");
    label.className = "model-label";
    label.textContent = it.modelUsed || "";
    wrapper.appendChild(label);
    const img = document.createElement("img");
    img.src = "/file/" + encodeURIComponent(key);
    img.loading = "lazy";
    wrapper.appendChild(img);

    div.appendChild(row);
    div.appendChild(metaDiv);
    div.appendChild(wrapper);
    gallery.appendChild(div);
  }
}

async function respinHistory(key, btn) {
  btn.disabled = true;
  btn.textContent = "Generating...";
  const ta = document.querySelector('textarea[data-hist-id="' + key + '"]');
  const sizeEl = document.querySelector('select[data-hist-size="' + key + '"]');
  const aspectEl = document.querySelector('select[data-hist-aspect="' + key + '"]');
  const modelEl = document.querySelector('select[data-hist-model="' + key + '"]');
  const prompt = ta ? ta.value : undefined;
  const size = sizeEl ? sizeEl.value : undefined;
  const aspect = aspectEl ? aspectEl.value : undefined;
  const model = modelEl ? modelEl.value : undefined;
  if (!prompt || !prompt.trim()) {
    btn.textContent = "Need prompt";
    btn.disabled = false;
    return;
  }
  switchTab("live");
  try {
    const res = await fetch("/respin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, size, aspect, model }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Respin failed");
    btn.textContent = "\u21bb Respin";
    btn.disabled = false;
  } catch (err) {
    btn.textContent = "Failed — retry?";
    btn.disabled = false;
  }
}

async function loadMoreHistory() {
  await fetchHistoryPage(HISTORY_PAGE);
}

let searchDebounce;
document.addEventListener("DOMContentLoaded", () => {
  const searchEl = document.getElementById("history-search");
  if (searchEl) {
    searchEl.addEventListener("input", (e) => {
      clearTimeout(searchDebounce);
      const val = e.target.value;
      searchDebounce = setTimeout(() => {
        historyState.query = val.trim();
        resetAndLoadHistory(HISTORY_INITIAL);
      }, 250);
    });
  }
});
</script>
</body></html>`;
}
function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function cropHtml(filename) {
    return `<!DOCTYPE html>
<html><head><title>Fix Region — ${esc(filename)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #111; color: #ccc; font-family: system-ui; display: flex; flex-direction: column; height: 100vh; }
  .toolbar { padding: 12px 16px; background: #1a1a1a; border-bottom: 1px solid #333; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
  .toolbar h2 { font-size: 15px; color: #eee; margin-right: 8px; }
  .toolbar label { font-size: 13px; color: #999; }
  .toolbar textarea { flex: 1; min-width: 300px; height: 56px; background: #222; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 8px; font-size: 13px; font-family: system-ui; resize: vertical; }
  .toolbar button { background: #2d7d46; color: #fff; border: none; padding: 10px 24px; border-radius: 4px; font-size: 14px; cursor: pointer; font-weight: 600; }
  .toolbar button:hover { background: #38a55a; }
  .toolbar button:disabled { background: #555; cursor: not-allowed; }
  .toolbar select { background: #222; color: #eee; border: 1px solid #444; border-radius: 4px; padding: 6px 8px; font-size: 13px; }
  .canvas-wrap { flex: 1; overflow: auto; position: relative; display: flex; align-items: flex-start; justify-content: center; padding: 16px; flex-wrap: wrap; gap: 16px; }
  canvas { cursor: crosshair; max-width: 100%; }
  .coords { font-size: 12px; color: #666; min-width: 180px; text-align: right; }
  .status { font-size: 13px; color: #ffcc00; padding: 8px 16px; background: #1a1a1a; border-top: 1px solid #333; }
  .results { display: flex; gap: 12px; flex-wrap: wrap; width: 100%; }
  .results img { max-width: 48%; border: 2px solid transparent; border-radius: 4px; cursor: pointer; }
  .results img:hover { border-color: #4caf50; }
  .results img.selected { border-color: #4caf50; box-shadow: 0 0 12px rgba(76,175,80,0.5); }
  .status.done { color: #4caf50; }
  .status.error { color: #f44336; }
</style></head><body>
<div class="toolbar">
  <h2>Select region to fix</h2>
  <label>Notes / instructions:</label>
  <textarea id="prompt" placeholder="e.g. '36GB should be 96GB', 'fix the garbled text in this section'">Clean up and fix any garbled, glitched, or distorted text. Preserve style, colors, and layout.</textarea>
  <label>Shots:</label>
  <select id="shots">
    <option value="1">1</option>
    <option value="2">2</option>
    <option value="3" selected>3</option>
    <option value="4">4</option>
    <option value="5">5</option>
  </select>
  <button id="submit" disabled>Submit Region</button>
  <div class="coords" id="coords">Draw a rectangle on the image</div>
</div>
<div class="canvas-wrap">
  <canvas id="canvas"></canvas>
</div>
<div class="status" id="status">Loading image...</div>
<script>
const filename = ${JSON.stringify(filename)};
const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
const coordsEl = document.getElementById("coords");
const statusEl = document.getElementById("status");
const submitBtn = document.getElementById("submit");
const promptEl = document.getElementById("prompt");

const img = new Image();
img.onload = () => {
  // Scale to fit viewport while keeping full resolution for coordinates
  const maxW = window.innerWidth - 32;
  const maxH = window.innerHeight - 160;
  const scale = Math.min(1, maxW / img.width, maxH / img.height);
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.dataset.scale = scale;
  canvas.dataset.imgW = img.width;
  canvas.dataset.imgH = img.height;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  statusEl.textContent = img.width + "x" + img.height + " — click and drag to select a region";
};
img.src = "/file/" + encodeURIComponent(filename);

let drawing = false;
let startX = 0, startY = 0, endX = 0, endY = 0;
let hasSelection = false;

canvas.addEventListener("mousedown", (e) => {
  const rect = canvas.getBoundingClientRect();
  startX = e.clientX - rect.left;
  startY = e.clientY - rect.top;
  drawing = true;
  hasSelection = false;
  submitBtn.disabled = true;
});

canvas.addEventListener("mousemove", (e) => {
  if (!drawing) return;
  const rect = canvas.getBoundingClientRect();
  endX = e.clientX - rect.left;
  endY = e.clientY - rect.top;
  redraw();
});

canvas.addEventListener("mouseup", (e) => {
  if (!drawing) return;
  drawing = false;
  const rect = canvas.getBoundingClientRect();
  endX = e.clientX - rect.left;
  endY = e.clientY - rect.top;
  const sel = getSelection();
  if (sel.w > 5 && sel.h > 5) {
    hasSelection = true;
    submitBtn.disabled = false;
    redraw();
  }
});

function getSelection() {
  const x = Math.min(startX, endX);
  const y = Math.min(startY, endY);
  const w = Math.abs(endX - startX);
  const h = Math.abs(endY - startY);
  return { x, y, w, h };
}

function toPercent(sel) {
  const cw = canvas.width;
  const ch = canvas.height;
  return {
    x: (sel.x / cw) * 100,
    y: (sel.y / ch) * 100,
    width: (sel.w / cw) * 100,
    height: (sel.h / ch) * 100,
  };
}

function redraw() {
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const sel = getSelection();
  if (sel.w > 2 && sel.h > 2) {
    // Dim everything outside selection
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.fillRect(0, 0, canvas.width, sel.y); // top
    ctx.fillRect(0, sel.y + sel.h, canvas.width, canvas.height - sel.y - sel.h); // bottom
    ctx.fillRect(0, sel.y, sel.x, sel.h); // left
    ctx.fillRect(sel.x + sel.w, sel.y, canvas.width - sel.x - sel.w, sel.h); // right

    // Selection border
    ctx.strokeStyle = "#4caf50";
    ctx.lineWidth = 2;
    ctx.strokeRect(sel.x, sel.y, sel.w, sel.h);

    const pct = toPercent(sel);
    coordsEl.textContent = pct.x.toFixed(1) + "%, " + pct.y.toFixed(1) + "% — " + pct.width.toFixed(1) + "% x " + pct.height.toFixed(1) + "%";
  }
}

submitBtn.addEventListener("click", async () => {
  if (!hasSelection) return;
  const sel = getSelection();
  const pct = toPercent(sel);
  submitBtn.disabled = true;
  submitBtn.textContent = "Processing...";
  statusEl.textContent = "Sending region to Gemini for fixing...";
  statusEl.className = "status";

  const shotsVal = parseInt(document.getElementById("shots").value, 10);
  try {
    statusEl.textContent = "Region submitted — generating " + shotsVal + " shot(s) with Gemini...";
    statusEl.className = "status";
    const resp = await fetch("/crop-submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename,
        x: pct.x,
        y: pct.y,
        width: pct.width,
        height: pct.height,
        prompt: promptEl.value,
        shots: shotsVal,
      }),
    });
    const result = await resp.json();
    if (result.ok) {
      if (result.filenames && result.filenames.length > 1) {
        statusEl.textContent = result.filenames.length + " shots ready — click to select the best one, then click Use Selected";
        statusEl.className = "status done";
        const wrap = document.querySelector(".canvas-wrap");
        const resultsDiv = document.createElement("div");
        resultsDiv.className = "results";
        let selectedIdx = 0;
        result.filenames.forEach((fn, i) => {
          const img = document.createElement("img");
          img.src = "/file/" + encodeURIComponent(fn);
          img.title = "Shot " + (i + 1) + ": " + fn;
          if (i === 0) img.classList.add("selected");
          img.addEventListener("click", () => {
            resultsDiv.querySelectorAll("img").forEach(el => el.classList.remove("selected"));
            img.classList.add("selected");
            selectedIdx = i;
          });
          resultsDiv.appendChild(img);
        });
        wrap.appendChild(resultsDiv);
        // Add "Use Selected" button
        const useBtn = document.createElement("button");
        useBtn.textContent = "Use Selected";
        useBtn.style.cssText = "background:#2d7d46;color:#fff;border:none;padding:10px 24px;border-radius:4px;font-size:14px;cursor:pointer;font-weight:600;margin-top:12px;";
        useBtn.addEventListener("click", async () => {
          useBtn.disabled = true;
          useBtn.textContent = "Confirming...";
          const confirmResp = await fetch("/crop-select", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename, selectedIndex: selectedIdx }),
          });
          const confirmResult = await confirmResp.json();
          if (confirmResult.ok) {
            statusEl.textContent = "Selected shot " + (selectedIdx + 1) + " — saved as " + confirmResult.filename;
            useBtn.textContent = "Done";
          }
        });
        wrap.appendChild(useBtn);
      } else {
        statusEl.textContent = "Done! Saved as " + result.filename;
        statusEl.className = "status done";
        const resultImg = document.createElement("img");
        resultImg.src = "/file/" + encodeURIComponent(result.filename);
        resultImg.style.maxWidth = "100%";
        resultImg.style.marginTop = "16px";
        document.querySelector(".canvas-wrap").appendChild(resultImg);
      }
      submitBtn.textContent = "Complete";
    } else {
      statusEl.textContent = "Error: " + (result.error || "Unknown");
      statusEl.className = "status error";
      submitBtn.disabled = false;
      submitBtn.textContent = "Submit Region";
    }
  } catch (err) {
    statusEl.textContent = "Network error: " + err.message;
    statusEl.className = "status error";
    submitBtn.disabled = false;
    submitBtn.textContent = "Submit Region";
  }
});
</script>
</body></html>`;
}
// --- Histogram matching ---
/**
 * Match the brightness/contrast of a fixed region to the original region.
 * Uses per-channel linear normalization: output = (input - fixedMean) * (origStdev / fixedStdev) + origMean
 * This ensures the composited region blends seamlessly with the surrounding image.
 */
async function matchHistogram(fixedBuf, originalBuf) {
    const [fixedStats, origStats] = await Promise.all([
        sharp(fixedBuf).stats(),
        sharp(originalBuf).stats(),
    ]);
    // Build per-channel linear transform: output = input * a + b
    // where a = origStdev / fixedStdev, b = origMean - fixedMean * a
    const multipliers = [];
    const offsets = [];
    // Process R, G, B channels (skip alpha if present)
    const channels = Math.min(fixedStats.channels.length, origStats.channels.length, 3);
    for (let i = 0; i < channels; i++) {
        const origCh = origStats.channels[i];
        const fixedCh = fixedStats.channels[i];
        // Avoid division by zero — if fixed channel has no variance, just shift the mean
        const a = fixedCh.stdev > 0.001 ? origCh.stdev / fixedCh.stdev : 1;
        const b = origCh.mean - fixedCh.mean * a;
        // Clamp the multiplier to avoid extreme adjustments
        const clampedA = Math.max(0.5, Math.min(2.0, a));
        const clampedB = origCh.mean - fixedCh.mean * clampedA;
        multipliers.push(clampedA);
        offsets.push(clampedB);
    }
    log(`  Histogram match: R(×${multipliers[0]?.toFixed(2)}+${offsets[0]?.toFixed(1)}) G(×${multipliers[1]?.toFixed(2)}+${offsets[1]?.toFixed(1)}) B(×${multipliers[2]?.toFixed(2)}+${offsets[2]?.toFixed(1)})`);
    return sharp(fixedBuf)
        .linear(multipliers, offsets)
        .toBuffer();
}
// --- Image resizing for MCP ---
async function shrinkForMcp(pngBuffer) {
    const origBase64 = pngBuffer.toString("base64");
    if (origBase64.length <= MAX_MCP_BYTES) {
        log(`  MCP size: ${(origBase64.length / 1024).toFixed(0)}KB PNG (no resize needed)`);
        return { base64: origBase64, mime: "image/png" };
    }
    const metadata = await sharp(pngBuffer).metadata();
    const origWidth = metadata.width ?? 1024;
    log(`  Original: ${origWidth}x${metadata.height} PNG, ${(origBase64.length / 1024).toFixed(0)}KB base64`);
    for (const scale of [0.75, 0.5, 0.35, 0.25]) {
        const width = Math.round(origWidth * scale);
        const buf = await sharp(pngBuffer).resize(width).jpeg({ quality: 80 }).toBuffer();
        const b64 = buf.toString("base64");
        if (b64.length <= MAX_MCP_BYTES) {
            log(`  MCP size: ${(b64.length / 1024).toFixed(0)}KB JPEG @ ${Math.round(scale * 100)}% (${width}px wide)`);
            return { base64: b64, mime: "image/jpeg" };
        }
    }
    const buf = await sharp(pngBuffer).resize(256).jpeg({ quality: 60 }).toBuffer();
    const b64 = buf.toString("base64");
    log(`  MCP size: ${(b64.length / 1024).toFixed(0)}KB JPEG @ 256px (last resort)`);
    return { base64: b64, mime: "image/jpeg" };
}
// --- Shared directory helpers ---
async function ensureSaveDir() {
    await mkdir(SAVE_DIR, { recursive: true });
}
/** Save a buffer to the shared dir, return the filename */
async function saveToDisk(buf, label, ext = ".png") {
    await ensureSaveDir();
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${ts}_${label}${ext}`;
    await writeFile(join(SAVE_DIR, filename), buf);
    return filename;
}
/** Load an image from the shared dir by filename, compress for Gemini input */
async function loadForGemini(filename) {
    const filepath = join(SAVE_DIR, filename);
    const buf = await readFile(filepath);
    const metadata = await sharp(buf).metadata();
    const width = metadata.width ?? 1024;
    log(`  Source file: ${filename} (${width}x${metadata.height}, ${(buf.length / 1024).toFixed(0)}KB)`);
    // Compress to max 1024px wide JPEG for fast Gemini upload
    if (width > 1024 || buf.length > 500_000) {
        const resized = await sharp(buf)
            .resize(Math.min(width, 1024))
            .jpeg({ quality: 85 })
            .toBuffer();
        log(`  Compressed for Gemini: ${(resized.length / 1024).toFixed(0)}KB JPEG`);
        return { base64: resized.toString("base64"), mime: "image/jpeg" };
    }
    const ext = extname(filename).toLowerCase();
    const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
    return { base64: buf.toString("base64"), mime };
}
function isPrepayError(msg) {
    const m = msg.toLowerCase();
    return (m.includes("prepay") ||
        m.includes("prepaid") ||
        m.includes("credits are depleted") ||
        m.includes("billing is required") ||
        m.includes("requires billing") ||
        m.includes("enable billing") ||
        m.includes("insufficient credit") ||
        m.includes("billing account"));
}
class GeminiProvider {
    name = "gemini";
    async generate(req) {
        return this.call([{ text: req.prompt }], req.aspectRatio, req.imageSize);
    }
    async edit(req) {
        return this.call([
            { text: req.prompt },
            { inlineData: { mimeType: req.imageMime, data: req.imageBase64 } },
        ], req.aspectRatio, req.imageSize);
    }
    async callOnce(model, inputParts, aspectRatio, imageSize) {
        const t0 = Date.now();
        log(`  Calling Gemini API [${model}] (${imageSize}, ${aspectRatio}, ${inputParts.length} parts)...`);
        let res;
        try {
            res = await fetch(`${geminiEndpoint(model)}?key=${GOOGLE_API_KEY}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{ parts: inputParts }],
                    generationConfig: {
                        responseModalities: ["TEXT", "IMAGE"],
                        imageConfig: { aspectRatio, imageSize },
                    },
                }),
            });
        }
        catch (fetchErr) {
            throw new Error(`Network error calling Gemini API: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
        }
        const elapsed = Date.now() - t0;
        log(`  Gemini [${model}] responded HTTP ${res.status} in ${(elapsed / 1000).toFixed(1)}s`);
        const rawBody = await res.text();
        let data;
        try {
            data = JSON.parse(rawBody);
        }
        catch {
            throw new Error(`Gemini API returned non-JSON (HTTP ${res.status}). Raw body: ${rawBody.slice(0, 2000)}`);
        }
        if (!res.ok || data.error) {
            const safeBody = rawBody.length > 3000 ? rawBody.slice(0, 3000) + "... [truncated]" : rawBody;
            throw new Error(`Gemini API HTTP ${res.status}: ${data.error?.message ?? "unknown error"}. Full response: ${safeBody}`);
        }
        const candidate = data.candidates?.[0];
        if (!candidate?.content?.parts?.length) {
            throw new Error(`Gemini API returned no content parts. Full response: ${JSON.stringify(data, (k, v) => (k === "data" && typeof v === "string" && v.length > 100 ? "[truncated]" : v))}`);
        }
        const responseParts = candidate.content.parts;
        let imageBase64 = "";
        let text = "";
        for (const part of responseParts) {
            if (part.inlineData)
                imageBase64 = part.inlineData.data;
            if (part.text)
                text = part.text;
        }
        if (!imageBase64) {
            const textContent = text ? `Model responded with text: "${text.slice(0, 1000)}"` : "No text content either.";
            throw new Error(`Gemini returned no image. ${textContent} | Parts structure: ${JSON.stringify(responseParts.map((p) => ({ hasText: !!p.text, hasInlineData: !!p.inlineData })))}`);
        }
        log(`  Got image: ${(imageBase64.length / 1024).toFixed(0)}KB base64 from ${model}`);
        return { imageBase64, text };
    }
    async call(inputParts, aspectRatio, imageSize) {
        const defaultKey = getDefaultModelKey();
        const isGeminiDefault = MODELS[defaultKey]?.provider === "gemini";
        if (!isGeminiDefault) {
            const result = await this.callOnce(MODEL_PRIMARY, inputParts, aspectRatio, imageSize);
            return { ...result, modelUsed: MODEL_PRIMARY };
        }
        try {
            const result = await this.callOnce(MODEL_PRIMARY, inputParts, aspectRatio, imageSize);
            return { ...result, modelUsed: MODEL_PRIMARY };
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (isPrepayError(msg)) {
                log(`  Prepay error on ${MODEL_PRIMARY} — falling back to ${MODEL_FALLBACK}. Original: ${msg.slice(0, 300)}`);
                const result = await this.callOnce(MODEL_FALLBACK, inputParts, aspectRatio, imageSize);
                return { ...result, modelUsed: MODEL_FALLBACK };
            }
            throw err;
        }
    }
}
// --- OpenAI provider ---
const OPENAI_V1_SIZE_MAP = {
    "1:1": "1024x1024",
    "16:9": "1536x1024",
    "9:16": "1024x1536",
    "3:4": "1024x1536",
    "4:3": "1536x1024",
    "2:3": "1024x1536",
    "3:2": "1536x1024",
    "4:5": "1024x1536",
    "5:4": "1536x1024",
};
const OPENAI_V2_SIZE_MAP = {
    "512": {
        "1:1": "512x512", "16:9": "912x512", "9:16": "512x912",
        "3:4": "512x680", "4:3": "680x512", "2:3": "512x768",
        "3:2": "768x512", "4:5": "512x640", "5:4": "640x512",
    },
    "1K": {
        "1:1": "1024x1024", "16:9": "1536x1024", "9:16": "1024x1536",
        "3:4": "1024x1360", "4:3": "1360x1024", "2:3": "1024x1536",
        "3:2": "1536x1024", "4:5": "1024x1280", "5:4": "1280x1024",
    },
    "2K": {
        "1:1": "2048x2048", "16:9": "2560x1440", "9:16": "1440x2560",
        "3:4": "1536x2048", "4:3": "2048x1536", "2:3": "1440x2160",
        "3:2": "2160x1440", "4:5": "1536x1920", "5:4": "1920x1536",
    },
    "4K": {
        "1:1": "4096x4096", "16:9": "4096x2304", "9:16": "2304x4096",
        "3:4": "3072x4096", "4:3": "4096x3072", "2:3": "2736x4096",
        "3:2": "4096x2736", "4:5": "3072x3840", "5:4": "3840x3072",
    },
};
function openaiSize(modelId, aspectRatio, imageSize) {
    if (modelId === "gpt-image-2") {
        return OPENAI_V2_SIZE_MAP[imageSize]?.[aspectRatio] ?? OPENAI_V2_SIZE_MAP["1K"][aspectRatio] ?? "1024x1024";
    }
    return OPENAI_V1_SIZE_MAP[aspectRatio] ?? "1024x1024";
}
function openaiQuality(imageSize) {
    if (imageSize === "2K" || imageSize === "4K")
        return "high";
    return "medium";
}
class OpenAIProvider {
    name = "openai";
    async generate(req) {
        const size = openaiSize(req.modelId, req.aspectRatio, req.imageSize);
        const quality = openaiQuality(req.imageSize);
        const t0 = Date.now();
        log(`  Calling OpenAI ${req.modelId} generate (${size}, quality=${quality})...`);
        let res;
        try {
            res = await fetch("https://api.openai.com/v1/images/generations", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${OPENAI_API_KEY}`,
                },
                body: JSON.stringify({
                    model: req.modelId,
                    prompt: req.prompt,
                    n: 1,
                    size,
                    quality,
                }),
            });
        }
        catch (fetchErr) {
            throw new Error(`Network error calling OpenAI API: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
        }
        const elapsed = Date.now() - t0;
        log(`  OpenAI responded HTTP ${res.status} in ${(elapsed / 1000).toFixed(1)}s`);
        const rawBody = await res.text();
        let data;
        try {
            data = JSON.parse(rawBody);
        }
        catch {
            throw new Error(`OpenAI API returned non-JSON (HTTP ${res.status}). Raw body: ${rawBody.slice(0, 2000)}`);
        }
        if (!res.ok || data.error) {
            throw new Error(`OpenAI API HTTP ${res.status}: ${data.error?.message ?? rawBody.slice(0, 2000)}`);
        }
        const imageBase64 = data.data?.[0]?.b64_json;
        if (!imageBase64) {
            throw new Error(`OpenAI returned no image data. Response: ${rawBody.slice(0, 2000)}`);
        }
        log(`  Got image: ${(imageBase64.length / 1024).toFixed(0)}KB base64 from ${req.modelId}`);
        return { imageBase64, text: "", modelUsed: req.modelId };
    }
    async edit(req) {
        const size = openaiSize(req.modelId, req.aspectRatio, req.imageSize);
        const quality = openaiQuality(req.imageSize);
        const t0 = Date.now();
        log(`  Calling OpenAI ${req.modelId} edit (${size}, quality=${quality})...`);
        const imageBuffer = Buffer.from(req.imageBase64, "base64");
        const imageBlob = new Blob([imageBuffer], { type: req.imageMime });
        const form = new FormData();
        form.append("model", req.modelId);
        form.append("prompt", req.prompt);
        form.append("image", imageBlob, "image.png");
        form.append("size", size);
        form.append("quality", quality);
        let res;
        try {
            res = await fetch("https://api.openai.com/v1/images/edits", {
                method: "POST",
                headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` },
                body: form,
            });
        }
        catch (fetchErr) {
            throw new Error(`Network error calling OpenAI edit API: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
        }
        const elapsed = Date.now() - t0;
        log(`  OpenAI edit responded HTTP ${res.status} in ${(elapsed / 1000).toFixed(1)}s`);
        const rawBody = await res.text();
        let data;
        try {
            data = JSON.parse(rawBody);
        }
        catch {
            throw new Error(`OpenAI edit API returned non-JSON (HTTP ${res.status}). Raw body: ${rawBody.slice(0, 2000)}`);
        }
        if (!res.ok || data.error) {
            throw new Error(`OpenAI edit API HTTP ${res.status}: ${data.error?.message ?? rawBody.slice(0, 2000)}`);
        }
        const imageBase64 = data.data?.[0]?.b64_json;
        if (!imageBase64) {
            throw new Error(`OpenAI edit returned no image data. Response: ${rawBody.slice(0, 2000)}`);
        }
        log(`  Got image: ${(imageBase64.length / 1024).toFixed(0)}KB base64 from ${req.modelId} edit`);
        return { imageBase64, text: "", modelUsed: req.modelId };
    }
}
// --- Veo API ---
async function callVeo(prompt, aspectRatio, durationSeconds) {
    const t0 = Date.now();
    log(`  Calling Veo API (${VEO_MODEL}, ${aspectRatio}, ${durationSeconds}s)...`);
    let res;
    try {
        res = await fetch(`${VEO_ENDPOINT}?key=${GOOGLE_API_KEY}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                instances: [{ prompt }],
                parameters: {
                    aspectRatio,
                    durationSeconds,
                    personGeneration: "allow_all",
                    sampleCount: 1,
                    resolution: "720p",
                },
            }),
        });
    }
    catch (fetchErr) {
        throw new Error(`Network error calling Veo API: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
    }
    const rawBody = await res.text();
    let operation;
    try {
        operation = JSON.parse(rawBody);
    }
    catch {
        throw new Error(`Veo API returned non-JSON (HTTP ${res.status}). Raw body: ${rawBody.slice(0, 2000)}`);
    }
    if (!res.ok || operation.error) {
        throw new Error(`Veo API HTTP ${res.status}: ${operation.error?.message ?? rawBody.slice(0, 2000)}`);
    }
    if (!operation.name) {
        throw new Error(`Veo API returned no operation name. Response: ${rawBody.slice(0, 2000)}`);
    }
    log(`  Veo operation started: ${operation.name}`);
    // Poll for completion
    const pollUrl = `${VEO_BASE}/${operation.name}?key=${GOOGLE_API_KEY}`;
    for (let i = 0; i < VEO_MAX_POLLS; i++) {
        await new Promise((r) => setTimeout(r, VEO_POLL_INTERVAL));
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        log(`  Polling Veo (${elapsed}s elapsed, attempt ${i + 1}/${VEO_MAX_POLLS})...`);
        const pollRes = await fetch(pollUrl);
        const pollBody = await pollRes.text();
        let pollData;
        try {
            pollData = JSON.parse(pollBody);
        }
        catch {
            log(`  Poll returned non-JSON, retrying...`);
            continue;
        }
        if (pollData.error) {
            throw new Error(`Veo generation failed: ${pollData.error.message}`);
        }
        if (pollData.done) {
            const videoUri = pollData.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
            if (!videoUri) {
                throw new Error(`Veo completed but no video URI found. Response: ${pollBody.slice(0, 2000)}`);
            }
            log(`  Veo complete in ${((Date.now() - t0) / 1000).toFixed(1)}s, downloading video...`);
            // Download the video — append API key
            const downloadRes = await fetch(`${videoUri}&key=${GOOGLE_API_KEY}`, { redirect: "follow" });
            if (!downloadRes.ok) {
                throw new Error(`Failed to download video (HTTP ${downloadRes.status})`);
            }
            const videoBuffer = Buffer.from(await downloadRes.arrayBuffer());
            log(`  Downloaded video: ${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB`);
            return videoBuffer;
        }
    }
    throw new Error(`Veo generation timed out after ${VEO_MAX_POLLS * VEO_POLL_INTERVAL / 1000}s`);
}
/** Generate, store, return shrunk for MCP */
async function generateAndStore(prompt, aspectRatio, imageSize, modelKey) {
    const { provider, modelId } = getProvider(modelKey);
    const { imageBase64, text, modelUsed } = await provider.generate({ prompt, aspectRatio, imageSize, modelId });
    const fullPng = Buffer.from(imageBase64, "base64");
    const id = randomUUID();
    const filename = await saveToDisk(fullPng, id.slice(0, 8));
    log(`  Saved ${filename}`);
    const img = { id, prompt, fullPng, timestamp: Date.now(), filename, aspectRatio, imageSize, modelUsed };
    imageStore.push(img);
    notifyViewerClients(img);
    const { base64: mcpBase64, mime: mcpMimeType } = await shrinkForMcp(fullPng);
    return { mcpBase64, mcpMimeType, text, filename, modelUsed };
}
/** Edit, store, return shrunk for MCP */
async function editAndStore(prompt, sourceBase64, sourceMime, aspectRatio, imageSize, modelKey) {
    const { provider, modelId } = getProvider(modelKey);
    const { imageBase64, text, modelUsed } = await provider.edit({
        prompt,
        imageBase64: sourceBase64,
        imageMime: sourceMime,
        aspectRatio,
        imageSize,
        modelId,
    });
    const fullPng = Buffer.from(imageBase64, "base64");
    const id = randomUUID();
    const filename = await saveToDisk(fullPng, id.slice(0, 8));
    log(`  Saved ${filename}`);
    const img = { id, prompt: `[edit] ${prompt}`, fullPng, timestamp: Date.now(), filename, modelUsed };
    imageStore.push(img);
    notifyViewerClients(img);
    const { base64: mcpBase64, mime: mcpMimeType } = await shrinkForMcp(fullPng);
    return { mcpBase64, mcpMimeType, text, filename, modelUsed };
}
/** Notice text to append to MCP responses when the auto-fallback model was used. */
const AUTO_FALLBACK_NOTICE = `\u26A0\uFE0F Generated with ${MODEL_FALLBACK} (Gemini 2.5 Flash Image) — the free-tier-eligible fallback. ` +
    `The primary ${MODEL_PRIMARY} (Gemini 3.1 Flash Image) requires a billed/prepaid Google AI account, ` +
    `and your prepayment credits appear to be depleted. For higher-quality image generation, ` +
    `top up credits at https://aistudio.google.com/ and re-run.`;
/** Notice text when the user explicitly chose the free model. */
const EXPLICIT_FREE_NOTICE = `\u2139\uFE0F Generated with ${MODEL_FALLBACK} (Gemini 2.5 Flash Image, free tier, as requested). ` +
    `For higher-quality image generation, pass model='${GEMINI_DEFAULT}' — this requires prepaid credits on your Google AI account.`;
const MODEL_PARAM_DESCRIPTION = `Model to use. Available: ${MODEL_KEYS.map(k => `'${k}' (${MODELS[k].label})`).join(", ")}. ` +
    `Default: '${getDefaultModelKey()}'. Set DEFAULT_IMAGE_MODEL env var to change the default. ` +
    `Gemini models fall back to free tier on billing errors. OpenAI requires OPENAI_API_KEY.`;
function noticeFor(modelUsed, explicitModelKey) {
    if (explicitModelKey && MODELS[explicitModelKey]?.provider !== "gemini")
        return "";
    if (modelUsed === MODEL_PRIMARY)
        return "";
    const notice = explicitModelKey ? EXPLICIT_FREE_NOTICE : AUTO_FALLBACK_NOTICE;
    return `\n\n${notice}`;
}
function resolveImageSize(imageSize, modelKey) {
    if (!modelKey)
        return imageSize;
    const entry = MODELS[modelKey];
    if (entry?.provider !== "gemini")
        return imageSize;
    if (modelKey === "gemini-2.5-flash-image" && imageSize === "512") {
        log(`  Note: gemini-2.5-flash-image doesn't support image_size=512, using 1K instead`);
        return "1K";
    }
    return imageSize;
}
// --- Style presets ---
const STYLE_PRESETS = {
    "neo-brutalist": {
        description: "Neo-brutalist minimalist magazine editorial. Bold oversized typography, cream/black/terracotta palette, halftone textures, visible grid lines, asymmetric layout. Think Emigre meets Swiss brutalism.",
        promptPrefix: "Neo-brutalist minimalist design. Magazine editorial style layout. Off-white / cream background with bold black typography in a heavy-weight grotesque sans-serif font, slightly overlapping and breaking the grid. Accent color: muted burnt orange or terracotta used sparingly as stripe or block elements. Raw, unpolished aesthetic — visible grid lines, asymmetric layout, oversized type that bleeds off edges. Subtle halftone texture overlay. Monospaced subtext in lowercase. No gradients, no glossy effects, no heavy saturation. Clean but edgy, restrained but bold.",
        defaultAspectRatio: "4:5",
    },
    "neo-retro-futurism": {
        description: "Neo-retro-futurism blending 1960s Space Age optimism with 1980s video game aesthetics. Cathode blue, warm amber, salmon red, warm green palette. Scanlines, pixel hints, and atomic-age geometry.",
        promptPrefix: "Neo-retro-futurism style. Blend of 1960s Space Age futurism and 1980s video game aesthetics with a modern neo-retro sensibility. Color palette: deep cathode-ray blue (#1a3a5c to #4a9eff glowing CRT blue), warm amber (#d4a017 to #ffcc44), salmon red (#e8735a to #ff6b6b), and warm muted greens (#5a8a5c to #8bbd7b). Dark background evoking a CRT monitor with subtle scanline texture and faint phosphor glow. Typography: mix of retrofuturist geometric sans-serif (like Eurostile, Microgramma, or Bank Gothic) with pixel-grid or bitmap-style secondary text. Design elements: atomic-age starbursts, orbital ellipses, rounded-rectangle pods, jet-age swooshes, and subtle 8-bit pixel patterns along borders or dividers. Faint CRT curvature vignette at edges. Thin vector grid lines receding to a vanishing point. Icons and illustrations should feel like arcade cabinet art meets Googie architecture meets NASA mission patches. Warm analog glow on all light sources — no harsh pure whites, everything filtered through amber or blue phosphor. The overall mood is optimistic, adventurous, and slightly nostalgic — a future that never was, rendered through a cathode ray tube.",
        defaultAspectRatio: "4:5",
    },
    "fractal-arcade": {
        description: "Geometric dithered fractal style. All shading via dithering patterns and geometric cross-hatch grids — no smooth gradients. Fractal backgrounds (Sierpinski, hexagonal tessellations, recursive diamonds), low-poly faceted subjects, retro CRT palette.",
        promptPrefix: "Geometric dithered illustration style. All shading done through dithering patterns, halftone dots, and geometric cross-hatch grids — NO smooth gradients anywhere. Every surface rendered with visible pixel-level dithering like a 16-color EGA/VGA palette pushed through ordered Bayer matrix dithering. Fractal geometric patterns in the background — Sierpinski triangles, hexagonal tessellations, recursive diamond grids. Color palette: deep cathode-ray blue (#1a3a5c to #4a9eff), warm amber (#d4a017 to #ffcc44), salmon red (#e8735a), warm muted greens (#5a8a5c). Subjects built from clean geometric shapes — triangular facets, polygonal planes, like a low-poly render but flat and 2D with dithered color fills instead of smooth shading. Think: Saul Bass designed a character select screen for an Amiga game. Geometric line-art icons. Chunky retrofuturist typeface for headers, smaller geometric caps for subtitles. Horizontal scanline overlay. No photorealism, no soft shadows, no AI-gradient smoothness. Every color transition is a hard dither pattern. Clean, precise, geometric, but retro-cool.",
        defaultAspectRatio: "4:5",
    },
    "clean-tech-infographic": {
        description: "Clean technical infographic for architecture diagrams, system flows, and data pipelines. Dark navy background, cyan/electric blue glowing connection lines, geometric nodes, professional and precise.",
        promptPrefix: "Clean, professional technical infographic on a dark navy (#0a1628) background with subtle grid lines. Use cyan (#00d4ff) and electric blue (#4a9eff) glowing connection lines between components. White and light gray text only — no bright colors for text. Components rendered as clean geometric shapes: rounded rectangles, hexagons, circles with thin borders and subtle inner glow. Icons are minimal line-art style (server racks, phones, browsers, databases, cloud services). Typography: modern sans-serif (like Inter or SF Pro) — bold for titles, regular weight for labels, monospace for technical details (ports, protocols, versions). Layout follows clear left-to-right or top-to-bottom data flow with labeled arrows showing protocols and data formats. No decorative illustrations, no clip art, no logos, no random embellishments. Include a thin tech stack bar at the bottom. The overall feel is a polished engineering diagram you'd present to a CTO — precise, minimal, and authoritative.",
        defaultAspectRatio: "16:9",
    },
};
const STYLE_KEYS = Object.keys(STYLE_PRESETS);
const STYLE_DESCRIPTION = "Optional style preset to apply. When set, the style's prompt prefix is prepended and its default aspect ratio is used (unless you explicitly set one).\n\nAvailable styles:\n" +
    Object.entries(STYLE_PRESETS).map(([key, val]) => `• ${key} — ${val.description}`).join("\n");
function applyStyle(prompt, style) {
    if (!style || !STYLE_PRESETS[style])
        return prompt;
    return `${STYLE_PRESETS[style].promptPrefix}\n\nSubject/content: ${prompt}`;
}
function resolveAspectRatio(explicit, style) {
    if (explicit !== "1:1")
        return explicit; // user explicitly chose something
    if (style && STYLE_PRESETS[style]?.defaultAspectRatio)
        return STYLE_PRESETS[style].defaultAspectRatio;
    return explicit;
}
// --- MCP server ---
const server = new McpServer({ name: "pixel-surgeon", version: "1.0.0" }, { capabilities: { tools: {} } });
server.tool("list_images", `List image and video files in the shared pixel-surgeon directory (${SAVE_DIR}). Use this to find images available for editing.`, {}, async () => {
    try {
        await ensureSaveDir();
        const files = await readdir(SAVE_DIR);
        const mediaFiles = files.filter((f) => /\.(png|jpg|jpeg|webp|mp4)$/i.test(f));
        mediaFiles.sort().reverse(); // newest first
        const entries = [];
        for (const f of mediaFiles.slice(0, 50)) {
            const s = await stat(join(SAVE_DIR, f));
            const isVideo = /\.mp4$/i.test(f);
            const sizeStr = isVideo
                ? `${(s.size / 1024 / 1024).toFixed(1)}MB`
                : `${(s.size / 1024).toFixed(0)}KB`;
            entries.push(`${isVideo ? "[VIDEO] " : ""}${f} (${sizeStr})`);
        }
        return {
            content: [{
                    type: "text",
                    text: entries.length > 0
                        ? `Files in ${SAVE_DIR}:\n${entries.join("\n")}`
                        : `No files in ${SAVE_DIR}`,
                }],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            content: [{ type: "text", text: `list_images failed: ${msg}` }],
            isError: true,
        };
    }
});
server.tool("save_image", `Copy an image file into the shared pixel-surgeon directory (${SAVE_DIR}) so it can be used with edit_image. Use this when the user wants to edit an image that exists elsewhere on their filesystem.`, {
    source_path: z.string().describe("Absolute path to the image file to import"),
}, async ({ source_path }) => {
    try {
        await ensureSaveDir();
        const ext = extname(source_path).toLowerCase() || ".png";
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const destFilename = `${ts}_imported${ext}`;
        const destPath = join(SAVE_DIR, destFilename);
        await copyFile(source_path, destPath);
        const s = await stat(destPath);
        log(`save_image: copied ${source_path} -> ${destFilename} (${(s.size / 1024).toFixed(0)}KB)`);
        return {
            content: [{
                    type: "text",
                    text: `Saved as ${destFilename} in ${SAVE_DIR} (${(s.size / 1024).toFixed(0)}KB). You can now use this filename with edit_image.`,
                }],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`save_image error: ${msg}`);
        return {
            content: [{ type: "text", text: `save_image failed: ${msg}` }],
            isError: true,
        };
    }
});
server.tool("generate_images", "Generate multiple images in parallel. Supports Gemini and OpenAI models — pass the model param to choose. Returns the generated images and any accompanying text. Full-resolution images are viewable in the browser viewer.", {
    prompts: z
        .array(z.string())
        .min(1)
        .max(8)
        .describe("Array of text prompts, one per image to generate (1-8 images)"),
    aspect_ratio: z
        .enum(["1:1", "16:9", "9:16", "3:4", "4:3", "2:3", "3:2", "4:5", "5:4"])
        .default("1:1")
        .describe("Aspect ratio for all generated images"),
    image_size: z
        .enum(["512", "1K", "2K", "4K"])
        .default("1K")
        .describe("Image resolution"),
    style: z
        .enum(STYLE_KEYS)
        .optional()
        .describe(STYLE_DESCRIPTION),
    model: z.enum(MODEL_KEYS).optional().describe(MODEL_PARAM_DESCRIPTION),
}, async ({ prompts, aspect_ratio, image_size, style, model }) => {
    try {
        await ensureViewer();
        const resolvedAR = resolveAspectRatio(aspect_ratio, style);
        log(`generate_images: ${prompts.length} prompts, ${image_size}, ${resolvedAR}${style ? ` [style: ${style}]` : ""}${model ? ` [model: ${model}]` : ""}`);
        const t0 = Date.now();
        const resolvedSize = resolveImageSize(image_size, model);
        const results = await Promise.allSettled(prompts.map((prompt, i) => {
            const styledPrompt = applyStyle(prompt, style);
            log(`  [${i + 1}/${prompts.length}] "${styledPrompt.slice(0, 80)}${styledPrompt.length > 80 ? "..." : ""}"`);
            return generateAndStore(styledPrompt, resolvedAR, resolvedSize, model);
        }));
        const content = [];
        let anySucceeded = false;
        let anyFallback = false;
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === "fulfilled") {
                anySucceeded = true;
                if (result.value.modelUsed !== MODEL_PRIMARY && isGeminiModel(result.value.modelUsed))
                    anyFallback = true;
                content.push({
                    type: "text",
                    text: `Image ${i + 1}: ${result.value.filename}${result.value.text ? ` — ${result.value.text}` : ""}`,
                });
                content.push({
                    type: "image",
                    data: result.value.mcpBase64,
                    mimeType: result.value.mcpMimeType,
                });
            }
            else {
                content.push({
                    type: "text",
                    text: `Image ${i + 1} failed (prompt: "${prompts[i]}"): ${result.reason?.message ?? "Unknown error"}`,
                });
            }
        }
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        log(`generate_images complete: ${results.filter((r) => r.status === "fulfilled").length}/${prompts.length} succeeded in ${elapsed}s`);
        content.push({
            type: "text",
            text: `Full-res images in ${SAVE_DIR} — viewable at http://localhost:${viewerPort}${anyFallback ? `\n\n${model ? EXPLICIT_FREE_NOTICE : AUTO_FALLBACK_NOTICE}` : ""}`,
        });
        if (!anySucceeded)
            return { content, isError: true };
        return { content };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`generate_images error: ${msg}`);
        return {
            content: [{ type: "text", text: `generate_images failed: ${msg}` }],
            isError: true,
        };
    }
});
server.tool("generate_image", "Generate a single image. Supports Gemini and OpenAI models — pass the model param to choose. Full-resolution image is viewable in the browser viewer.", {
    prompt: z.string().describe("Text prompt describing the image to generate"),
    aspect_ratio: z
        .enum(["1:1", "16:9", "9:16", "3:4", "4:3", "2:3", "3:2", "4:5", "5:4"])
        .default("1:1")
        .describe("Aspect ratio for the image"),
    image_size: z
        .enum(["512", "1K", "2K", "4K"])
        .default("1K")
        .describe("Image resolution"),
    style: z
        .enum(STYLE_KEYS)
        .optional()
        .describe(STYLE_DESCRIPTION),
    model: z.enum(MODEL_KEYS).optional().describe(MODEL_PARAM_DESCRIPTION),
}, async ({ prompt, aspect_ratio, image_size, style, model }) => {
    try {
        await ensureViewer();
        const styledPrompt = applyStyle(prompt, style);
        const resolvedAR = resolveAspectRatio(aspect_ratio, style);
        log(`generate_image: "${styledPrompt.slice(0, 80)}${styledPrompt.length > 80 ? "..." : ""}" (${image_size}, ${resolvedAR})${style ? ` [style: ${style}]` : ""}${model ? ` [model: ${model}]` : ""}`);
        const t0 = Date.now();
        const resolvedSize = resolveImageSize(image_size, model);
        const { mcpBase64, mcpMimeType, text, filename, modelUsed } = await generateAndStore(styledPrompt, resolvedAR, resolvedSize, model);
        log(`generate_image complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return {
            content: [
                ...(text ? [{ type: "text", text }] : []),
                { type: "image", data: mcpBase64, mimeType: mcpMimeType },
                { type: "text", text: `Saved as ${filename} — full-res at http://localhost:${viewerPort}${noticeFor(modelUsed, model)}` },
            ],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`generate_image error: ${msg}`);
        return {
            content: [{ type: "text", text: `generate_image failed: ${msg}` }],
            isError: true,
        };
    }
});
server.tool("generate_video", "Generate a video using Google's Veo 3. Returns an MP4 video file. Video generation takes 1-3 minutes — the tool will poll until complete. Veo 3 generates both video and ambient audio. Videos are saved to the shared directory and viewable in the browser viewer.", {
    prompt: z.string().describe("Text prompt describing the video to generate. Be descriptive about motion, camera angles, lighting, and scene details for best results."),
    aspect_ratio: z
        .enum(["16:9", "9:16"])
        .default("16:9")
        .describe("Aspect ratio — 16:9 for landscape, 9:16 for portrait/vertical"),
    duration: z
        .enum(["5", "8"])
        .default("8")
        .describe("Video duration in seconds"),
}, async ({ prompt, aspect_ratio, duration }) => {
    try {
        await ensureViewer();
        const durationSeconds = parseInt(duration, 10);
        log(`generate_video: "${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}" (${aspect_ratio}, ${durationSeconds}s)`);
        const t0 = Date.now();
        const videoBuffer = await callVeo(prompt, aspect_ratio, durationSeconds);
        const id = randomUUID();
        const filename = await saveToDisk(videoBuffer, id.slice(0, 8), ".mp4");
        log(`  Saved video ${filename} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)`);
        const vid = { id, prompt, filename, timestamp: Date.now(), aspectRatio: aspect_ratio, durationSeconds };
        videoStore.push(vid);
        notifyViewerClientsVideo(vid);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        log(`generate_video complete in ${elapsed}s`);
        return {
            content: [
                { type: "text", text: `Video generated successfully in ${elapsed}s` },
                { type: "text", text: `Saved as ${filename} in ${SAVE_DIR} (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB)` },
                { type: "text", text: `Viewable at http://localhost:${viewerPort}` },
            ],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`generate_video error: ${msg}`);
        return {
            content: [{ type: "text", text: `generate_video failed: ${msg}` }],
            isError: true,
        };
    }
});
server.tool("edit_image", `Edit an existing image. Supports Gemini and OpenAI models — pass the model param to choose. Provide the filename of an image in ${SAVE_DIR} (use list_images to see available files, or save_image to import one first). The MCP reads the file directly — do NOT pass base64 image data.`, {
    prompt: z.string().describe("Text prompt describing the edits to make to the image"),
    filename: z.string().describe(`Filename of the source image in ${SAVE_DIR} (e.g. "2026-03-17T17-47-31-152Z_59f735df.png")`),
    aspect_ratio: z
        .enum(["1:1", "16:9", "9:16", "3:4", "4:3", "2:3", "3:2", "4:5", "5:4"])
        .default("1:1")
        .describe("Aspect ratio for the output image"),
    image_size: z
        .enum(["512", "1K", "2K", "4K"])
        .default("1K")
        .describe("Output image resolution"),
    style: z
        .enum(STYLE_KEYS)
        .optional()
        .describe(STYLE_DESCRIPTION),
    model: z.enum(MODEL_KEYS).optional().describe(MODEL_PARAM_DESCRIPTION),
}, async ({ prompt, filename, aspect_ratio, image_size, style, model }) => {
    try {
        await ensureViewer();
        const styledPrompt = applyStyle(prompt, style);
        const resolvedAR = resolveAspectRatio(aspect_ratio, style);
        log(`edit_image: "${styledPrompt.slice(0, 80)}${styledPrompt.length > 80 ? "..." : ""}" source=${filename} (${image_size}, ${resolvedAR})${style ? ` [style: ${style}]` : ""}${model ? ` [model: ${model}]` : ""}`);
        const t0 = Date.now();
        const { base64: srcBase64, mime: srcMime } = await loadForGemini(filename);
        const resolvedSize = resolveImageSize(image_size, model);
        const { mcpBase64, mcpMimeType, text, filename: outFilename, modelUsed } = await editAndStore(styledPrompt, srcBase64, srcMime, resolvedAR, resolvedSize, model);
        log(`edit_image complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return {
            content: [
                ...(text ? [{ type: "text", text }] : []),
                { type: "image", data: mcpBase64, mimeType: mcpMimeType },
                { type: "text", text: `Saved as ${outFilename} — full-res at http://localhost:${viewerPort}${noticeFor(modelUsed, model)}` },
            ],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`edit_image error: ${msg}`);
        return {
            content: [{ type: "text", text: `edit_image failed: ${msg}` }],
            isError: true,
        };
    }
});
server.tool("fix_image", `Fix an image that has glitched or garbled text by splitting it into tiles, re-rendering each tile, and stitching them back together. This works because smaller sections have less text for the model to handle at once. Use this when a generated image has text artifacts or overloaded text regions.`, {
    filename: z.string().describe(`Filename of the source image in ${SAVE_DIR}`),
    prompt: z
        .string()
        .default("Clean up and fix any garbled, glitched, or distorted text in this image tile. Preserve the style, colors, and layout exactly but make all text crisp and legible.")
        .describe("Instructions for fixing each tile"),
    grid: z
        .enum(["2x2", "3x3", "2x1", "1x2", "3x1", "1x3"])
        .default("2x2")
        .describe("How to split the image: cols x rows"),
    image_size: z
        .enum(["512", "1K", "2K", "4K"])
        .default("1K")
        .describe("Resolution for each tile"),
    model: z.enum(MODEL_KEYS).optional().describe(MODEL_PARAM_DESCRIPTION),
}, async ({ filename, prompt, grid, image_size, model }) => {
    try {
        await ensureViewer();
        log(`fix_image: source=${filename} grid=${grid}`);
        const t0 = Date.now();
        // Parse grid
        const [colStr, rowStr] = grid.split("x");
        const cols = parseInt(colStr, 10);
        const rows = parseInt(rowStr, 10);
        // Load source image
        const filepath = join(SAVE_DIR, filename);
        const srcBuf = await readFile(filepath);
        const metadata = await sharp(srcBuf).metadata();
        const imgWidth = metadata.width;
        const imgHeight = metadata.height;
        log(`  Source: ${imgWidth}x${imgHeight}`);
        const tileW = Math.floor(imgWidth / cols);
        const tileH = Math.floor(imgHeight / rows);
        // Extract tiles
        const tiles = [];
        for (let row = 0; row < rows; row++) {
            for (let col = 0; col < cols; col++) {
                const left = col * tileW;
                const top = row * tileH;
                // Last tile in each direction extends to the edge
                const width = col === cols - 1 ? imgWidth - left : tileW;
                const height = row === rows - 1 ? imgHeight - top : tileH;
                const buf = await sharp(srcBuf)
                    .extract({ left, top, width, height })
                    .png()
                    .toBuffer();
                tiles.push({ col, row, buffer: buf });
            }
        }
        log(`  Extracted ${tiles.length} tiles (${tileW}x${tileH} each)`);
        // Compute aspect ratio closest to tile dimensions for Gemini
        const tileAspect = tileW / tileH;
        const bestAspect = ASPECT_RATIOS.reduce((best, opt) => Math.abs(Math.log(opt.ratio / tileAspect)) < Math.abs(Math.log(best.ratio / tileAspect)) ? opt : best);
        log(`  Tile aspect ~${tileAspect.toFixed(2)}, using ${bestAspect.label}`);
        // Send each tile to the provider in parallel
        const { provider: tileProvider, modelId: tileModelId } = getProvider(model);
        const fixResults = await Promise.allSettled(tiles.map(async (tile, i) => {
            log(`  [tile ${i + 1}/${tiles.length}] sending to ${tileProvider.name}...`);
            const tileSharp = sharp(tile.buffer);
            const tileMeta = await tileSharp.metadata();
            let sendBuf;
            let sendMime;
            if ((tileMeta.width ?? 0) > 1024 || tile.buffer.length > 500_000) {
                sendBuf = await sharp(tile.buffer).resize(Math.min(tileMeta.width ?? 1024, 1024)).jpeg({ quality: 85 }).toBuffer();
                sendMime = "image/jpeg";
            }
            else {
                sendBuf = tile.buffer;
                sendMime = "image/png";
            }
            const { imageBase64, modelUsed } = await tileProvider.edit({
                prompt,
                imageBase64: sendBuf.toString("base64"),
                imageMime: sendMime,
                aspectRatio: bestAspect.label,
                imageSize: image_size,
                modelId: tileModelId,
            });
            return { col: tile.col, row: tile.row, buffer: Buffer.from(imageBase64, "base64"), modelUsed };
        }));
        // Check for failures
        const failed = fixResults.filter((r) => r.status === "rejected");
        if (failed.length === fixResults.length) {
            throw new Error(`All ${fixResults.length} tiles failed. First error: ${failed[0].reason?.message}`);
        }
        if (failed.length > 0) {
            log(`  WARNING: ${failed.length}/${fixResults.length} tiles failed, using originals for those`);
        }
        // Build fixed tile map, falling back to original tile on failure
        const fixedTiles = fixResults.map((result, i) => {
            if (result.status === "fulfilled") {
                return result.value;
            }
            log(`  Tile ${i + 1} failed, using original: ${result.reason?.message}`);
            return tiles[i];
        });
        // Resize each fixed tile back to exact tile dimensions and composite
        const compositeInputs = [];
        for (const tile of fixedTiles) {
            const left = tile.col * tileW;
            const top = tile.row * tileH;
            const width = tile.col === cols - 1 ? imgWidth - left : tileW;
            const height = tile.row === rows - 1 ? imgHeight - top : tileH;
            const resized = await sharp(tile.buffer)
                .resize(width, height, { fit: "fill" })
                .png()
                .toBuffer();
            compositeInputs.push({ input: resized, left, top });
        }
        const finalBuf = await sharp({
            create: { width: imgWidth, height: imgHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 1 } },
        })
            .composite(compositeInputs)
            .png()
            .toBuffer();
        // Save result
        const id = randomUUID();
        const outFilename = await saveToDisk(finalBuf, `fix_${id.slice(0, 8)}`);
        log(`  Stitched ${fixedTiles.length} tiles -> ${outFilename}`);
        const tileModels = [];
        for (const r of fixResults) {
            if (r.status === "fulfilled") {
                const m = r.value.modelUsed;
                if (m)
                    tileModels.push(m);
            }
        }
        const imageModelUsed = tileModels.find((m) => m !== MODEL_PRIMARY) ?? MODEL_PRIMARY;
        const img = {
            id,
            prompt: `[fix ${grid}] ${prompt.slice(0, 60)}`,
            fullPng: finalBuf,
            timestamp: Date.now(),
            filename: outFilename,
            modelUsed: imageModelUsed,
        };
        imageStore.push(img);
        notifyViewerClients(img);
        const { base64: mcpBase64, mime: mcpMimeType } = await shrinkForMcp(finalBuf);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        const successCount = fixResults.filter((r) => r.status === "fulfilled").length;
        log(`fix_image complete in ${elapsed}s (${successCount}/${fixResults.length} tiles succeeded)`);
        return {
            content: [
                { type: "image", data: mcpBase64, mimeType: mcpMimeType },
                {
                    type: "text",
                    text: `Fixed ${successCount}/${tiles.length} tiles (${grid} grid). Saved as ${outFilename} — full-res at http://localhost:${viewerPort}${noticeFor(imageModelUsed)}`,
                },
            ],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`fix_image error: ${msg}`);
        return {
            content: [{ type: "text", text: `fix_image failed: ${msg}` }],
            isError: true,
        };
    }
});
// --- Aspect ratio snapping helper ---
const ASPECT_RATIOS = [
    { label: "1:1", ratio: 1 },
    { label: "16:9", ratio: 16 / 9 },
    { label: "9:16", ratio: 9 / 16 },
    { label: "3:4", ratio: 3 / 4 },
    { label: "4:3", ratio: 4 / 3 },
    { label: "2:3", ratio: 2 / 3 },
    { label: "3:2", ratio: 3 / 2 },
    { label: "4:5", ratio: 4 / 5 },
    { label: "5:4", ratio: 5 / 4 },
];
/**
 * Given a crop region, snap it to the nearest Gemini aspect ratio.
 * Adjusts width/height to match the ratio while keeping the center point,
 * clamped to image bounds.
 */
function snapToAspectRatio(x, y, w, h, imgWidth, imgHeight) {
    const cropRatio = w / h;
    const best = ASPECT_RATIOS.reduce((a, b) => Math.abs(Math.log(a.ratio / cropRatio)) <= Math.abs(Math.log(b.ratio / cropRatio)) ? a : b);
    // Adjust dimensions to match the snapped ratio, keeping area roughly the same
    const centerX = x + w / 2;
    const centerY = y + h / 2;
    let newW, newH;
    if (best.ratio > cropRatio) {
        // Need wider — expand width, keep height
        newH = h;
        newW = Math.round(h * best.ratio);
    }
    else {
        // Need taller — expand height, keep width
        newW = w;
        newH = Math.round(w / best.ratio);
    }
    // Re-center and clamp to image bounds
    let left = Math.round(centerX - newW / 2);
    let top = Math.round(centerY - newH / 2);
    if (left < 0)
        left = 0;
    if (top < 0)
        top = 0;
    if (left + newW > imgWidth)
        left = imgWidth - newW;
    if (top + newH > imgHeight)
        top = imgHeight - newH;
    // If still out of bounds (region larger than image), clamp dimensions
    if (left < 0) {
        left = 0;
        newW = imgWidth;
    }
    if (top < 0) {
        top = 0;
        newH = imgHeight;
    }
    return { left, top, width: newW, height: newH, aspectLabel: best.label };
}
server.tool("fix_region", `Fix a specific region of an image by cropping it out, sending it for repair, and reinserting it. The crop is automatically snapped to the nearest supported aspect ratio. Use this when only part of an image has glitched text or artifacts — more precise than fix_image's grid approach.`, {
    filename: z.string().describe(`Filename of the source image in ${SAVE_DIR}`),
    prompt: z
        .string()
        .default("Clean up and fix any garbled, glitched, or distorted text in this image region. Preserve the style, colors, and layout exactly but make all text crisp and legible.")
        .describe("Instructions for fixing the selected region"),
    x: z.number().min(0).max(100).describe("Left edge of region as percentage of image width (0-100)"),
    y: z.number().min(0).max(100).describe("Top edge of region as percentage of image height (0-100)"),
    width: z.number().min(1).max(100).describe("Width of region as percentage of image width (1-100)"),
    height: z.number().min(1).max(100).describe("Height of region as percentage of image height (1-100)"),
    image_size: z
        .enum(["512", "1K", "2K", "4K"])
        .default("1K")
        .describe("Resolution for the cropped region"),
    model: z.enum(MODEL_KEYS).optional().describe(MODEL_PARAM_DESCRIPTION),
}, async ({ filename, prompt, x, y, width, height, image_size, model }) => {
    try {
        await ensureViewer();
        log(`fix_region: source=${filename} region=(${x}%,${y}%,${width}%,${height}%)`);
        const t0 = Date.now();
        // Load source image
        const filepath = join(SAVE_DIR, filename);
        const srcBuf = await readFile(filepath);
        const metadata = await sharp(srcBuf).metadata();
        const imgW = metadata.width;
        const imgH = metadata.height;
        log(`  Source: ${imgW}x${imgH}`);
        // Convert percentages to pixels
        const pxX = Math.round((x / 100) * imgW);
        const pxY = Math.round((y / 100) * imgH);
        const pxW = Math.round((width / 100) * imgW);
        const pxH = Math.round((height / 100) * imgH);
        // Snap to nearest aspect ratio
        const snapped = snapToAspectRatio(pxX, pxY, pxW, pxH, imgW, imgH);
        log(`  Requested: ${pxW}x${pxH} at (${pxX},${pxY}) -> Snapped: ${snapped.width}x${snapped.height} at (${snapped.left},${snapped.top}) [${snapped.aspectLabel}]`);
        // Extract the region
        const regionBuf = await sharp(srcBuf)
            .extract({ left: snapped.left, top: snapped.top, width: snapped.width, height: snapped.height })
            .png()
            .toBuffer();
        // Compress for Gemini if needed
        let sendBuf;
        let sendMime;
        if (snapped.width > 1024 || regionBuf.length > 500_000) {
            sendBuf = await sharp(regionBuf).resize(Math.min(snapped.width, 1024)).jpeg({ quality: 85 }).toBuffer();
            sendMime = "image/jpeg";
        }
        else {
            sendBuf = regionBuf;
            sendMime = "image/png";
        }
        const { provider: regionProvider, modelId: regionModelId } = getProvider(model);
        const { imageBase64, modelUsed } = await regionProvider.edit({
            prompt,
            imageBase64: sendBuf.toString("base64"),
            imageMime: sendMime,
            aspectRatio: snapped.aspectLabel,
            imageSize: image_size,
            modelId: regionModelId,
        });
        // Resize fixed region back to exact pixel dimensions of the snapped crop
        let fixedRegion = await sharp(Buffer.from(imageBase64, "base64"))
            .resize(snapped.width, snapped.height, { fit: "fill" })
            .png()
            .toBuffer();
        // Match brightness/contrast to original region
        fixedRegion = await matchHistogram(fixedRegion, regionBuf);
        // Composite back into original image
        const finalBuf = await sharp(srcBuf)
            .composite([{ input: fixedRegion, left: snapped.left, top: snapped.top }])
            .png()
            .toBuffer();
        // Save result
        const id = randomUUID();
        const outFilename = await saveToDisk(finalBuf, `fixreg_${id.slice(0, 8)}`);
        log(`  Composited fixed region -> ${outFilename}`);
        const img = {
            id,
            prompt: `[fix-region ${x}%,${y}% ${width}%x${height}%] ${prompt.slice(0, 50)}`,
            fullPng: finalBuf,
            timestamp: Date.now(),
            filename: outFilename,
            modelUsed,
        };
        imageStore.push(img);
        notifyViewerClients(img);
        const { base64: mcpBase64, mime: mcpMimeType } = await shrinkForMcp(finalBuf);
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        log(`fix_region complete in ${elapsed}s`);
        return {
            content: [
                {
                    type: "text",
                    text: `Region snapped from ${pxW}x${pxH} to ${snapped.width}x${snapped.height} (${snapped.aspectLabel})`,
                },
                { type: "image", data: mcpBase64, mimeType: mcpMimeType },
                { type: "text", text: `Saved as ${outFilename} — full-res at http://localhost:${viewerPort}${noticeFor(modelUsed)}` },
            ],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`fix_region error: ${msg}`);
        return {
            content: [{ type: "text", text: `fix_region failed: ${msg}` }],
            isError: true,
        };
    }
});
server.tool("interactive_fix", `Opens an image in a browser-based crop tool where the user can draw a rectangle around the region to fix, add notes/instructions, and submit. The tool waits for the user's selection, then sends the cropped region for repair and composites it back into the original image. Best for precise, user-guided fixes.`, {
    filename: z.string().describe(`Filename of the source image in ${SAVE_DIR}`),
    image_size: z
        .enum(["512", "1K", "2K", "4K"])
        .default("1K")
        .describe("Resolution for the cropped region"),
    model: z.enum(MODEL_KEYS).optional().describe(MODEL_PARAM_DESCRIPTION),
}, async ({ filename, image_size, model }) => {
    let completeResolve;
    try {
        await ensureViewer();
        log(`interactive_fix: opening crop UI for ${filename}`);
        // Open crop UI in browser
        const cropUrl = `http://localhost:${viewerPort}/crop/${encodeURIComponent(filename)}`;
        log(`  Opening crop URL: ${cropUrl}`);
        openExternal(cropUrl);
        // Wait for the user to submit a crop selection
        log(`  Waiting for user to select region in browser...`);
        const onComplete = new Promise((r) => { completeResolve = r; });
        const submission = await new Promise((resolve) => {
            pendingCrops.set(filename, { resolve, onComplete, completeResolve });
        });
        log(`  User submitted: region=(${submission.x.toFixed(1)}%,${submission.y.toFixed(1)}%,${submission.width.toFixed(1)}%,${submission.height.toFixed(1)}%) prompt="${submission.prompt.slice(0, 80)}"`);
        // Load source image
        const filepath = join(SAVE_DIR, filename);
        const srcBuf = await readFile(filepath);
        const metadata = await sharp(srcBuf).metadata();
        const imgW = metadata.width;
        const imgH = metadata.height;
        // Convert percentages to pixels
        const pxX = Math.round((submission.x / 100) * imgW);
        const pxY = Math.round((submission.y / 100) * imgH);
        const pxW = Math.round((submission.width / 100) * imgW);
        const pxH = Math.round((submission.height / 100) * imgH);
        // Snap to nearest aspect ratio
        const snapped = snapToAspectRatio(pxX, pxY, pxW, pxH, imgW, imgH);
        log(`  Snapped: ${snapped.width}x${snapped.height} at (${snapped.left},${snapped.top}) [${snapped.aspectLabel}]`);
        // Extract the region
        const regionBuf = await sharp(srcBuf)
            .extract({ left: snapped.left, top: snapped.top, width: snapped.width, height: snapped.height })
            .png()
            .toBuffer();
        // Compress for Gemini if needed
        let sendBuf;
        let sendMime;
        if (snapped.width > 1024 || regionBuf.length > 500_000) {
            sendBuf = await sharp(regionBuf).resize(Math.min(snapped.width, 1024)).jpeg({ quality: 85 }).toBuffer();
            sendMime = "image/jpeg";
        }
        else {
            sendBuf = regionBuf;
            sendMime = "image/png";
        }
        const prompt = submission.prompt || "Clean up and fix any garbled, glitched, or distorted text. Preserve the style, colors, and layout exactly.";
        const shots = submission.shots || 1;
        const { provider: fixProvider, modelId: fixModelId } = getProvider(model);
        log(`  Firing ${shots} parallel ${fixProvider.name} call(s)...`);
        const geminiResults = await Promise.allSettled(Array.from({ length: shots }, (_, i) => fixProvider.edit({
            prompt,
            imageBase64: sendBuf.toString("base64"),
            imageMime: sendMime,
            aspectRatio: snapped.aspectLabel,
            imageSize: image_size,
            modelId: fixModelId,
        }).then(async ({ imageBase64, modelUsed }) => {
            // Resize, histogram match, and composite each result
            let fixedRegion = await sharp(Buffer.from(imageBase64, "base64"))
                .resize(snapped.width, snapped.height, { fit: "fill" })
                .png()
                .toBuffer();
            fixedRegion = await matchHistogram(fixedRegion, regionBuf);
            const compositedBuf = await sharp(srcBuf)
                .composite([{ input: fixedRegion, left: snapped.left, top: snapped.top }])
                .png()
                .toBuffer();
            // Save each shot to disk
            const shotId = randomUUID();
            const shotFilename = await saveToDisk(compositedBuf, `ifix_${shotId.slice(0, 8)}`);
            log(`  Shot ${i + 1}/${shots} -> ${shotFilename}`);
            const img = {
                id: shotId,
                prompt: `[interactive-fix shot ${i + 1}] ${prompt.slice(0, 50)}`,
                fullPng: compositedBuf,
                timestamp: Date.now(),
                filename: shotFilename,
                modelUsed,
            };
            imageStore.push(img);
            notifyViewerClients(img);
            return { filename: shotFilename, buffer: compositedBuf, modelUsed };
        })));
        const succeeded = geminiResults
            .filter((r) => r.status === "fulfilled")
            .map((r) => r.value);
        if (succeeded.length === 0) {
            const firstErr = geminiResults[0].reason?.message || "Unknown error";
            throw new Error(`All ${shots} shots failed. First error: ${firstErr}`);
        }
        log(`  ${succeeded.length}/${shots} shots succeeded`);
        let chosenFilename;
        let chosenBuffer;
        let chosenModel;
        if (succeeded.length === 1) {
            // Single result — use it directly
            chosenFilename = succeeded[0].filename;
            chosenBuffer = succeeded[0].buffer;
            chosenModel = succeeded[0].modelUsed;
            completeResolve({ ok: true, filename: chosenFilename });
        }
        else {
            // Multiple results — send filenames to browser for user selection
            const filenames = succeeded.map((s) => s.filename);
            completeResolve({ ok: true, filenames });
            // Wait for user to pick their favorite
            log(`  Waiting for user to select from ${filenames.length} shots...`);
            const selectedIndex = await new Promise((resolve) => {
                pendingSelections.set(filename, { resolve, filenames });
            });
            chosenFilename = succeeded[selectedIndex].filename;
            chosenBuffer = succeeded[selectedIndex].buffer;
            chosenModel = succeeded[selectedIndex].modelUsed;
            log(`  User selected shot ${selectedIndex + 1}: ${chosenFilename}`);
        }
        const { base64: mcpBase64, mime: mcpMimeType } = await shrinkForMcp(chosenBuffer);
        return {
            content: [
                {
                    type: "text",
                    text: `User selected region: ${submission.x.toFixed(1)}%,${submission.y.toFixed(1)}% ${submission.width.toFixed(1)}%x${submission.height.toFixed(1)}% -> snapped to ${snapped.width}x${snapped.height} (${snapped.aspectLabel})\n${shots} shot(s), ${succeeded.length} succeeded. User picked: ${chosenFilename}\nUser notes: ${submission.prompt || "(none)"}`,
                },
                { type: "image", data: mcpBase64, mimeType: mcpMimeType },
                { type: "text", text: `Saved as ${chosenFilename} — full-res at http://localhost:${viewerPort}${noticeFor(chosenModel)}` },
            ],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`interactive_fix error: ${msg}`);
        // Notify the browser of failure too
        completeResolve?.({ ok: false, error: msg });
        return {
            content: [{ type: "text", text: `interactive_fix failed: ${msg}` }],
            isError: true,
        };
    }
});
server.tool("remove_background", `Remove white (or near-white) background from an image and make it transparent. Outputs a PNG with alpha channel. The image must already exist in ${SAVE_DIR} (use save_image to import first).`, {
    filename: z.string().describe(`Filename of the source image in ${SAVE_DIR}`),
    threshold: z
        .number()
        .min(0)
        .max(255)
        .default(30)
        .describe("How far from pure white a pixel can be and still count as background (0 = exact white only, 30 = default, higher = more aggressive)"),
}, async ({ filename, threshold }) => {
    try {
        const srcPath = join(SAVE_DIR, filename);
        const { data, info } = await sharp(srcPath)
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true });
        const channels = info.channels; // 4 (RGBA)
        for (let i = 0; i < data.length; i += channels) {
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            if (r >= 255 - threshold && g >= 255 - threshold && b >= 255 - threshold) {
                data[i + 3] = 0; // set alpha to 0
            }
        }
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        const outFilename = `${ts}_nobg.png`;
        const outPath = join(SAVE_DIR, outFilename);
        await sharp(data, {
            raw: { width: info.width, height: info.height, channels: 4 },
        })
            .png()
            .toFile(outPath);
        const s = await stat(outPath);
        log(`remove_background: ${filename} -> ${outFilename} (${(s.size / 1024).toFixed(0)}KB, threshold=${threshold})`);
        // Register in viewer
        await ensureViewer();
        const fullPng = await readFile(outPath);
        const id = randomUUID();
        const img = {
            id,
            prompt: `remove_background(${filename}, threshold=${threshold})`,
            fullPng,
            timestamp: Date.now(),
            filename: outFilename,
        };
        imageStore.push(img);
        notifyViewerClients(img);
        return {
            content: [
                {
                    type: "text",
                    text: `Background removed! Saved as ${outFilename} (${(s.size / 1024).toFixed(0)}KB). View full-res at http://localhost:${viewerPort}`,
                },
            ],
        };
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`remove_background error: ${msg}`);
        return {
            content: [{ type: "text", text: `remove_background failed: ${msg}` }],
            isError: true,
        };
    }
});
// --- Startup ---
let viewerStarted = false;
async function ensureViewer() {
    if (viewerStarted)
        return;
    viewerStarted = true;
    viewerPort = await startViewer();
    log(`Viewer running at http://localhost:${viewerPort}`);
    openExternal(`http://localhost:${viewerPort}`);
}
async function main() {
    if (GOOGLE_API_KEY) {
        providers["gemini"] = new GeminiProvider();
        log("Gemini provider available");
    }
    if (OPENAI_API_KEY) {
        providers["openai"] = new OpenAIProvider();
        log("OpenAI provider available");
    }
    if (!GOOGLE_API_KEY && !OPENAI_API_KEY) {
        log("WARNING: Neither GOOGLE_API_KEY nor OPENAI_API_KEY is set. No image providers available.");
    }
    log(`Default model: ${getDefaultModelKey()}`);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("MCP server running on stdio");
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
