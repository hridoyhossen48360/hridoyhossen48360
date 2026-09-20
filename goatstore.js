/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║            GoatStore — GoatBot Store Command                 ║
 * ║     Your own store: https://goatstore-nu.vercel.app          ║
 * ║  Author : Hridoy Hossen  |  Compatible: GoatBot v6+          ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * FEATURES:
 *  ✅ Search | List | Category | Author Search | Command Details
 *  ✅ Install | Event Install | Upload (command/event)
 *  ✅ Like / Unlike | Trending
 *  ✅ Delete commands
 *  ✅ Pagination (Reply-based & Reaction-based)
 *  ✅ Auto-update (self) | Auto-sync (background)
 *  ✅ Syntax validation | Framework detection
 *  ✅ Command/Event folder detection | Cache system
 *  ✅ Progress/loading UI
 *  ✅ Error handling | Duplicate detection
 *  ✅ Install count | Restart-less command reload
 *  ✅ GoatBot compatibility
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const axios = require("axios");

// ═══════════════════════════════════════════════════════════
//  CONFIG — change these to match your setup
// ═══════════════════════════════════════════════════════════
const _H = "https://hridoy-api.onrender.com";
function _api(path = "") { return `${_H}/api/gs${path}`; }

const CONFIG = {
  API_HOST: "https://hridoy-api.onrender.com",

  // How often to check for self-updates (ms) — 30 minutes
  UPDATE_CHECK_INTERVAL: 1000 * 60 * 30,

  // Pastebin API key — used to auto-upload code and get a raw link
  PASTEBIN_API_KEY: "gox0XMEkCRsKqzS5Jh9ffKD4mv7vya-3",

  // Auto-sync your commands to the store on startup?
  AUTO_SYNC: true,

  // How often the background auto-sync sweep re-checks every file (ms).
  // A file-watcher (below) already catches new/changed files almost
  // instantly — this interval is just a safety-net re-scan.
  AUTO_SYNC_INTERVAL: 1000 * 60 * 60, // 1 hour

  // Watch the commands/events folders and sync a file within a couple
  // of seconds of it being added or changed, instead of waiting for
  // the interval above.
  AUTO_SYNC_WATCH: true,

  // Categories your API supports (must match backend enum)
  CATEGORIES: ["economy", "fun", "moderation", "games", "utility", "ai"],

  // Max reaction-edits before sending a fresh message
  MAX_EDITS_PER_MESSAGE: 5,
};

// ═══════════════════════════════════════════════════════════
//  CACHE FILE PATHS
// ═══════════════════════════════════════════════════════════
const SYNC_CACHE_PATH = path.join(process.cwd(), "goatstore_sync_cache.json");
const DIR_CACHE_PATH  = path.join(process.cwd(), "goatstore_dircache.json");

// ═══════════════════════════════════════════════════════════
//  IN-MEMORY STATE
// ═══════════════════════════════════════════════════════════
const userSeenNoti      = new Map();
let   _updateCheckCache = null;
let   _autoupdateInFlight = false;

// ═══════════════════════════════════════════════════════════
//  HELPERS — Prefix detection
// ═══════════════════════════════════════════════════════════
function getPrefix(threadData) {
  try {
    if (threadData?.data?.prefix) return threadData.data.prefix;
    if (global.GoatBot?.config?.prefix) return global.GoatBot.config.prefix;
  } catch (_) {}
  return "!";
}

// ═══════════════════════════════════════════════════════════
//  HELPERS — Cache I/O
// ═══════════════════════════════════════════════════════════
function loadJson(filePath, fallback = {}) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function saveJson(filePath, data) {
  try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); }
  catch (_) {}
}

// ═══════════════════════════════════════════════════════════
//  HELPERS — Directory detection
// ═══════════════════════════════════════════════════════════
const EVENTS_PATTERNS = ["events", "event"];
const SKIP_DIRS       = new Set(["node_modules", ".git", ".cache", "dist", "build"]);

let _dirCache = loadJson(DIR_CACHE_PATH, {});

function scanForDir(startDir, patterns, maxDepth = 2) {
  const queue = [{ dir: startDir, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory() || SKIP_DIRS.has(ent.name) || ent.name.startsWith(".")) continue;
      const full  = path.join(dir, ent.name);
      if (patterns.includes(ent.name.toLowerCase())) return full;
      if (depth < maxDepth) queue.push({ dir: full, depth: depth + 1 });
    }
  }
  return null;
}

function getCmdsDir(forceRescan = false) {
  if (!forceRescan && _dirCache.cmdsDir && fs.existsSync(_dirCache.cmdsDir))
    return _dirCache.cmdsDir;
  const dir = __dirname; // goatstore.js lives IN the commands folder
  _dirCache.cmdsDir = dir;
  saveJson(DIR_CACHE_PATH, _dirCache);
  return dir;
}

function getEventsDir(forceRescan = false) {
  if (!forceRescan && _dirCache.eventsDir && fs.existsSync(_dirCache.eventsDir))
    return _dirCache.eventsDir;
  const parent = path.dirname(getCmdsDir(forceRescan));
  const dir    = scanForDir(parent, EVENTS_PATTERNS, 2) || path.join(parent, "events");
  _dirCache.eventsDir = dir;
  saveJson(DIR_CACHE_PATH, _dirCache);
  return dir;
}

