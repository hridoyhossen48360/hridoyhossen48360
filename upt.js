const os = require("os");
const https = require("https");
const { execSync } = require("child_process");
const { createCanvas, loadImage } = require("canvas");
const fs = require("fs-extra");
const path = require("path");

const CACHE_PATH = path.join(__dirname, "cache");
const STATS_FILE = path.join(CACHE_PATH, "stats.json");

// ─────────────────────────────────────────────
// Data helpers (unchanged logic from v6)
// ─────────────────────────────────────────────
function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

function cpuSnapshot() {
  return os.cpus().map((c) => {
    let total = 0;
    for (const t in c.times) total += c.times[t];
    return { idle: c.times.idle, total };
  });
}
async function sampleCpuUsage(delay = 220) {
  const start = cpuSnapshot();
  await new Promise((r) => setTimeout(r, delay));
  const end = cpuSnapshot();
  return start.map((s, i) => {
    const idleDiff = end[i].idle - s.idle;
    const totalDiff = end[i].total - s.total;
    const usage = totalDiff > 0 ? (1 - idleDiff / totalDiff) * 100 : 0;
    return Math.min(Math.max(usage, 0), 100);
  });
}

function getDiskUsage() {
  try {
    if (os.platform() === "win32") {
      const out = execSync("wmic logicaldisk get size,freespace,caption").toString();
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean).slice(1);
      const drive = process.cwd().substring(0, 1).toUpperCase();
      for (const line of lines) {
        const parts = line.split(/\s+/);
        if (parts.length >= 3 && parts[0].toUpperCase().startsWith(drive)) {
          const free = parseInt(parts[1]), size = parseInt(parts[2]);
          const used = size - free;
          return {
            pct: Math.round((used / size) * 100),
            used: (used / 1073741824).toFixed(1) + "GB",
            free: (free / 1073741824).toFixed(1) + "GB",
            total: (size / 1073741824).toFixed(1) + "GB",
          };
        }
      }
      throw new Error("parse fail");
    } else {
      const df = execSync("df -k /").toString().split("\n")[1].split(/\s+/);
      const used = parseInt(df[2]), total = parseInt(df[1]), free = parseInt(df[3]);
      return {
        pct: Math.round((used / total) * 100),
        used: (used / 1048576).toFixed(1) + "GB",
        free: (free / 1048576).toFixed(1) + "GB",
        total: (total / 1048576).toFixed(1) + "GB",
      };
    }
  } catch {
    return { pct: 0, used: "N/A", free: "N/A", total: "N/A" };
  }
}

function getProcessCount() {
  try {
    if (os.platform() === "win32") return execSync("tasklist /NH").toString().trim().split("\n").length;
    return execSync("ps -e --no-headers 2>/dev/null || ps -A").toString().trim().split("\n").length;
  } catch {
    return "N/A";
  }
}

function getGpuInfo() {
  try {
    const out = execSync(
      "nvidia-smi --query-gpu=name,utilization.gpu --format=csv,noheader",
      { timeout: 1500 }
    ).toString().trim();
    if (!out) return "N/A";
    const [name, util] = out.split(",").map((s) => s.trim());
    return `${name.substring(0, 13)} ${util}`;
  } catch {
    return "N/A";
  }
}

function testNetworkSpeed() {
  return new Promise((resolve) => {
    const start = Date.now();
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      const req = https.get("https://www.google.com/favicon.ico", { timeout: 1800 }, (res) => {
        let bytes = 0;
        res.on("data", (d) => (bytes += d.length));
        res.on("end", () => {
          const dur = (Date.now() - start) / 1000;
          finish(dur > 0 ? `${(bytes / 1024 / dur).toFixed(1)}KB/s` : "N/A");
        });
        res.on("error", () => finish("N/A"));
      });
      req.on("timeout", () => { req.destroy(); finish("N/A"); });
      req.on("error", () => finish("N/A"));
    } catch {
      finish("N/A");
    }
  });
}

function loadStats() {
  try { return fs.readJsonSync(STATS_FILE); } catch { return { totalRuns: 0, history: [] }; }
}
function saveStats(stats) {
  try { fs.mkdirSync(CACHE_PATH, { recursive: true }); fs.writeJsonSync(STATS_FILE, stats); } catch {}
}

