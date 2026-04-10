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
const SAVE_DIR = join(homedir(), "Pictures", "nanobanana2");
const API_KEY = process.env.GOOGLE_API_KEY;
const MODEL = "gemini-3.1-flash-image-preview";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const VEO_MODEL = "veo-3.1-generate-preview";
const VEO_BASE = "https://generativelanguage.googleapis.com/v1beta";
const VEO_ENDPOINT = `${VEO_BASE}/models/${VEO_MODEL}:predictLongRunning`;
const VEO_POLL_INTERVAL = 10_000; // 10 seconds
const VEO_MAX_POLLS = 60; // 10 minutes max
const MAX_MCP_BYTES = 950_000;
function log(msg) {
    console.error(`[nanobanana2 ${new Date().toISOString()}] ${msg}`);
}
const imageStore = [];
const videoStore = [];
let viewerPort = null;
const sseClients = new Set();
const pendingSelections = new Map();
const pendingCrops = new Map();
function notifyViewerClients(img) {
    const event = JSON.stringify({ id: img.id, prompt: img.prompt, type: "image" });
    for (const client of sseClients) {
        client.write(`data: ${event}\n\n`);
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
                res.writeHead(200, { "Content-Type": "text/html" });
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
                import("child_process").then(({ exec }) => exec(`open "${SAVE_DIR}"`));
                res.writeHead(204);
                res.end();
                return;
            }
            // Respin endpoint — regenerate an image with the same prompt
            if (url.pathname === "/respin" && req.method === "POST") {
                let body = "";
                req.on("data", (chunk) => { body += chunk.toString(); });
                req.on("end", async () => {
                    try {
                        const { id, prompt: customPrompt } = JSON.parse(body);
                        const source = imageStore.find((i) => i.id === id);
                        if (!source) {
                            res.writeHead(404, { "Content-Type": "application/json" });
                            res.end(JSON.stringify({ error: "Image not found" }));
                            return;
                        }
                        const finalPrompt = (customPrompt && customPrompt.trim()) ? customPrompt.trim() : source.prompt;
                        log(`respin: re-generating from "${finalPrompt.slice(0, 80)}..." (${source.imageSize ?? "1K"}, ${source.aspectRatio ?? "1:1"})`);
                        const result = await generateAndStore(finalPrompt, source.aspectRatio ?? "1:1", source.imageSize ?? "1K");
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
            res.writeHead(200, { "Content-Type": "text/html" });
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
        return `<div class="img-entry" id="img-${img.id}">
          <div class="prompt-row">
            <textarea class="prompt-edit" data-id="${img.id}">${esc(img.prompt)}</textarea>
            <button class="respin-btn" onclick="respin('${img.id}', this)" title="Regenerate (edit prompt above to change)">&#x21bb; Respin</button>
          </div>
          <img src="/img/${img.id}" />
        </div>`;
    })
        .join("\n");
    return `<!DOCTYPE html>
<html><head><title>Nanobanana2</title>
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
  .respin-btn { background: #2a4a6b; color: #8bc4ff; border: 1px solid #3a6a9b; padding: 8px 16px; cursor: pointer; font-size: 13px; font-family: system-ui; border-radius: 4px; transition: all 0.15s; white-space: nowrap; align-self: flex-start; }
  .respin-btn:hover { background: #3a6a9b; color: #fff; }
  .respin-btn:disabled { opacity: 0.5; cursor: wait; }
  .video-badge { background: #6b2a2a; color: #ff8b8b; border: 1px solid #9b3a3a; padding: 8px 16px; font-size: 11px; font-family: system-ui; border-radius: 4px; white-space: nowrap; align-self: flex-start; font-weight: 600; letter-spacing: 0.5px; }
</style></head><body>
<button id="open-folder" onclick="fetch('/open-folder',{method:'POST'})">Open in Finder</button>
<p id="empty">Waiting for images...</p>
<div id="gallery">${itemTags}</div>
<script>
const gallery = document.getElementById("gallery");
const empty = document.getElementById("empty");
const es = new EventSource("/events");
es.onmessage = (e) => {
  const data = JSON.parse(e.data);
  const { id, prompt, type, filename } = data;
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
    const btn = document.createElement("button");
    btn.className = "respin-btn";
    btn.innerHTML = "&#x21bb; Respin";
    btn.title = "Regenerate (edit prompt above to change)";
    btn.onclick = function() { respin(id, this); };
    row.appendChild(ta);
    row.appendChild(btn);
    const img = document.createElement("img");
    img.src = "/img/" + id;
    div.appendChild(row);
    div.appendChild(img);
  }
  gallery.prepend(div);
};
async function respin(id, btn) {
  btn.disabled = true;
  btn.textContent = "Generating...";
  const ta = document.querySelector('textarea[data-id="' + id + '"]');
  const prompt = ta ? ta.value : undefined;
  try {
    const res = await fetch("/respin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, prompt }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Respin failed");
    btn.textContent = "\u21bb Respin";
    btn.disabled = false;
  } catch (err) {
    btn.textContent = "Failed — retry?";
    btn.disabled = false;
  }
}
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
async function callGemini(inputParts, aspectRatio, imageSize) {
    const t0 = Date.now();
    log(`  Calling Gemini API (${imageSize}, ${aspectRatio}, ${inputParts.length} parts)...`);
    let res;
    try {
        res = await fetch(`${ENDPOINT}?key=${API_KEY}`, {
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
    log(`  Gemini responded HTTP ${res.status} in ${(elapsed / 1000).toFixed(1)}s`);
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
    log(`  Got image: ${(imageBase64.length / 1024).toFixed(0)}KB base64`);
    return { imageBase64, text };
}
// --- Veo API ---
async function callVeo(prompt, aspectRatio, durationSeconds) {
    const t0 = Date.now();
    log(`  Calling Veo API (${VEO_MODEL}, ${aspectRatio}, ${durationSeconds}s)...`);
    let res;
    try {
        res = await fetch(`${VEO_ENDPOINT}?key=${API_KEY}`, {
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
    const pollUrl = `${VEO_BASE}/${operation.name}?key=${API_KEY}`;
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
            const downloadRes = await fetch(`${videoUri}&key=${API_KEY}`, { redirect: "follow" });
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
async function generateAndStore(prompt, aspectRatio, imageSize) {
    const { imageBase64, text } = await callGemini([{ text: prompt }], aspectRatio, imageSize);
    const fullPng = Buffer.from(imageBase64, "base64");
    const id = randomUUID();
    const filename = await saveToDisk(fullPng, id.slice(0, 8));
    log(`  Saved ${filename}`);
    const img = { id, prompt, fullPng, timestamp: Date.now(), filename, aspectRatio, imageSize };
    imageStore.push(img);
    notifyViewerClients(img);
    const { base64: mcpBase64, mime: mcpMimeType } = await shrinkForMcp(fullPng);
    return { mcpBase64, mcpMimeType, text, filename };
}
/** Edit, store, return shrunk for MCP */
async function editAndStore(prompt, sourceBase64, sourceMime, aspectRatio, imageSize) {
    const { imageBase64, text } = await callGemini([
        { text: prompt },
        { inlineData: { mimeType: sourceMime, data: sourceBase64 } },
    ], aspectRatio, imageSize);
    const fullPng = Buffer.from(imageBase64, "base64");
    const id = randomUUID();
    const filename = await saveToDisk(fullPng, id.slice(0, 8));
    log(`  Saved ${filename}`);
    const img = { id, prompt: `[edit] ${prompt}`, fullPng, timestamp: Date.now(), filename };
    imageStore.push(img);
    notifyViewerClients(img);
    const { base64: mcpBase64, mime: mcpMimeType } = await shrinkForMcp(fullPng);
    return { mcpBase64, mcpMimeType, text, filename };
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
const server = new McpServer({ name: "nanobanana2", version: "1.0.0" }, { capabilities: { tools: {} } });
server.tool("list_images", `List image and video files in the shared nanobanana2 directory (${SAVE_DIR}). Use this to find images available for editing.`, {}, async () => {
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
server.tool("save_image", `Copy an image file into the shared nanobanana2 directory (${SAVE_DIR}) so it can be used with edit_image. Use this when the user wants to edit an image that exists elsewhere on their filesystem.`, {
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
server.tool("generate_images", "Generate multiple images in parallel using Google's Nanobanana2 (Gemini 3.1 Flash Image). Returns the generated images and any accompanying text. Full-resolution images are viewable in the browser viewer.", {
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
        .enum(["512", "1K", "2K"])
        .default("1K")
        .describe("Image resolution"),
    style: z
        .enum(STYLE_KEYS)
        .optional()
        .describe(STYLE_DESCRIPTION),
}, async ({ prompts, aspect_ratio, image_size, style }) => {
    try {
        await ensureViewer();
        const resolvedAR = resolveAspectRatio(aspect_ratio, style);
        log(`generate_images: ${prompts.length} prompts, ${image_size}, ${resolvedAR}${style ? ` [style: ${style}]` : ""}`);
        const t0 = Date.now();
        const results = await Promise.allSettled(prompts.map((prompt, i) => {
            const styledPrompt = applyStyle(prompt, style);
            log(`  [${i + 1}/${prompts.length}] "${styledPrompt.slice(0, 80)}${styledPrompt.length > 80 ? "..." : ""}"`);
            return generateAndStore(styledPrompt, resolvedAR, image_size);
        }));
        const content = [];
        let anySucceeded = false;
        for (let i = 0; i < results.length; i++) {
            const result = results[i];
            if (result.status === "fulfilled") {
                anySucceeded = true;
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
            text: `Full-res images in ${SAVE_DIR} — viewable at http://localhost:${viewerPort}`,
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
server.tool("generate_image", "Generate a single image using Google's Nanobanana2 (Gemini 3.1 Flash Image). Full-resolution image is viewable in the browser viewer.", {
    prompt: z.string().describe("Text prompt describing the image to generate"),
    aspect_ratio: z
        .enum(["1:1", "16:9", "9:16", "3:4", "4:3", "2:3", "3:2", "4:5", "5:4"])
        .default("1:1")
        .describe("Aspect ratio for the image"),
    image_size: z
        .enum(["512", "1K", "2K"])
        .default("1K")
        .describe("Image resolution"),
    style: z
        .enum(STYLE_KEYS)
        .optional()
        .describe(STYLE_DESCRIPTION),
}, async ({ prompt, aspect_ratio, image_size, style }) => {
    try {
        await ensureViewer();
        const styledPrompt = applyStyle(prompt, style);
        const resolvedAR = resolveAspectRatio(aspect_ratio, style);
        log(`generate_image: "${styledPrompt.slice(0, 80)}${styledPrompt.length > 80 ? "..." : ""}" (${image_size}, ${resolvedAR})${style ? ` [style: ${style}]` : ""}`);
        const t0 = Date.now();
        const { mcpBase64, mcpMimeType, text, filename } = await generateAndStore(styledPrompt, resolvedAR, image_size);
        log(`generate_image complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return {
            content: [
                ...(text ? [{ type: "text", text }] : []),
                { type: "image", data: mcpBase64, mimeType: mcpMimeType },
                { type: "text", text: `Saved as ${filename} — full-res at http://localhost:${viewerPort}` },
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
server.tool("edit_image", `Edit an existing image using Google's Nanobanana2 (Gemini 3.1 Flash Image). Provide the filename of an image in ${SAVE_DIR} (use list_images to see available files, or save_image to import one first). The MCP reads the file directly — do NOT pass base64 image data.`, {
    prompt: z.string().describe("Text prompt describing the edits to make to the image"),
    filename: z.string().describe(`Filename of the source image in ${SAVE_DIR} (e.g. "2026-03-17T17-47-31-152Z_59f735df.png")`),
    aspect_ratio: z
        .enum(["1:1", "16:9", "9:16", "3:4", "4:3", "2:3", "3:2", "4:5", "5:4"])
        .default("1:1")
        .describe("Aspect ratio for the output image"),
    image_size: z
        .enum(["512", "1K", "2K"])
        .default("1K")
        .describe("Output image resolution"),
    style: z
        .enum(STYLE_KEYS)
        .optional()
        .describe(STYLE_DESCRIPTION),
}, async ({ prompt, filename, aspect_ratio, image_size, style }) => {
    try {
        await ensureViewer();
        const styledPrompt = applyStyle(prompt, style);
        const resolvedAR = resolveAspectRatio(aspect_ratio, style);
        log(`edit_image: "${styledPrompt.slice(0, 80)}${styledPrompt.length > 80 ? "..." : ""}" source=${filename} (${image_size}, ${resolvedAR})${style ? ` [style: ${style}]` : ""}`);
        const t0 = Date.now();
        const { base64: srcBase64, mime: srcMime } = await loadForGemini(filename);
        const { mcpBase64, mcpMimeType, text, filename: outFilename } = await editAndStore(styledPrompt, srcBase64, srcMime, resolvedAR, image_size);
        log(`edit_image complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return {
            content: [
                ...(text ? [{ type: "text", text }] : []),
                { type: "image", data: mcpBase64, mimeType: mcpMimeType },
                { type: "text", text: `Saved as ${outFilename} — full-res at http://localhost:${viewerPort}` },
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
server.tool("fix_image", `Fix an image that has glitched or garbled text by splitting it into tiles, re-rendering each tile through Gemini, and stitching them back together. This works because smaller sections have less text for the model to handle at once. Use this when a generated image has text artifacts or overloaded text regions.`, {
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
        .enum(["512", "1K", "2K"])
        .default("1K")
        .describe("Resolution for each tile's Gemini call"),
}, async ({ filename, prompt, grid, image_size }) => {
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
        // Send each tile to Gemini in parallel
        const fixResults = await Promise.allSettled(tiles.map(async (tile, i) => {
            log(`  [tile ${i + 1}/${tiles.length}] sending to Gemini...`);
            // Compress tile for Gemini
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
            const { imageBase64 } = await callGemini([
                { text: prompt },
                { inlineData: { mimeType: sendMime, data: sendBuf.toString("base64") } },
            ], bestAspect.label, image_size);
            return { col: tile.col, row: tile.row, buffer: Buffer.from(imageBase64, "base64") };
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
        const img = {
            id,
            prompt: `[fix ${grid}] ${prompt.slice(0, 60)}`,
            fullPng: finalBuf,
            timestamp: Date.now(),
            filename: outFilename,
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
                    text: `Fixed ${successCount}/${tiles.length} tiles (${grid} grid). Saved as ${outFilename} — full-res at http://localhost:${viewerPort}`,
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
server.tool("fix_region", `Fix a specific region of an image by cropping it out, sending it to Gemini for repair, and reinserting it. The crop is automatically snapped to the nearest Gemini-supported aspect ratio. Use this when only part of an image has glitched text or artifacts — more precise than fix_image's grid approach.`, {
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
        .enum(["512", "1K", "2K"])
        .default("1K")
        .describe("Resolution for the Gemini call on the cropped region"),
}, async ({ filename, prompt, x, y, width, height, image_size }) => {
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
        // Send to Gemini
        const { imageBase64 } = await callGemini([
            { text: prompt },
            { inlineData: { mimeType: sendMime, data: sendBuf.toString("base64") } },
        ], snapped.aspectLabel, image_size);
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
                { type: "text", text: `Saved as ${outFilename} — full-res at http://localhost:${viewerPort}` },
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
server.tool("interactive_fix", `Opens an image in a browser-based crop tool where the user can draw a rectangle around the region to fix, add notes/instructions, and submit. The tool waits for the user's selection, then sends the cropped region to Gemini for repair and composites it back into the original image. Best for precise, user-guided fixes.`, {
    filename: z.string().describe(`Filename of the source image in ${SAVE_DIR}`),
    image_size: z
        .enum(["512", "1K", "2K"])
        .default("1K")
        .describe("Resolution for the Gemini call on the cropped region"),
}, async ({ filename, image_size }) => {
    let completeResolve;
    try {
        await ensureViewer();
        log(`interactive_fix: opening crop UI for ${filename}`);
        // Open crop UI in browser
        const cropUrl = `http://localhost:${viewerPort}/crop/${encodeURIComponent(filename)}`;
        log(`  Opening crop URL: ${cropUrl}`);
        const { execFile } = await import("child_process");
        execFile("open", [cropUrl]);
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
        log(`  Firing ${shots} parallel Gemini call(s)...`);
        // Fire N parallel Gemini calls
        const geminiResults = await Promise.allSettled(Array.from({ length: shots }, (_, i) => callGemini([
            { text: prompt },
            { inlineData: { mimeType: sendMime, data: sendBuf.toString("base64") } },
        ], snapped.aspectLabel, image_size).then(async ({ imageBase64 }) => {
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
            };
            imageStore.push(img);
            notifyViewerClients(img);
            return { filename: shotFilename, buffer: compositedBuf };
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
        if (succeeded.length === 1) {
            // Single result — use it directly
            chosenFilename = succeeded[0].filename;
            chosenBuffer = succeeded[0].buffer;
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
                { type: "text", text: `Saved as ${chosenFilename} — full-res at http://localhost:${viewerPort}` },
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
    const { exec } = await import("child_process");
    exec(`open http://localhost:${viewerPort}`);
}
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log("MCP server running on stdio");
}
main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