// ═══════════════════════════════════════════════════════════
//  HELPERS — Version comparison
// ═══════════════════════════════════════════════════════════
function parseVer(v) { return String(v).split(".").map(n => parseInt(n) || 0); }
function cmpVer(a, b) {
  const pa = parseVer(a), pb = parseVer(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════
//  HELPERS — Hash (for sync dedup)
// ═══════════════════════════════════════════════════════════
function hashContent(content) {
  let h = 0;
  for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0;
  return h.toString(16);
}

// ═══════════════════════════════════════════════════════════
//  HELPERS — GoatBot framework detection
// ═══════════════════════════════════════════════════════════
function detectFramework(code) {
  const isGoat =
    /module\.exports\s*=\s*\{/.test(code) &&
    /onStart\s*[:(]|onChat\s*[:(]|onLoad\s*[:(]/.test(code) &&
    /\bauthor\s*:/.test(code);
  return isGoat ? "goat" : "other";
}

// Shows the short #01-style ID when the API gave us one, falling back
// to the raw database ID for older records that predate it. Either form
// works when typed back into {pn} install/delete/rawlink <id>.
function displayId(cmd) {
  if (cmd && Number.isInteger(cmd.seq)) return "#" + String(cmd.seq).padStart(2, "0");
  return cmd?._id || cmd?.id || "N/A";
}

// ═══════════════════════════════════════════════════════════
//  API CALLS
// ═══════════════════════════════════════════════════════════

/** Search commands */
async function apiSearch(q = "", category = "", limit = 0, kind = "") {
  const params = new URLSearchParams();
  if (q) params.set("q", q);
  if (category && category !== "all") params.set("category", category);
  if (kind) params.set("kind", kind);
  if (limit) params.set("limit", limit);
  const res = await axios.get(`${_api("/commands")}?${params.toString()}`);
  return Array.isArray(res.data) ? res.data : [];
}

/** Trending commands */
async function apiTrending(limit = 10) {
  const res = await axios.get(`${_api("/commands/trending")}?limit=${limit}`);
  const data = Array.isArray(res.data) ? res.data : [];
  return data.slice(0, limit);
}

/** Fetch single command by ID */
async function apiGetOne(id) {
  const res = await axios.get(_api(`/commands/${id}`));
  return res.data || null;
}

/** Upload a new command/event */
async function apiUpload({ name, category, description, author, code, kind, version }) {
  const res = await axios.post(
    _api("/commands"),
    { name, category, description, author, code, kind, version },
    { headers: { "Content-Type": "application/json" } }
  );
  return { ...res.data, _created: res.status === 201 };
}

/** Toggle like on a command */
async function apiLike(id, visitorId) {
  const res = await axios.post(
    _api(`/commands/${id}/like`),
    { visitor_id: visitorId },
    { headers: { "Content-Type": "application/json" } }
  );
  return res.data; // { liked, likes }
}

/** Delete a command */
async function apiDelete(id) {
  const res = await axios.delete(
    _api(`/commands/${id}`),
    { headers: { "Content-Type": "application/json" } }
  );
  return res.data;
}

// ═══════════════════════════════════════════════════════════
//  PASTEBIN — upload code and return raw URL
// ═══════════════════════════════════════════════════════════

/**
 * Upload code to Pastebin and return the raw URL.
 * Uses Pastebin API v2 (POST https://pastebin.com/api/api_post.php).
 * Returns: "https://pastebin.com/raw/XXXXXXXX"  or null on failure.
 */
async function uploadToPastebin(code, pasteName = "GoatBot Command") {
  try {
    const params = new URLSearchParams();
    params.set("api_dev_key",       CONFIG.PASTEBIN_API_KEY);
    params.set("api_option",        "paste");
    params.set("api_paste_code",    code);
    params.set("api_paste_name",    pasteName);
    params.set("api_paste_format",  "javascript");
    params.set("api_paste_expire_date", "N"); // Never expire
    params.set("api_paste_private", "0");     // Public

    const res = await axios.post(
      "https://pastebin.com/api/api_post.php",
      params.toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, timeout: 10000 }
    );

    // Response is plain text like "https://pastebin.com/AbCdEfGh"
    const pasteUrl = (res.data || "").trim();
    if (!pasteUrl.startsWith("https://pastebin.com/")) return null;

    // Convert to raw URL: https://pastebin.com/raw/AbCdEfGh
    const pasteKey = pasteUrl.replace("https://pastebin.com/", "");
    return `https://pastebin.com/raw/${pasteKey}`;
  } catch (_) {
    return null;
  }
}

/** Save Pastebin raw link to DB record */
async function apiSetPastebin(id, rawUrl) {
  try {
    await axios.patch(
      _api(`/commands/${id}/pastebin`),
      { url: rawUrl },
      { headers: { "Content-Type": "application/json" } }
    );
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════
//  VISITOR ID — stable anonymous ID per bot instance
// ═══════════════════════════════════════════════════════════
let _visitorId = null;
function getVisitorId() {
  if (_visitorId) return _visitorId;
  const cachePath = path.join(process.cwd(), "goatstore_visitor.json");
  const cache     = loadJson(cachePath, {});
  if (cache.id) { _visitorId = cache.id; return _visitorId; }
  _visitorId = `bot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  saveJson(cachePath, { id: _visitorId });
  return _visitorId;
}

// ═══════════════════════════════════════════════════════════
//  PROGRESS ANIMATION
// ═══════════════════════════════════════════════════════════
const FRAMES   = ["◖", "◕", "◔", "◓", "◒", "◑", "◐"];
const buildBar = (pct) =>
  "█".repeat(Math.floor(pct / 10)) + "░".repeat(10 - Math.floor(pct / 10));

async function animateInstall(api, threadID, name) {
  const steps = [
    { label: "Downloading source",   pct: 30,  delay: 600 },
    { label: "Verifying integrity",  pct: 60,  delay: 900 },
    { label: "Writing to disk",      pct: 85,  delay: 700 },
    { label: "Registering command",  pct: 100, delay: 600 },
  ];
  const info = await api.sendMessage(
    `📦 Installing ${name}...\n\n◖ Fetching package info...\n[░░░░░░░░░░] 0%`,
    threadID
  );
  for (let i = 0; i < steps.length; i++) {
    await new Promise(r => setTimeout(r, steps[i].delay));
    await api.editMessage(
      `📦 Installing ${name}...\n\n${FRAMES[i]} ${steps[i].label}...\n[${buildBar(steps[i].pct)}] ${steps[i].pct}%`,
      info.messageID
    );
  }
  return info.messageID;
}

async function animateUpload(api, threadID, name) {
  const steps = [
    { label: "Reading file",              pct: 30,  delay: 500 },
    { label: "Uploading to store",        pct: 70,  delay: 900 },
    { label: "Finalizing registration",   pct: 100, delay: 500 },
  ];
  const info = await api.sendMessage(
    `📤 Uploading ${name}...\n\n◖ Preparing upload...\n[░░░░░░░░░░] 0%`,
    threadID
  );
  for (let i = 0; i < steps.length; i++) {
    await new Promise(r => setTimeout(r, steps[i].delay));
    await api.editMessage(
      `📤 Uploading ${name}...\n\n${FRAMES[i]} ${steps[i].label}...\n[${buildBar(steps[i].pct)}] ${steps[i].pct}%`,
      info.messageID
    );
  }
  return info.messageID;
}

// ═══════════════════════════════════════════════════════════
//  AUTOLOAD — reload a command into GoatBot without restart
// ═══════════════════════════════════════════════════════════
function autoloadCommand(filePath) {
  try {
    delete require.cache[require.resolve(filePath)];
    const cmd = require(filePath);
    if (cmd?.config?.name) {
      const name = cmd.config.name.toLowerCase();
      global.GoatBot.commands.set(name, cmd);
      if (Array.isArray(cmd.config.aliases))
        cmd.config.aliases.forEach(a => global.GoatBot.commands.set(a.toLowerCase(), cmd));
      if (typeof cmd.onLoad === "function") cmd.onLoad({});
      return { success: true, name };
    }
    return { success: false, reason: "Missing config.name." };
  } catch (err) {
    return { success: false, reason: err.message };
  }
}

// ═══════════════════════════════════════════════════════════
//  CATEGORY BADGE
// ═══════════════════════════════════════════════════════════
const CAT_ICONS = {
  economy: "💰", fun: "🎉", moderation: "🛡️",
  games: "🎮", utility: "🔧", ai: "✨",
};
function catBadge(cmd) {
  const icon = CAT_ICONS[cmd.category] || "📦";
  return `${icon} ${cmd.category || "uncategorized"}`;
}

// ═══════════════════════════════════════════════════════════
//  INSTALL — download code and save to disk
// ═══════════════════════════════════════════════════════════
async function doInstall(api, threadID, id, forceKind = null) {
  // Fetch the command by ID
  let cmd = null;
  try {
    cmd = await apiGetOne(id);
  } catch (_) {}

  // B2 fix: proper null check — cmd itself may be null
  if (!cmd) return api.sendMessage("❌ Command not found.", threadID);
  if (!cmd.code && !cmd.pastebin_url)
    return api.sendMessage("❌ Command has no code or Pastebin link stored.", threadID);

  // Determine install type
  const isEvent = forceKind === "event";

  // B3 fix: if code is missing but pastebin_url exists, fetch it
  let code = cmd.code || "";
  if (!code && cmd.pastebin_url) {
    try {
      const pbRes = await axios.get(cmd.pastebin_url, { timeout: 10000, responseType: "text" });
      code = typeof pbRes.data === "string" ? pbRes.data : String(pbRes.data);
    } catch (_) {
      return api.sendMessage(
        `❌ Failed to fetch code from Pastebin.\n` +
        `╭─‣ URL: ${cmd.pastebin_url}\n╰────────────◊\n` +
        `💡 Try again or check the Pastebin link.`,
        threadID
      );
    }
  }

  // Validate syntax
  if (code) {
    try { new Function(code); }
    catch (err) { return api.sendMessage(`❌ Syntax error in remote code:\n${err.message}`, threadID); }
  }

  const displayName = cmd.name || `gs_${id}`;
  let pid;
  try { pid = await animateInstall(api, threadID, displayName); } catch (_) {}

  const installDir = isEvent ? getEventsDir() : getCmdsDir();
  const fileName   = displayName.replace(/\s+/g, "_") + ".js";
  const filePath   = path.join(installDir, fileName);
  const locLabel   = path.relative(process.cwd(), filePath);

  try {
    if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });
    fs.writeFileSync(filePath, code, "utf-8");
  } catch (err) {
    if (pid) api.unsendMessage(pid).catch(() => {});
    return api.sendMessage(`❌ Failed to write file:\n${err.message}`, threadID);
  }

  // Reload into GoatBot (commands only; events need restart)
  const load = isEvent ? { success: false } : autoloadCommand(filePath);

  const msg =
    `✅ Installed Successfully!\n` +
    `╭─‣ Name     : ${cmd.name || "Unknown"}\n` +
    `├‣ Author    : ${cmd.author || "Unknown"}\n` +
    `├‣ Category  : ${catBadge(cmd)}\n` +
    `├‣ Version   : v${cmd.version || "1.0.0"}\n` +
    `├‣ Type      : ${cmd.kind === "event" ? "⚡ Event" : "🧩 Command"}\n` +
    `├‣ ID        : ${displayId(cmd)}\n` +
    `├‣ Likes     : ❤️ ${cmd.likes || 0}\n` +
    `├‣ Location  : ${locLabel}\n` +
    `╰────────────◊\n` +
    `📝 ${cmd.description || cmd.shortDescription || "No description"}\n` +
    `📅 Added: ${new Date(cmd.createdAt || Date.now()).toDateString()}\n` +
    (load.success
      ? `🚀 "${load.name}" is now live! No restart needed.`
      : isEvent
      ? `⚠️ Event saved. Restart bot to apply.`
      : `⚠️ Autoload failed: ${load.reason}`);

  if (pid) {
    try {
      await api.editMessage(msg, pid);
      setTimeout(() => api.unsendMessage(pid).catch(() => {}), 6000);
    } catch (_) { api.sendMessage(msg, threadID); }
  } else {
    api.sendMessage(msg, threadID);
  }
}

// ═══════════════════════════════════════════════════════════
//  UPLOAD — send a local file to the store
// ═══════════════════════════════════════════════════════════
async function doUpload(api, threadID, filePath, kind = "command") {
  let code;
  try { code = fs.readFileSync(filePath, "utf8"); }
  catch (err) { return api.sendMessage(`❌ Read failed:\n${err.message}`, threadID); }

  // Syntax check
  try { new Function(code); }
  catch (err) { return api.sendMessage(`❌ Syntax Error:\n${err.message}`, threadID); }

  // Parse meta from code
  const name        = code.match(/name\s*:\s*["'`](.*?)["'`]/)?.[1] || path.basename(filePath, ".js");
  const author      = code.match(/author\s*:\s*["'`](.*?)["'`]/)?.[1] || "Unknown";
  const description = code.match(/longDescription\s*:\s*["'`](.*?)["'`]/)?.[1]
                   || code.match(/shortDescription\s*:\s*["'`](.*?)["'`]/)?.[1]
                   || "No description";
  // Map GoatBot category to store category
  const rawCat  = (code.match(/category\s*:\s*["'`](.*?)["'`]/)?.[1] || "utility").toLowerCase();
  const category = CONFIG.CATEGORIES.includes(rawCat) ? rawCat : "utility";
  const version = code.match(/version\s*:\s*["'`](.*?)["'`]/)?.[1] || "1.0.0";

  let pid;
  try { pid = await animateUpload(api, threadID, name); } catch (_) {}

  try {
    // ── Upload code to Pastebin FIRST to avoid 413 payload-too-large ──
    // The store API only receives metadata + the raw Pastebin URL,
    // never the full source code, so the request body stays tiny.
    let rawUrl = null;
    rawUrl = await uploadToPastebin(code, name);
    if (!rawUrl) {
      if (pid) api.unsendMessage(pid).catch(() => {});
      return api.sendMessage(
        `❌ Pastebin Upload Failed!\n╭─‣ Name : ${name}\n├‣ Reason : Could not upload code to Pastebin\n╰────────────◊\n💡 Check CONFIG.PASTEBIN_API_KEY or try again.`,
        threadID
      );
    }

    const result = await apiUpload({ name, category, description, author, code: rawUrl, kind, version });

    if (result.error) {
      if (pid) api.unsendMessage(pid).catch(() => {});
      return api.sendMessage(
        `⚠️ Upload Failed!\n╭─‣ Name : ${name}\n├‣ Error : ${result.error}\n╰────────────◊`,
        threadID
      );
    }

    // Every genuinely new upload gets saved as its own entry with its own
    // ID — the API only ever short-circuits when name + full script (code)
    // + version + author are ALL identical to something already stored
    // (result "_duplicate": true below), to avoid pointless identical
    // clones. Any real change — different code, a version bump, a
    // different author — always becomes a fresh entry and never touches
    // the older one.
    const isDuplicate = result._duplicate === true;
    const newId = result._id || result.id;

    // Save pastebin link to DB record if not already stored
    if (rawUrl && newId && !result.pastebin_url) {
      apiSetPastebin(newId, rawUrl).catch(() => {});
    }

    const sameNameCount = result._sameNameCount || 0;
    const displayedId   = displayId(result) !== "N/A" ? displayId(result) : (newId || "N/A");

    const msg =
      `${isDuplicate ? "⏭️ Already Up To Date" : "✅ Upload Successful!"}\n` +
      `╭─‣ Name     : ${name}\n` +
      `├‣ Category  : ${catBadge({ category })}\n` +
      `├‣ Author    : ${author}\n` +
      `├‣ Version   : v${version}\n` +
      `├‣ Type      : ${kind === "event" ? "⚡ Event" : "🧩 Command"}\n` +
      `├‣ ID        : ${displayedId}\n` +
      `├‣ Raw Link  : ${rawUrl}\n` +
      `╰────────────◊\n` +
      `📝 ${description}\n` +
      (isDuplicate
        ? `💡 Identical code is already stored under this name at the ID above — nothing new was created.`
        : sameNameCount > 0
        ? `📌 ${sameNameCount} other command(s) already use the name "${name}" — this upload was saved as a separate new entry, they were not affected.\n📅 Uploaded: ${new Date().toDateString()}`
        : `📅 Uploaded: ${new Date().toDateString()}`);

    if (pid) {
      try { await api.editMessage(msg, pid); }
      catch (_) { api.sendMessage(msg, threadID); }
    } else {
      api.sendMessage(msg, threadID);
    }
  } catch (err) {
    if (pid) api.unsendMessage(pid).catch(() => {});
    const errMsg = err.response?.data?.error || err.message || "Unknown error";
    // Handle duplicate from HTTP 409
    if (err.response?.status === 409) {
      return api.sendMessage(
        `⚠️ Already Exists in Store!\n╭─‣ Name : ${name}\n╰────────────◊\n💡 A command with that name already exists.`,
        threadID
      );
    }
    api.sendMessage(
      `❌ Store API Call Failed!\n├‣ Error : ${errMsg}\n╰────────────◊\n💡 Check network or store backend.`,
      threadID
    );
  }
}

function getPfxHint() {
  try { return getPrefix(); } catch (_) { return "!"; }
}

// ═══════════════════════════════════════════════════════════
//  SELF-UPDATE CHECK
// ═══════════════════════════════════════════════════════════
async function checkSelfUpdate() {
  const now = Date.now();
  if (_updateCheckCache && (now - _updateCheckCache.checkedAt) < CONFIG.UPDATE_CHECK_INTERVAL)
    return _updateCheckCache.result;
  try {
    // Search for "goatstore" command in store
    const cmds = await apiSearch("goatstore");
    const match = cmds.find(c => c.name?.toLowerCase() === "goatstore");
    if (!match) { _updateCheckCache = { checkedAt: now, result: null }; return null; }
    const current = module.exports.config.version;
    const latest  = match.version || "0.0.0";
    const result = {
      hasUpdate:      cmpVer(latest, current) > 0,
      currentVersion: current,
      latestVersion:  latest,
      latestId:       match._id || match.id,
      description:    match.description || "",
    };
    _updateCheckCache = { checkedAt: now, result };
    return result;
  } catch (_) { return null; }
}

async function doSelfUpdateSilent(api, threadID, selfUpdate) {
  try {
    const cmd = await apiGetOne(selfUpdate.latestId);
    if (!cmd?.code) return false;
    try { new Function(cmd.code); } catch (_) { return false; }
    fs.writeFileSync(__filename, cmd.code, "utf-8");
    const load = autoloadCommand(__filename);
    if (api && threadID) {
      const msg =
        `♻️ Auto-Updated GoatStore!\n` +
        `╭─‣ Version : v${cmd.version || selfUpdate.latestVersion}\n` +
        `╰────────────◊\n` +
        `📝 ${(cmd.description || "No changelog.").trim()}\n\n` +
        (load.success ? `🚀 Live now!` : `⚠️ Restart bot to apply.`);
      api.sendMessage(msg, threadID).catch(() => {});
    }
    return true;
  } catch (_) { return false; }
}

async function maybeAutoUpdate(api, threadID) {
  if (_autoupdateInFlight) return;
  const info = await checkSelfUpdate();
  if (!info?.hasUpdate) return;
  _autoupdateInFlight = true;
  try { await doSelfUpdateSilent(api, threadID, info); }
  finally { _autoupdateInFlight = false; }
}

// ═══════════════════════════════════════════════════════════
//  AUTO-SYNC — upload local commands to store in background
// ═══════════════════════════════════════════════════════════
async function runAutoSync() {
  const folders = [
    { dir: getCmdsDir(),    kind: "command" },
    { dir: getEventsDir(),  kind: "event" },
  ].filter(f => fs.existsSync(f.dir));

  if (!folders.length) return;
  const cache = loadJson(SYNC_CACHE_PATH, {});

  for (const { dir, kind } of folders) {
    const files = fs.readdirSync(dir).filter(f => f.endsWith(".js"));
    for (const file of files) {
      const fullPath = path.join(dir, file);
      let code;
      try { code = fs.readFileSync(fullPath, "utf8"); } catch (_) { continue; }

      const hash     = hashContent(code);
      // B10 fix: include version in cache key so a version bump always re-uploads
      const cacheKey = `${kind}:${file}:${version}`;
      if (cache[cacheKey]?.hash === hash) continue;

      // Syntax check
      try { new Function(code); } catch (_) { continue; }
      // Only sync GoatBot files
      if (detectFramework(code) !== "goat") continue;

      const name        = code.match(/name\s*:\s*["'`](.*?)["'`]/)?.[1] || path.basename(file, ".js");
      const author      = code.match(/author\s*:\s*["'`](.*?)["'`]/)?.[1] || "Unknown";
      const description = code.match(/shortDescription\s*:\s*["'`](.*?)["'`]/)?.[1] || "No description";
      const rawCat      = (code.match(/category\s*:\s*["'`](.*?)["'`]/)?.[1] || "utility").toLowerCase();
      const category    = CONFIG.CATEGORIES.includes(rawCat) ? rawCat : "utility";
      const version     = code.match(/version\s*:\s*["'`](.*?)["'`]/)?.[1] || "1.0.0";

      try {
        // Upload to Pastebin first to avoid 413 on large files
        const rawUrl = await uploadToPastebin(code, name);
        const uploadCode = rawUrl || code;
        const result = await apiUpload({ name, category, description, author, code: uploadCode, kind, version });
        if (!result.error) {
          cache[cacheKey] = { hash, id: result._id || result.id };
          const tag = result._duplicate ? "already stored" : "uploaded as new entry";
          console.log(`[goatstore-sync] ${file}: ${tag} (ID: ${cache[cacheKey].id})`);
          // Save Pastebin link if we have it
          if (rawUrl && cache[cacheKey].id && !result.pastebin_url) {
            apiSetPastebin(cache[cacheKey].id, rawUrl).catch(() => {});
          }
        } else {
          console.log(`[goatstore-sync] ${file}: skipped — ${result.error}`);
        }
      } catch (err) {
        const e = err.response?.data?.error || err.message;
        console.error(`[goatstore-sync] ${file}: error — ${e}`);
      }
      await new Promise(r => setTimeout(r, 600));
    }
  }
  saveJson(SYNC_CACHE_PATH, cache);
}

// ═══════════════════════════════════════════════════════════
//  INSTANT SYNC — watch commands/events folders, upload on change
// ═══════════════════════════════════════════════════════════
let _watchDebounce = null;
let _watchersStarted = false;

function startAutoSyncWatcher() {
  if (_watchersStarted) return;
  _watchersStarted = true;

  const dirs = [getCmdsDir(), getEventsDir()].filter(d => d && fs.existsSync(d));

  for (const dir of dirs) {
    try {
      fs.watch(dir, { persistent: false }, (eventType, filename) => {
        if (!filename || !filename.endsWith(".js")) return;
        // Debounce — editors often fire several change events per save,
        // and a fresh bot restart can touch many files at once.
        clearTimeout(_watchDebounce);
        _watchDebounce = setTimeout(() => {
          runAutoSync().catch(() => {});
        }, 3000);
      });
    } catch (_) {
      // fs.watch isn't available on every OS/filesystem — the interval
      // sweep in onLoad still covers this dir, just less instantly.
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  TODAY'S UPDATES
// ═══════════════════════════════════════════════════════════
async function getTodayUpdates() {
  try {
    const all   = await apiSearch(""); // all commands, sorted newest first
    const today = new Date().toDateString();
    return all.filter(c => new Date(c.createdAt || c.updatedAt || 0).toDateString() === today);
  } catch (_) { return []; }
}

// ═══════════════════════════════════════════════════════════
//  PAGINATION HELPERS
// ═══════════════════════════════════════════════════════════
function paginateArray(arr, page, limit) {
  const total      = arr.length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const offset     = (page - 1) * limit;
  const slice      = arr.slice(offset, offset + limit);
  return { items: slice, total, totalPages };
}

function renderCmdRow(cmd) {
  return (
    `╭─‣ ${cmd.kind === "event" ? "⚡" : "🧩"} ${cmd.name} 〄\n` +
    `├‣ ID : ${displayId(cmd)}\n` +
    `├‣ Author : ${cmd.author || "Unknown"}\n` +
    `├‣ Category : ${catBadge(cmd)}\n` +
    `├‣ Likes : ❤️ ${cmd.likes || 0}\n` +
    `╰────────────◊\n` +
    ` ✰ Added : ${new Date(cmd.createdAt || Date.now()).toDateString()}\n\n`
  );
}

// ─── List page ────────────────────────────────────────────
async function sendListPage(api, threadID, senderID, category, page, limit, prefix) {
  try {
    const all  = await apiSearch("", category);
    const { items, total, totalPages } = paginateArray(all, page, limit);
    if (!items.length) return api.sendMessage("❌ No commands found for this page.", threadID);

    const label = category ? `📂 Category: ${category}` : "📂 All Commands";
    let msg = `${label} — Page ${page}/${totalPages} (${total} total)\n\n`;
    items.forEach(cmd => { msg += renderCmdRow(cmd); });
    if (totalPages > 1)
      msg += `Reply "page <number>" or react ➡ to go to next page.\n`;

    const sent = await api.sendMessage(msg.trim(), threadID);
    if (totalPages > 1) {
      const h = {
        commandName: "goatstore", messageID: sent.messageID,
        mode: "list", category, page, totalPages, limit, senderID, editCount: 0,
      };
      global.GoatBot.onReply.set(sent.messageID, h);
      global.GoatBot.onReaction.set(sent.messageID, h);
    }
  } catch (_) { api.sendMessage("❌ List API error.", threadID); }
}

// ─── Search page ──────────────────────────────────────────
async function sendSearchPage(api, threadID, senderID, query, category, page, limit, prefix) {
  try {
    const all  = await apiSearch(query, category);
    const { items, total, totalPages } = paginateArray(all, page, limit);
    if (!items.length)
      return api.sendMessage(`❌ No results${query ? ` for "${query}"` : ""}.`, threadID);

    const title = query ? `🔍 Search: "${query}"` : `📂 Category: ${category || "all"}`;
    let msg = `${title} (${total} found)\n\n`;
    items.forEach(cmd => { msg += renderCmdRow(cmd); });
    if (totalPages > 1)
      msg += `Page ${page}/${totalPages}\nReply "page <number>" or react ➡ next page.\n`;

    const sent = await api.sendMessage(msg.trim(), threadID);
    const h = {
      commandName: "goatstore", messageID: sent.messageID,
      mode: "search", query, category, page, totalPages, limit, senderID, editCount: 0,
    };
    global.GoatBot.onReply.set(sent.messageID, h);
    if (totalPages > 1) global.GoatBot.onReaction.set(sent.messageID, h);
  } catch (_) { api.sendMessage("❌ Search API error.", threadID); }
}

// ─── Render-into (for reaction pagination) ───────────────
async function renderListInto(category, page, limit) {
  const all  = await apiSearch("", category);
  const { items, total, totalPages } = paginateArray(all, page, limit);
  if (!items.length) return null;
  const label = category ? `📂 Category: ${category}` : "📂 All Commands";
  let msg = `${label} — Page ${page}/${totalPages} (${total} total)\n\n`;
  items.forEach(cmd => { msg += renderCmdRow(cmd); });
  if (totalPages > 1) msg += `React ➡ next page.`;
  return { text: msg.trim(), totalPages };
}

async function renderSearchInto(query, category, page, limit) {
  const all  = await apiSearch(query, category);
  const { items, total, totalPages } = paginateArray(all, page, limit);
  if (!items.length) return null;
  const title = query ? `🔍 Search: "${query}"` : `📂 Category: ${category || "all"}`;
  let msg = `${title} (${total} found)\n\n`;
  items.forEach(cmd => { msg += renderCmdRow(cmd); });
  if (totalPages > 1) msg += `Page ${page}/${totalPages}\nReact ➡ next page.`;
  return { text: msg.trim(), totalPages };
}

// ═══════════════════════════════════════════════════════════
//  MENU
// ═══════════════════════════════════════════════════════════
function buildMenu(prefix) {
  const p = `${prefix}gs`;
  return (
    `📦 GoatStore — Command Marketplace\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `• ${p}              — Menu / Notifications\n` +
    `• ${p} n            — Today's new commands\n` +
    `• ${p} list [page]  — Browse all commands\n` +
    `• ${p} list <cat> [page]  — Browse by category\n` +
    `• ${p} events       — Browse events only\n` +
    `• ${p} commands     — Browse commands only\n` +
    `• ${p} <name/id>    — Search by name, author, or ID\n` +
    `• ${p} author <n>   — All by an author\n` +
    `• ${p} install <id> — Install a command\n` +
    `• ${p} event install <id> — Install as event\n` +
    `• ${p} like <id>    — Like/unlike\n` +
    `• ${p} trending     — Top trending\n` +
    `• ${p} upload <file>       — Upload command\n` +
    `• ${p} upload event <file> — Upload event\n` +
    `• ${p} rawlink <id> — Get raw Pastebin link\n` +
    `• ${p} delete <id>  — Delete a command\n` +
    `• ${p} sync         — Manual sync\n` +
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
    `Categories: ${CONFIG.CATEGORIES.join(", ")}\n` +
    `Reply "page <n>" on any list to jump pages.\n` +
    `React ➡ on any list to go to next page.`
  );
}

// ═══════════════════════════════════════════════════════════
//  MODULE EXPORT
// ═══════════════════════════════════════════════════════════
module.exports = {
  config: {
    name:             "goatstore",
    aliases:          ["gs", "store", "cmdstore"],
    version:          "1.0.0",
    author:           "Hridoy Hossen",
    countDown:        3,
    role:             0,
    shortDescription: "GoatStore — Browse, install & upload GoatBot commands",
    longDescription:  "Full-featured store command: search, install, upload, like, trending, pagination and auto-sync for GoatBot.",
    category:         "System",
    guide: {
      en:
        "{pn} — Menu\n" +
        "{pn} n — Today's updates\n" +
        "{pn} list [page] — All commands\n" +
        "{pn} list <category> [page] — By category\n" +
        "{pn} <query> — Search\n" +
        "{pn} author <name> — By author\n" +
        "{pn} install <id> — Install\n" +
        "{pn} event install <id> — Install as event\n" +
        "{pn} like <id> — Like\n" +
        "{pn} trending — Top trending\n" +
        "{pn} upload <file> — Upload\n" +
        "{pn} upload event <file> — Upload event\n" +
        "{pn} rawlink <id> — Get Pastebin raw link\n" +
        "{pn} delete <id> — Admin delete\n" +
        "{pn} sync — Manual sync",
    },
    autoSync: CONFIG.AUTO_SYNC,
  },

  // ─── onLoad ─────────────────────────────────────────────
  onLoad: function () {
    // Background self-update check
    setTimeout(() => {
      maybeAutoUpdate(null, null).catch(() => {});
      setInterval(() => maybeAutoUpdate(null, null).catch(() => {}), CONFIG.UPDATE_CHECK_INTERVAL);
    }, 6000);

    // Auto-sync if enabled — runs once shortly after startup, then on
    // a fixed interval as a safety-net re-scan.
    if (module.exports.config.autoSync) {
      setTimeout(() => {
        runAutoSync().catch(() => {});
        setInterval(() => runAutoSync().catch(() => {}), CONFIG.AUTO_SYNC_INTERVAL);
      }, 10000);

      // Instant sync — watches the commands/events folders and uploads
      // a file within a couple of seconds of it being added or edited,
      // instead of waiting for the interval sweep above.
      if (CONFIG.AUTO_SYNC_WATCH) startAutoSyncWatcher();
    }
  },

  // ─── onReply ────────────────────────────────────────────
  onReply: async function ({ api, event, Reply }) {
    const { threadID, body, senderID } = event;
    // Reply-based delete
    const delMatch = body.match(/^delete\s+(\S+)/i);
    if (delMatch) {
      const rawId = delMatch[1];
      const id = rawId.replace(/^#/, ""); // strip # prefix
      try {
        await apiDelete(id);
        return api.sendMessage(`🗑️ Deleted! ID: ${rawId}`, threadID);
      } catch (err) {
        const e = err.response?.data?.error || err.message;
        return api.sendMessage(`❌ Delete failed: ${e}`, threadID);
      }
    }

    const { mode, query, category, page, totalPages, limit, senderID: origSender } = Reply;
    if (String(senderID) !== String(origSender)) return;

    const match = body.match(/^page\s+(\d+)$/i);
    if (!match) return;
    const newPage = parseInt(match[1]);
    if (newPage < 1 || newPage > totalPages)
      return api.sendMessage(`❌ Page must be between 1 and ${totalPages}.`, threadID);

    api.unsendMessage(Reply.messageID).catch(() => {});
    const prefix = getPrefix(event.threadData);
    if (mode === "list")
      await sendListPage(api, threadID, senderID, category, newPage, limit, prefix);
    else
      await sendSearchPage(api, threadID, senderID, query, category, newPage, limit, prefix);
  },

  // ─── onReaction ─────────────────────────────────────────
  onReaction: async function ({ api, event, Reaction }) {
    const { threadID, userID } = event;
    const { mode, query, category, page, totalPages, limit, senderID, messageID, editCount = 0 } = Reaction;
    if (String(userID) !== String(senderID)) return;
    if (page >= totalPages)
      return api.sendMessage("✅ Already on the last page.", threadID);

    const nextPage = page + 1;
    try {
      const rendered = mode === "list"
        ? await renderListInto(category, nextPage, limit)
        : await renderSearchInto(query, category, nextPage, limit);

      if (!rendered) return api.sendMessage("❌ No results for this page.", threadID);

      if (editCount >= CONFIG.MAX_EDITS_PER_MESSAGE) {
        const sent = await api.sendMessage(rendered.text, threadID);
        const h = { commandName: "goatstore", messageID: sent.messageID, mode, query, category, page: nextPage, totalPages: rendered.totalPages, limit, senderID, editCount: 0 };
        global.GoatBot.onReply.set(sent.messageID, h);
        global.GoatBot.onReaction.set(sent.messageID, h);
      } else {
        await api.editMessage(rendered.text, messageID);
        const h = { commandName: "goatstore", messageID, mode, query, category, page: nextPage, totalPages: rendered.totalPages, limit, senderID, editCount: editCount + 1 };
        global.GoatBot.onReply.set(messageID, h);
        global.GoatBot.onReaction.set(messageID, h);
      }
    } catch (_) {
      api.unsendMessage(messageID).catch(() => {});
      const prefix = getPrefix(event.threadData);
      if (mode === "list")
        await sendListPage(api, threadID, senderID, category, nextPage, limit, prefix);
      else
        await sendSearchPage(api, threadID, senderID, query, category, nextPage, limit, prefix);
    }
  },

  // ─── onStart ────────────────────────────────────────────
  onStart: async function ({ api, event, args, threadData }) {
    const { threadID, senderID } = event;

    const prefix = getPrefix(threadData || event?.threadData);
    const sub    = args[0]?.toLowerCase() || null;

    // Background self-update (cached — near zero cost)
    maybeAutoUpdate(api, threadID).catch(() => {});

    // ── Menu / Notification ──────────────────────────────
    if (!sub) {
      const updates = await getTodayUpdates();
      if (updates.length && !userSeenNoti.get(senderID)) {
        let n = `🔔 [ NOTIFICATION ]\nToday ${updates.length} new command(s)!\n━━━━━━━━━━━━\n`;
        updates.forEach(c => { n += ` ‣ ${c.name} (ID: ${displayId(c)})\n`; });
        n += `\n(Type "${prefix}gs n" for details or "${prefix}gs" again for menu)`;
        userSeenNoti.set(senderID, true);
        return api.sendMessage(n, threadID);
      }
      return api.sendMessage(buildMenu(prefix), threadID);
    }

    // ── Notifications ────────────────────────────────────
    if (sub === "n" || sub === "notification") {
      const updates = await getTodayUpdates();
      if (!updates.length)
        return api.sendMessage("📅 No new commands today.", threadID);
      let msg = `📂 Today's New Commands\n━━━━━━━━━━━━\n`;
      updates.forEach(c =>
        msg += `╭─‣ ${c.name}\n├‣ ID: ${displayId(c)}\n├‣ Author: ${c.author}\n╰────────────◊\n\n`
      );
      return api.sendMessage(msg.trim(), threadID);
    }

    // ── Sync ─────────────────────────────────────────────
    if (sub === "sync") {
      api.sendMessage("🔄 Starting manual sync...", threadID);
      try {
        await runAutoSync();
        api.sendMessage("✅ Sync complete.", threadID);
      } catch (err) {
        api.sendMessage(`❌ Sync failed: ${err.message}`, threadID);
      }
      return;
    }

    // ── List ─────────────────────────────────────────────
    if (sub === "list" || sub === "ls") {
      // !gs list [page]   OR   !gs list <category> [page]
      const maybeCategory = args[1]?.toLowerCase();
      const isCategory    = CONFIG.CATEGORIES.includes(maybeCategory);
      const category      = isCategory ? maybeCategory : "";
      const page          = Math.max(1, Number(isCategory ? args[2] : args[1]) || 1);
      return sendListPage(api, threadID, senderID, category, page, 8, prefix);
    }

    // ── Event install ────────────────────────────────────
    if (sub === "event") {
      const action = args[1]?.toLowerCase();
      if (action === "install") {
        const id = args[2];
        if (!id) return api.sendMessage(`❌ Usage: ${prefix}gs event install <id>`, threadID);
        return doInstall(api, threadID, id, "event");
      }
      // Event list/search
      const q = args.slice(1).join(" ");
      return sendSearchPage(api, threadID, senderID, q, "", 1, 5, prefix);
    }

    // ── Install ──────────────────────────────────────────
    if (sub === "install") {
      const id = args[1];
      if (!id) return api.sendMessage(`❌ Usage: ${prefix}gs install <id>`, threadID);
      return doInstall(api, threadID, id, null);
    }

    // ── Like ─────────────────────────────────────────────
    if (sub === "like") {
      const rawId = args[1];
      if (!rawId) return api.sendMessage(`❌ Usage: ${prefix}gs like <id>`, threadID);
      const id = rawId.replace(/^#/, ""); // B8 fix: strip # prefix
      try {
        const res = await apiLike(id, getVisitorId());
        if (res.liked)
          return api.sendMessage(`❤️ Liked! Total likes: ${res.likes}`, threadID);
        else
          return api.sendMessage(`💔 Unliked. Total likes: ${res.likes}`, threadID);
      } catch (_) { return api.sendMessage("❌ Like API error.", threadID); }
    }

    // ── Trending ─────────────────────────────────────────
    if (sub === "trend" || sub === "trending") {
      try {
        const list = await apiTrending(8);
        if (!list.length) return api.sendMessage("❌ No trending commands yet.", threadID);
        let msg = `🔥 Top Trending Commands 🔥\n\n`;
        list.forEach((cmd, i) => {
          msg +=
            `╭─‣ ${cmd.name}${i === 0 ? " 🏆" : ""}\n` +
            `├‣ Category : ${catBadge(cmd)}\n` +
            `├‣ Likes : ❤️ ${cmd.likes || 0}\n` +
            `├‣ Author : ${cmd.author || "Unknown"}\n` +
            `├‣ ID : ${displayId(cmd)}\n` +
            `╰────────────◊\n\n`;
        });
        return api.sendMessage(msg.trim(), threadID);
      } catch (_) { return api.sendMessage("❌ Trending API error.", threadID); }
    }

    // ── Upload ───────────────────────────────────────────
    if (sub === "upload") {
      const isEvent = args[1]?.toLowerCase() === "event";
      const fileName = isEvent ? args[2] : args[1];
      const kind     = isEvent ? "event" : "command";
      if (!fileName)
        return api.sendMessage(
          `📁 Usage:\n• ${prefix}gs upload <fileName>\n• ${prefix}gs upload event <fileName>`,
          threadID
        );
      // Include GoatBot v2 standard paths (scripts/cmds, scripts/events)
      const cwd = process.cwd();
      const stdCmds   = path.join(cwd, "scripts", "cmds");
      const stdEvents = path.join(cwd, "scripts", "events");
      const dirs = kind === "event"
        ? [getEventsDir(), stdEvents, path.join(cwd, "events")]
        : [getCmdsDir(), stdCmds, getEventsDir(), stdEvents, cwd];
      let filePath = null;
      for (const dir of dirs) {
        if (fs.existsSync(path.join(dir, fileName)))           { filePath = path.join(dir, fileName); break; }
        if (fs.existsSync(path.join(dir, fileName + ".js")))   { filePath = path.join(dir, fileName + ".js"); break; }
      }
      if (!filePath) return api.sendMessage(`❌ File not found: "${fileName}"`, threadID);
      return doUpload(api, threadID, filePath, kind);
    }

    // ── Raw Link ─────────────────────────────────────────
    if (sub === "rawlink" || sub === "raw") {
      const id = args[1];
      if (!id) return api.sendMessage(`❌ Usage: ${prefix}gs rawlink <id>`, threadID);

      const loadMsg = await api.sendMessage(`⏳ Fetching raw link for ID: ${id}...`, threadID);

      try {
        const cmd = await apiGetOne(id);
        if (!cmd) {
          api.unsendMessage(loadMsg.messageID).catch(() => {});
          return api.sendMessage("❌ Command not found.", threadID);
        }

        // Already has a Pastebin link → return it directly
        if (cmd.pastebin_url) {
          api.unsendMessage(loadMsg.messageID).catch(() => {});
          return api.sendMessage(
            `🔗 Raw Link — ${cmd.name}\n` +
            `╭─‣ Pastebin : ${cmd.pastebin_url}\n` +
            `╰────────────◊\n` +
            `💡 Open the link to copy the raw code.`,
            threadID
          );
        }

        // No link yet — upload to Pastebin now
        if (!cmd.code) {
          api.unsendMessage(loadMsg.messageID).catch(() => {});
          return api.sendMessage("❌ This command has no code stored.", threadID);
        }

        const rawUrl = await uploadToPastebin(cmd.code, cmd.name || `gs_${id}`);

        if (!rawUrl) {
          api.unsendMessage(loadMsg.messageID).catch(() => {});
          return api.sendMessage(
            `❌ Pastebin upload failed.\n` +
            `╭─‣ Check API key in CONFIG.PASTEBIN_API_KEY\n` +
            `╰────────────◊`,
            threadID
          );
        }

        // B6 fix: use MongoDB _id, not the user-supplied id arg (which may be a seq number)
        const cmdMongoId = cmd._id || cmd.id;
        await apiSetPastebin(cmdMongoId, rawUrl);

        api.unsendMessage(loadMsg.messageID).catch(() => {});
        return api.sendMessage(
          `✅ Raw Link Generated!\n` +
          `╭─‣ Name : ${cmd.name}\n` +
          `├‣ Author : ${cmd.author || "Unknown"}\n` +
          `├‣ Pastebin : ${rawUrl}\n` +
          `╰────────────◊\n` +
          `💾 Link saved to store for instant access next time.`,
          threadID
        );
      } catch (err) {
        api.unsendMessage(loadMsg.messageID).catch(() => {});
        return api.sendMessage(`❌ Error: ${err.message}`, threadID);
      }
    }

    // ── Delete (admin) ───────────────────────────────────
    if (sub === "delete") {
      const rawId = args[1];
      if (!rawId) return api.sendMessage(`❌ Usage: ${prefix}gs delete <id>`, threadID);
      const id = rawId.replace(/^#/, ""); // B9 fix: strip # prefix
      try {
        await apiDelete(id);
        return api.sendMessage(`🗑️ Deleted! ID: ${rawId}`, threadID);
      } catch (err) {
        const e = err.response?.data?.error || err.message;
        return api.sendMessage(`❌ Delete failed: ${e}`, threadID);
      }
    }

    // ── Author search ────────────────────────────────────
    if (sub === "author") {
      const authorName = args.slice(1).join(" ");
      if (!authorName) return api.sendMessage(`❌ Usage: ${prefix}gs author <name>`, threadID);
      return sendSearchPage(api, threadID, senderID, authorName, "", 1, 5, prefix);
    }

    // ── Category browse ──────────────────────────────────
    if (sub === "cat" || sub === "category") {
      const cat = args[1]?.toLowerCase();
      if (!CONFIG.CATEGORIES.includes(cat))
        return api.sendMessage(
          `❌ Usage: ${prefix}gs cat <${CONFIG.CATEGORIES.join("|")}>`,
          threadID
        );
      return sendListPage(api, threadID, senderID, cat, 1, 8, prefix);
    }

    // ── Browse by kind: events vs commands ────────────────
    if (sub === "events" || sub === "event") {
      const list = await apiSearch("", "", 0, "event").catch(() => []);
      if (!list.length) return api.sendMessage("❌ No events stored yet.", threadID);
      let msg = `⚡ Events (${list.length} total)\n\n`;
      list.slice(0, 10).forEach(cmd => { msg += renderCmdRow(cmd); });
      if (list.length > 10) msg += `…and ${list.length - 10} more. Use ${prefix}gs search <name> to find a specific one.`;
      return api.sendMessage(msg.trim(), threadID);
    }
    if (sub === "commands") {
      const list = await apiSearch("", "", 0, "command").catch(() => []);
      if (!list.length) return api.sendMessage("❌ No commands stored yet.", threadID);
      let msg = `🧩 Commands (${list.length} total)\n\n`;
      list.slice(0, 10).forEach(cmd => { msg += renderCmdRow(cmd); });
      if (list.length > 10) msg += `…and ${list.length - 10} more. Use ${prefix}gs search <name> to find a specific one.`;
      return api.sendMessage(msg.trim(), threadID);
    }

    // ── Details (Mongo ID or short #ID) ──────────────────
    // Typing just the number/ID shows details AND the raw link in one go —
    // generating the raw link on the spot if one isn't saved yet.
    const query = args.join(" ").trim();
    const looksLikeId = /^[a-f\d]{24}$/i.test(query) || /^#?\d+$/.test(query);
    if (looksLikeId) {
      try {
        const cmd = await apiGetOne(query.replace(/^#/, ""));
        if (!cmd) return api.sendMessage("❌ Command not found.", threadID);
        const cmdMongoId = cmd._id || cmd.id;

        let rawLine;
        if (cmd.pastebin_url) {
          rawLine = `🔗 Raw: ${cmd.pastebin_url}`;
        } else if (cmd.code) {
          const rawUrl = await uploadToPastebin(cmd.code, cmd.name || `gs_${cmdMongoId}`);
          if (rawUrl) {
            apiSetPastebin(cmdMongoId, rawUrl).catch(() => {});
            rawLine = `🔗 Raw: ${rawUrl}`;
          } else {
            rawLine = `⚠️ Raw link couldn't be generated right now — try ${prefix}gs rawlink ${displayId(cmd)} again shortly.`;
          }
        } else {
          rawLine = `⚠️ No code stored for this ${cmd.kind === "event" ? "event" : "command"} — nothing to link.`;
        }

        const msg =
          `${catBadge(cmd)}\n` +
          `╭─‣ Name : ${cmd.name}\n` +
          `├‣ Type : ${cmd.kind === "event" ? "⚡ Event" : "🧩 Command"}\n` +
          `├‣ Author : ${cmd.author || "Unknown"}\n` +
          `├‣ Category : ${catBadge(cmd)}\n` +
          `├‣ Likes : ❤️ ${cmd.likes || 0}\n` +
          `├‣ ID : ${displayId(cmd)}\n` +
          `╰────────────◊\n` +
          `📝 ${cmd.description || "No description"}\n` +
          `📅 Added: ${new Date(cmd.createdAt || Date.now()).toDateString()}\n` +
          rawLine;
        return api.sendMessage(msg.trim(), threadID);
      } catch (_) { return api.sendMessage("❌ Details fetch error.", threadID); }
    }

    // ── Universal search ─────────────────────────────────
    return sendSearchPage(api, threadID, senderID, query, "", 1, 5, prefix);
  },
};