// ─────────────────────────────────────────────
// THEMES  (notun theme: ekta block copy kore 6-digit hex color bodlao)
// ─────────────────────────────────────────────
/* THEMES:START */
// up.js er shei ek-i 6ta color system (nam-o same: `up gold` / `upt gold`)
const THEMES = {
  matrix: {
    label: "Matrix Green", light: false,
    bg: ["#050a07", "#07140c"], orbs: ["#00ff41", "#00cc66", "#00ffaa"],
    panel: "#ffffff", panelA: 0.05, line: "#7dffb0",
    text: "#d6ffe4", dim: "#5fb783",
    a1: "#00ff41", a2: "#00d9ff", a3: "#d946ef",
    ok: "#00ff66", warn: "#ffd400", bad: "#ff3b3b"
  },
  cyberpunk: {
    label: "Cyberpunk Neon", light: false,
    bg: ["#0b0614", "#150a24"], orbs: ["#ff2bd6", "#00f0ff", "#fcee0a"],
    panel: "#ffffff", panelA: 0.055, line: "#ff7be9",
    text: "#f6e8ff", dim: "#9a7bb5",
    a1: "#ff2bd6", a2: "#00f0ff", a3: "#fcee0a",
    ok: "#39ff88", warn: "#fcee0a", bad: "#ff3355"
  },
  frost: {
    label: "Ice Frost", light: false,
    bg: ["#050b14", "#0a1a2c"], orbs: ["#4cc9ff", "#9ae6ff", "#7b8cff"],
    panel: "#ffffff", panelA: 0.055, line: "#bfeaff",
    text: "#eaf8ff", dim: "#6a96b3",
    a1: "#4cc9ff", a2: "#7b8cff", a3: "#b4f0ff",
    ok: "#5dffb0", warn: "#ffd166", bad: "#ff5c7a"
  },
  crimson: {
    label: "Crimson Blood", light: false,
    bg: ["#0a0405", "#1a0709"], orbs: ["#ff2a3d", "#ff7a45", "#ffb703"],
    panel: "#ffffff", panelA: 0.055, line: "#ff7b88",
    text: "#ffe9ea", dim: "#a85a60",
    a1: "#ff2a3d", a2: "#ff7a45", a3: "#ffb703",
    ok: "#3dff8a", warn: "#ffd24b", bad: "#ff2a3d"
  },
  aurora: {
    label: "Aurora Violet", light: false,
    bg: ["#07061a", "#0b1730"], orbs: ["#8b5cf6", "#2dd4bf", "#f472b6"],
    panel: "#ffffff", panelA: 0.055, line: "#c4b5fd",
    text: "#eef2ff", dim: "#7c86b8",
    a1: "#8b5cf6", a2: "#2dd4bf", a3: "#f472b6",
    ok: "#34d399", warn: "#fbbf24", bad: "#fb7185"
  },
  gold: {
    label: "Royal Gold", light: false,
    bg: ["#0a0803", "#17110a"], orbs: ["#ffc233", "#ffdf8a", "#ff9f1c"],
    panel: "#ffffff", panelA: 0.05, line: "#ffd77a",
    text: "#fff6dd", dim: "#a8924f",
    a1: "#ffc233", a2: "#ff9f1c", a3: "#fff2c4",
    ok: "#7dff9b", warn: "#ffc233", bad: "#ff4d4d"
  }
};
/* THEMES:END */

const THEME_KEYS = Object.keys(THEMES);
const DEFAULT_THEME = "random"; // "random" ba theme name (matrix, cyberpunk, frost, crimson, aurora, gold)
const SCALE = 2;                // 2 = sharp (retina) image; 1 = chhoto file

function pickTheme(arg) {
  const a = String(arg || "").toLowerCase();
  if (THEMES[a]) return a;
  const n = parseInt(a);
  if (n >= 1 && n <= THEME_KEYS.length) return THEME_KEYS[n - 1];
  if (THEMES[DEFAULT_THEME]) return DEFAULT_THEME;
  return THEME_KEYS[Math.floor(Math.random() * THEME_KEYS.length)];
}

// ─────────────────────────────────────────────
// DRAW  (pure canvas — no node deps)
// ─────────────────────────────────────────────
/* DRAW:START */
function drawMonitor(c, W, H, d, T, av) {
  const MONO = "monospace", SANS = "sans-serif";
  const fm = (px, b) => `${b ? "bold " : ""}${px}px ${MONO}`;
  const fsn = (px, b) => `${b ? "bold " : ""}${px}px ${SANS}`;
  const PI2 = Math.PI * 2;

  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  };
  const lerpHex = (a, b, t) => {
    const x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16);
    const ch = (s) => Math.round(((x >> s) & 255) + ((((y >> s) & 255) - ((x >> s) & 255)) * t));
    return "#" + ((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1);
  };
  const sample = (stops, t) => {
    const n = stops.length - 1, p = Math.min(Math.max(t, 0), 1) * n;
    const i = Math.min(Math.floor(p), n - 1);
    return lerpHex(stops[i], stops[i + 1] || stops[i], p - i);
  };
  const rr = (x, y, w, h, r) => {
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  };
  const glow = (col, b) => { c.shadowColor = col; c.shadowBlur = b; };
  const noGlow = () => { c.shadowBlur = 0; c.shadowColor = "transparent"; };
  const hgrad = (x0, x1, s0, s1) => {
    const g = c.createLinearGradient(x0, 0, x1, 0);
    g.addColorStop(0, s0); g.addColorStop(1, s1); return g;
  };
  const spaced = (text, x, y, sp, align = "left") => {
    const chars = [...text];
    const ws = chars.map((ch) => c.measureText(ch).width);
    const tot = ws.reduce((a, b) => a + b, 0) + sp * (chars.length - 1);
    let cx = align === "center" ? x - tot / 2 : align === "right" ? x - tot : x;
    c.textAlign = "left";
    chars.forEach((ch, i) => { c.fillText(ch, cx, y); cx += ws[i] + sp; });
  };
  const levelFx = (p) => (p >= 85 ? [T.bad, T.bad] : p >= 65 ? [T.warn, lerpHex(T.warn, T.bad, 0.4)] : null);
  const statusOf = (p) => (p >= 85 ? ["CRITICAL", T.bad] : p >= 65 ? ["ELEVATED", T.warn] : ["NORMAL", T.ok]);

  /* ---------- background ---------- */
  const bg = c.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, T.bg[0]); bg.addColorStop(1, T.bg[1]);
  c.fillStyle = bg; c.fillRect(0, 0, W, H);
  [[170, 130, 460, T.orbs[0], 0.24], [1040, 220, 520, T.orbs[1], 0.18], [700, H - 40, 560, T.orbs[2], 0.15]]
    .forEach(([ox, oy, or, col, a]) => {
      const g = c.createRadialGradient(ox, oy, 0, ox, oy, or);
      g.addColorStop(0, rgba(col, T.light ? a * 1.3 : a)); g.addColorStop(1, rgba(col, 0));
      c.fillStyle = g; c.fillRect(0, 0, W, H);
    });
  c.fillStyle = rgba(T.line, T.light ? 0.16 : 0.09);
  for (let x = 14; x < W; x += 28) for (let y = 14; y < H; y += 28) c.fillRect(x, y, 1.4, 1.4);

  /* ---------- glass card ---------- */
  const card = (x, y, w, h, r = 22, notch = true) => {
    if (T.light) {
      c.save(); c.shadowColor = "rgba(60,70,130,0.20)"; c.shadowBlur = 30; c.shadowOffsetY = 10;
      rr(x, y, w, h, r); c.fillStyle = rgba(T.panel, T.panelA); c.fill(); c.restore();
    }
    rr(x, y, w, h, r); c.fillStyle = rgba(T.panel, T.panelA); c.fill();
    const hg = c.createLinearGradient(0, y, 0, y + h);
    hg.addColorStop(0, rgba("#ffffff", T.light ? 0.45 : 0.07)); hg.addColorStop(1, rgba("#ffffff", 0));
    rr(x, y, w, h, r); c.fillStyle = hg; c.fill();
    rr(x + 0.5, y + 0.5, w - 1, h - 1, r); c.strokeStyle = rgba(T.line, T.light ? 0.3 : 0.17); c.lineWidth = 1; c.stroke();
    if (notch) { rr(x + 24, y - 1, 52, 3, 1.5); c.fillStyle = hgrad(x + 24, x + 76, T.a1, T.a2); c.fill(); }
  };
  const cardTitle = (t, x, y) => {
    c.fillStyle = hgrad(x, x + 10, T.a1, T.a2);
    c.beginPath(); c.arc(x + 4, y - 4, 4, 0, PI2); c.fill();
    c.font = fsn(12, true); c.fillStyle = T.dim; spaced(t, x + 16, y, 2);
  };
  const chip = (text, rightX, y, col, dot) => {
    c.font = fm(12, true);
    const w = c.measureText(text).width + (dot ? 44 : 28), x = rightX - w;
    rr(x, y, w, 28, 14); c.fillStyle = rgba(col, 0.12); c.fill();
    c.strokeStyle = rgba(col, 0.5); c.lineWidth = 1; c.stroke();
    if (dot) { glow(col, 8); c.fillStyle = col; c.beginPath(); c.arc(x + 16, y + 14, 4, 0, PI2); c.fill(); noGlow(); }
    c.textAlign = "left"; c.fillStyle = col; c.fillText(text, x + (dot ? 28 : 14), y + 19);
    return x;
  };

  /* ---------- gradient arc (conic look) ---------- */
  const arcGrad = (cx, cy, r, th, a0, a1, stops) => {
    const segs = Math.max(2, Math.ceil(((a1 - a0) / PI2) * 100));
    c.lineCap = "butt"; c.lineWidth = th;
    for (let i = 0; i < segs; i++) {
      c.strokeStyle = sample(stops, i / (segs - 1));
      c.beginPath();
      c.arc(cx, cy, r, a0 + ((a1 - a0) * i) / segs, a0 + ((a1 - a0) * (i + 1)) / segs + 0.012);
      c.stroke();
    }
  };
  const ring = (cx, cy, r, th, pct, c1, c2) => {
    const N = 48;
    for (let i = 0; i < N; i++) {
      const ang = -Math.PI / 2 + (i / N) * PI2, on = (i / N) * 100 < pct;
      const r0 = r + th / 2 + 8, r1 = r0 + (i % 4 === 0 ? 9 : 5);
      c.strokeStyle = on ? lerpHex(c1, c2, i / N) : rgba(T.text, 0.13);
      c.lineWidth = 2; c.lineCap = "round";
      c.beginPath(); c.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
      c.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1); c.stroke();
    }
    c.beginPath(); c.arc(cx, cy, r - th / 2 - 8, 0, PI2); c.fillStyle = rgba(T.text, 0.035); c.fill();
    c.lineCap = "round"; c.lineWidth = th; c.strokeStyle = rgba(T.text, T.light ? 0.09 : 0.075);
    c.beginPath(); c.arc(cx, cy, r, 0, PI2); c.stroke();
    const sweep = (Math.max(pct, 0.6) / 100) * PI2, a0 = -Math.PI / 2, a1 = a0 + sweep;
    c.save(); glow(c2, 22); c.strokeStyle = rgba(c2, 0.4); c.lineWidth = th * 0.6; c.lineCap = "butt";
    c.beginPath(); c.arc(cx, cy, r, a0, a1); c.stroke(); c.restore();
    arcGrad(cx, cy, r, th, a0, a1, [c1, c2]);
    c.fillStyle = c1; c.beginPath(); c.arc(cx, cy - r, th / 2, 0, PI2); c.fill();
    const ex = cx + Math.cos(a1) * r, ey = cy + Math.sin(a1) * r;
    c.fillStyle = c2; c.beginPath(); c.arc(ex, ey, th / 2, 0, PI2); c.fill();
    glow("#ffffff", 10); c.fillStyle = "#ffffff"; c.beginPath(); c.arc(ex, ey, th * 0.2, 0, PI2); c.fill(); noGlow();
    c.lineCap = "butt";
  };

  /* ---------- HEADER ---------- */
  card(30, 24, 1140, 64, 32, false);
  const hx = 70, hy = 56;
  c.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const px = hx + Math.cos(a) * 21, py = hy + Math.sin(a) * 21;
    i ? c.lineTo(px, py) : c.moveTo(px, py);
  }
  c.closePath(); glow(T.a1, 14); c.strokeStyle = hgrad(hx - 21, hx + 21, T.a1, T.a2); c.lineWidth = 3; c.stroke(); noGlow();
  c.strokeStyle = T.a1; c.lineWidth = 2; c.lineJoin = "round"; c.beginPath();
  [[-10, 2], [-4, 2], [-1, -8], [3, 10], [6, 0], [11, 0]].forEach(([px, py], i) => (i ? c.lineTo(hx + px, hy + py) : c.moveTo(hx + px, hy + py)));
  c.stroke(); c.lineJoin = "miter";
  c.font = fsn(22, true); c.fillStyle = T.text; spaced("LIVE SYSTEM MONITOR", 106, 50, 3);
  c.font = fm(11); c.fillStyle = T.dim; c.textAlign = "left"; c.fillText("root@sysmon:~# ./live_monitor.sh --scan", 106, 71);

  let pingCol = d.ping < 80 ? T.ok : d.ping < 200 ? T.ok : d.ping < 500 ? T.warn : T.bad;
  let rx0 = 1156;
  rx0 = chip(`LATENCY ${d.ping}ms · ${d.pingStatus}`, rx0, 42, pingCol, true) - 8;
  rx0 = chip(d.timeStr, rx0, 42, T.text, false) - 8;
  rx0 = chip(d.dateStr, rx0, 42, T.text, false) - 8;
  chip(`SESSION ${d.sessionID}`, rx0, 42, T.dim, false);

  /* ---------- LEFT: PROFILE ---------- */
  const PX = 30, PY = 108, PW = 300, PH = 742;
  card(PX, PY, PW, PH);
  cardTitle("USER PROFILE", PX + 24, PY + 36);
  const AX = PX + PW / 2, AY = PY + 140, AR = 66;
  c.strokeStyle = rgba(T.text, 0.1); c.lineWidth = 1;
  c.setLineDash([2, 6]); c.beginPath(); c.arc(AX, AY, AR + 30, 0, PI2); c.stroke(); c.setLineDash([]);
  c.save(); glow(T.a2, 26); c.strokeStyle = rgba(T.a2, 0.35); c.lineWidth = 4;
  c.beginPath(); c.arc(AX, AY, AR + 12, 0, PI2); c.stroke(); c.restore();
  arcGrad(AX, AY, AR + 12, 6, -Math.PI / 2, Math.PI * 1.5, [T.a1, T.a2, T.a3, T.a1]);
  c.save(); c.beginPath(); c.arc(AX, AY, AR, 0, PI2); c.clip();
  if (av) {
    c.drawImage(av, AX - AR, AY - AR, AR * 2, AR * 2);
    c.fillStyle = rgba(T.a1, 0.08); c.fillRect(AX - AR, AY - AR, AR * 2, AR * 2);
  } else {
    const ig = c.createLinearGradient(AX - AR, AY - AR, AX + AR, AY + AR);
    ig.addColorStop(0, rgba(T.a1, 0.35)); ig.addColorStop(1, rgba(T.a2, 0.35));
    c.fillStyle = ig; c.fillRect(AX - AR, AY - AR, AR * 2, AR * 2);
  }
  c.restore();
  if (!av) {
    const ini = (d.userName || "U").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("") || "?";
    c.font = fsn(44, true); c.fillStyle = T.text; c.textAlign = "center"; c.fillText(ini, AX, AY + 15);
  }
  c.textAlign = "center"; c.font = fsn(20, true); c.fillStyle = T.text; c.fillText(d.userName, AX, AY + AR + 50);
  const role = "ROOT ACCESS GRANTED";
  c.font = fsn(11, true);
  rr(AX - 100, AY + AR + 64, 200, 28, 14); c.fillStyle = rgba(T.a1, 0.12); c.fill();
  c.strokeStyle = hgrad(AX - 100, AX + 100, T.a1, T.a2); c.lineWidth = 1.5; c.stroke();
  c.fillStyle = T.a1; spaced(role, AX, AY + AR + 83, 1.5, "center");
  glow(T.ok, 10); c.fillStyle = T.ok; c.beginPath(); c.arc(AX - 62, AY + AR + 116, 4, 0, PI2); c.fill(); noGlow();
  c.font = fm(11); c.fillStyle = T.dim; c.textAlign = "left"; c.fillText("CONNECTION::SECURE", AX - 50, AY + AR + 120);

  const mini = [
    ["BOT UPTIME", d.botUp], ["SYS UPTIME", d.sysUp], ["NODE VER", d.nodeVer],
    ["HOSTNAME", d.hostname], ["NET IFACES", `${d.netIfaces}`], ["TOTAL RUNS", `${d.stats.totalRuns}`]
  ];
  let my = AY + AR + 144;
  mini.forEach(([k, v]) => {
    rr(PX + 20, my, PW - 40, 42, 12); c.fillStyle = rgba(T.text, T.light ? 0.05 : 0.04); c.fill();
    c.fillStyle = hgrad(PX + 20, PX + 24, T.a1, T.a2); rr(PX + 20, my + 11, 3, 20, 1.5); c.fill();
    c.font = fsn(11, true); c.fillStyle = T.dim; spaced(k, PX + 36, my + 26, 1.2);
    c.font = fm(14, true); c.fillStyle = T.text; c.textAlign = "right"; c.fillText(String(v), PX + PW - 34, my + 26);
    my += 49;
  });
  const ay = PY + PH - 84;
  rr(PX + 20, ay, PW - 40, 64, 16); c.fillStyle = rgba(T.a2, 0.1); c.fill();
  glow(T.a2, 10); c.strokeStyle = hgrad(PX + 20, PX + PW - 20, T.a1, T.a3); c.lineWidth = 1.5; c.stroke(); noGlow();
  c.font = fsn(10, true); c.fillStyle = T.dim; spaced("SYSTEM AUTHOR", AX, ay + 24, 3, "center");
  c.font = fsn(21, true); c.fillStyle = hgrad(AX - 60, AX + 60, T.a1, T.a3); spaced("HR_ID_OY", AX, ay + 50, 3, "center");

  /* ---------- RIGHT: GAUGES ---------- */
  const RX = 360, RW = 810, GW = 258, GAP = 18;
  const gauge = (i, name, short, pct, stops, l1, l2) => {
    const x = RX + i * (GW + GAP), y = 108, h = 280;
    card(x, y, GW, h); cardTitle(name, x + 24, y + 36);
    const [sw, sc] = statusOf(pct);
    c.font = fsn(10, true); c.fillStyle = sc; spaced(sw, x + GW - 24, y + 36, 1.5, "right");
    const cx = x + GW / 2, cy = y + 136, col = levelFx(pct) || stops;
    ring(cx, cy, 60, 16, pct, col[0], col[1]);
    c.font = fsn(38, true); const nw = c.measureText(String(pct)).width;
    c.fillStyle = T.text; c.textAlign = "center"; c.fillText(String(pct), cx - 8, cy + 11);
    c.font = fsn(15, true); c.fillStyle = T.dim; c.textAlign = "left"; c.fillText("%", cx - 8 + nw / 2 + 2, cy + 11);
    c.font = fsn(10, true); c.fillStyle = T.dim; spaced(short, cx, cy + 32, 3, "center");
    c.font = fm(12); c.fillStyle = T.dim; c.textAlign = "center";
    c.fillText(l1, cx, y + h - 34); c.fillText(l2, cx, y + h - 16);
  };
  gauge(0, "CPU LOAD", "PROCESSOR", d.cpuPct, [T.a1, T.a2], d.cpuModel.substring(0, 26), `${d.cores} CORES · ${d.load1}/${d.load5}/${d.load15}`);
  gauge(1, "RAM USAGE", "MEMORY", d.ramPct, [T.a2, T.a3], `USED ${d.ramUsed}GB · FREE ${d.ramFree}GB`, `TOTAL ${d.ramTotal}GB`);
  gauge(2, "DISK USAGE", "STORAGE", d.disk.pct, [T.a3, T.a1], `USED ${d.disk.used} · FREE ${d.disk.free}`, `TOTAL ${d.disk.total}`);

  /* ---------- PER-CORE ---------- */
  {
    const x = RX, y = 406, h = 128;
    card(x, y, RW, h); cardTitle("PER-CORE LOAD MAP", x + 24, y + 36);
    const list = d.perCore.slice(0, 8).map((p) => p);
    if (d.perCore.length > 8) { const rest = d.perCore.slice(8); list.push(rest.reduce((a, b) => a + b, 0) / rest.length); }
    const avg = Math.round(d.perCore.reduce((a, b) => a + b, 0) / d.perCore.length);
    c.font = fsn(11, true); c.fillStyle = T.dim; spaced(`AVG ${avg}%`, x + RW - 24, y + 36, 1.5, "right");
    const n = list.length, gp = 10, cw = (RW - 48 - gp * (n - 1)) / n, by = y + 52, bh = 46;
    list.forEach((p, i) => {
      const bx = x + 24 + i * (cw + gp), pc = Math.round(p);
      const col = levelFx(pc) || [T.a1, T.a2];
      rr(bx, by, cw, bh, 11); c.fillStyle = rgba(T.text, T.light ? 0.07 : 0.06); c.fill();
      c.save(); rr(bx, by, cw, bh, 11); c.clip();
      const lvl = Math.max((pc / 100) * bh, 4);
      const vg = c.createLinearGradient(0, by + bh - lvl, 0, by + bh);
      vg.addColorStop(0, col[1]); vg.addColorStop(1, rgba(col[0], 0.55));
      c.fillStyle = vg; c.fillRect(bx, by + bh - lvl, cw, lvl);
      c.fillStyle = "rgba(255,255,255,0.28)"; c.fillRect(bx, by + bh - lvl, cw, 2);
      c.restore();
      rr(bx + 0.5, by + 0.5, cw - 1, bh - 1, 11); c.strokeStyle = rgba(col[0], 0.5); c.lineWidth = 1; c.stroke();
      c.font = fm(13, true); c.fillStyle = T.text; c.textAlign = "center"; c.fillText(`${pc}%`, bx + cw / 2, by + bh / 2 + 5);
      c.font = fsn(10, true); c.fillStyle = T.dim; c.fillText(i < 8 ? `C${i + 1}` : "AVG+", bx + cw / 2, by + bh + 17);
    });
  }

  /* ---------- INFO TILES ---------- */
  const tiles = [
    ["PLATFORM", `${d.platform} (${d.arch})`], ["LOAD AVG", `${d.load1}/${d.load5}/${d.load15}`], ["THREADS", `${d.cores}`],
    ["CPU MODEL", d.cpuModel], ["PROCESSES", `${d.processCount}`], ["GPU", d.gpuInfo]
  ];
  tiles.forEach(([k, v], i) => {
    const x = RX + (i % 3) * (GW + GAP), y = 552 + Math.floor(i / 3) * 60;
    card(x, y, GW, 50, 16, false);
    c.fillStyle = hgrad(x + 14, x + 17, T.a1, T.a2); rr(x + 14, y + 11, 3, 28, 1.5); c.fill();
    c.font = fsn(10, true); c.fillStyle = T.dim; spaced(k, x + 28, y + 21, 1.8);
    c.font = fm(14, true); c.fillStyle = T.text; c.textAlign = "left"; c.fillText(String(v).substring(0, 24), x + 28, y + 40);
  });

  /* ---------- TREND ---------- */
  {
    const x = RX, y = 680, h = 120;
    card(x, y, RW, h); cardTitle("TREND ANALYSIS · RECENT RUNS", x + 24, y + 36);
    c.font = fsn(10, true); c.textAlign = "left";
    c.fillStyle = T.a1; c.beginPath(); c.arc(x + RW - 130, y + 32, 4, 0, PI2); c.fill();
    c.fillStyle = T.dim; spaced("RAM", x + RW - 120, y + 36, 1.5);
    c.fillStyle = T.a3; c.beginPath(); c.arc(x + RW - 70, y + 32, 4, 0, PI2); c.fill();
    c.fillStyle = T.dim; spaced("CPU", x + RW - 60, y + 36, 1.5);
    const gx = x + 24, gy = y + 52, gw = RW - 48, gh = h - 52 - 16;
    c.strokeStyle = rgba(T.text, 0.09); c.lineWidth = 1; c.setLineDash([3, 5]);
    [0, 0.5, 1].forEach((t) => { c.beginPath(); c.moveTo(gx, gy + gh * t); c.lineTo(gx + gw, gy + gh * t); c.stroke(); });
    c.setLineDash([]);
    const hist = d.stats.history;
    if (!hist || hist.length < 2) {
      c.font = fm(12); c.fillStyle = T.dim; c.textAlign = "left"; c.fillText("> awaiting sufficient trend data...", gx + 8, gy + gh / 2 + 4);
    } else {
      const pts = hist.slice(-15), step = gw / (pts.length - 1);
      const series = (key, c1, c2) => {
        const co = pts.map((p, i) => [gx + i * step, gy + gh - (Math.min(p[key], 100) / 100) * gh]);
        const path = () => {
          c.beginPath(); c.moveTo(co[0][0], co[0][1]);
          for (let i = 1; i < co.length; i++) {
            const mx = (co[i - 1][0] + co[i][0]) / 2, my2 = (co[i - 1][1] + co[i][1]) / 2;
            c.quadraticCurveTo(co[i - 1][0], co[i - 1][1], mx, my2);
          }
          c.lineTo(co[co.length - 1][0], co[co.length - 1][1]);
        };
        path(); c.lineTo(co[co.length - 1][0], gy + gh); c.lineTo(co[0][0], gy + gh); c.closePath();
        const fg = c.createLinearGradient(0, gy, 0, gy + gh);
        fg.addColorStop(0, rgba(c1, 0.3)); fg.addColorStop(1, rgba(c1, 0));
        c.fillStyle = fg; c.fill();
        path(); glow(c1, 8); c.strokeStyle = hgrad(gx, gx + gw, c1, c2); c.lineWidth = 2.5; c.lineJoin = "round"; c.stroke(); noGlow();
        const [lx, ly] = co[co.length - 1];
        glow(c2, 12); c.fillStyle = c2; c.beginPath(); c.arc(lx, ly, 5, 0, PI2); c.fill(); noGlow();
        c.fillStyle = "#ffffff"; c.beginPath(); c.arc(lx, ly, 2, 0, PI2); c.fill();
      };
      series("ram", T.a1, T.a2);
      series("cpu", T.a3, lerpHex(T.a3, T.warn, 0.5));
    }
  }

  /* ---------- FOOTER ---------- */
  card(RX, 818, RW, 32, 16, false);
  c.font = fm(11); c.fillStyle = T.dim; c.textAlign = "left";
  c.fillText(`v8.0-HUD  •  HR_ID_OY  •  NODE_${d.nodeVer}  •  NET_${d.netSpeed}`, RX + 18, 838);
  const sbCol = d.sysOk ? T.ok : T.bad;
  chip(d.sysOk ? "ALL SYSTEMS NOMINAL" : "HIGH RESOURCE USAGE", RX + RW - 6, 820, sbCol, true);
}
/* DRAW:END */

// ─────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────
module.exports = {
  config: {
    name: "upt",
    version: "2.0.0",
    author: "HR ID OY",
    countDown: 5,
    role: 0,
    shortDescription: "Live system monitor dashboard (multi-theme)",
    category: "System",
    guide: "{pn} [theme | list]\nThemes: " + THEME_KEYS.join(", "),
    dependencies: { canvas: "", "fs-extra": "" },
  },

  onStart: async function ({ api, event, message, args = [] }) {
    const t0 = Date.now();
    try {
      if ((args[0] || "").toLowerCase() === "list") {
        const list = THEME_KEYS.map((k, i) => `${i + 1}. ${k} — ${THEMES[k].label}`).join("\n");
        return message.reply(`🎨 Available themes:\n${list}\n\nUse: upt <name | number>`);
      }
      const themeKey = pickTheme(args[0]);

      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const ramPct = Math.round((usedMem / totalMem) * 100);
      const ramUsed = (usedMem / 1073741824).toFixed(2);
      const ramFree = (freeMem / 1073741824).toFixed(2);
      const ramTotal = (totalMem / 1073741824).toFixed(2);

      const perCore = await sampleCpuUsage(220);
      const cpuPct = Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length);
      const cpuModel = os.cpus()[0].model.split("@")[0].replace(/\((R|TM|tm)\)/g, "").replace(/\s+/g, " ").trim().substring(0, 26);
      const cores = os.cpus().length;
      const load1 = os.loadavg()[0].toFixed(2);
      const load5 = os.loadavg()[1].toFixed(2);
      const load15 = os.loadavg()[2].toFixed(2);

      const platform = os.platform();
      const arch = os.arch();
      const hostname = os.hostname().substring(0, 20);
      const nodeVer = process.version;
      const botUp = formatUptime(process.uptime());
      const sysUp = formatUptime(os.uptime());
      const processCount = getProcessCount();
      const gpuInfo = getGpuInfo();
      const disk = getDiskUsage();

      let netIfaces = 0;
      try {
        const ifs = os.networkInterfaces();
        for (const k in ifs) ifs[k].forEach((a) => { if (!a.internal && a.family === "IPv4") netIfaces++; });
      } catch {}
      const netSpeed = await testNetworkSpeed();

      const ping = Date.now() - t0;
      const pingStatus = ping < 80 ? "OPTIMAL" : ping < 200 ? "STABLE" : ping < 500 ? "LAGGING" : "CRITICAL";

      const stats = loadStats();
      stats.totalRuns = (stats.totalRuns || 0) + 1;
      stats.history = [...(stats.history || []), { cpu: cpuPct, ram: ramPct }].slice(-15);
      saveStats(stats);

      let userName = "UNKNOWN", userID = event.senderID;
      try {
        const info = await api.getUserInfo(userID);
        userName = (info[userID]?.name || "UNKNOWN").toUpperCase();
        if (userName.length > 18) userName = userName.substring(0, 17) + "…";
      } catch {}

      const now = new Date();
      const dateStr = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
      const timeStr = now.toLocaleTimeString("en-GB", { hour12: false });
      const sessionID = Date.now().toString(16).toUpperCase().substring(0, 10);

      let av = null;
      try {
        av = await loadImage(`https://graph.facebook.com/${userID}/picture?width=512&height=512&access_token=6628568379%7Cc1e620fa708a1d5696fb991c1bde5662`);
      } catch {}

      const data = {
        ramPct, ramUsed, ramFree, ramTotal, cpuPct, cpuModel, cores, load1, load5, load15, perCore,
        disk, platform, arch, hostname, nodeVer, botUp, sysUp, processCount, gpuInfo, netIfaces, netSpeed,
        ping, pingStatus, stats, userName, dateStr, timeStr, sessionID,
        sysOk: cpuPct < 80 && ramPct < 85 && ping < 400,
      };

      const W = 1200, H = 880;
      const cv = createCanvas(W * SCALE, H * SCALE);
      const ctx = cv.getContext("2d");
      ctx.scale(SCALE, SCALE);
      drawMonitor(ctx, W, H, data, THEMES[themeKey], av);

      fs.mkdirSync(CACHE_PATH, { recursive: true });
      const outPath = path.join(CACHE_PATH, `upt_${userID}_${Date.now()}.png`);
      await fs.writeFile(outPath, cv.toBuffer("image/png"));
      await message.reply({ attachment: fs.createReadStream(outPath) });
      setTimeout(() => fs.unlink(outPath).catch(() => {}), 15000);
    } catch (err) {
      console.error("Uptime Error:", err);
      return message.reply("❌ Dashboard error: " + err.message);
    }
  },
};
