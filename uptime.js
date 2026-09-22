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
// Hacker-theme render helpers
// ─────────────────────────────────────────────
const GREEN = "#00ff41";
const GREEN_DIM = "#0a3d0a";
const GREEN_TEXT = "#c8ffc8";
const AMBER = "#ffb000";
const RED = "#ff003c";
const CYAN_GLITCH = "rgba(0,255,255,0.35)";
const RED_GLITCH = "rgba(255,0,60,0.4)";

function hackColor(pct) {
  if (pct < 50) return GREEN;
  if (pct < 75) return AMBER;
  return RED;
}

function glow(ctx, color, blur = 14) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
function noGlow(ctx) { ctx.shadowBlur = 0; }

function glitchText(ctx, text, x, y, font, align = "left", mainColor = GREEN_TEXT) {
  ctx.font = font; ctx.textAlign = align;
  ctx.fillStyle = RED_GLITCH; ctx.fillText(text, x - 2, y);
  ctx.fillStyle = CYAN_GLITCH; ctx.fillText(text, x + 2, y);
  glow(ctx, GREEN, 16);
  ctx.fillStyle = mainColor; ctx.fillText(text, x, y);
  noGlow(ctx);
}

function plainGlow(ctx, text, x, y, color, font, blur = 10, align = "left") {
  ctx.font = font; ctx.textAlign = align;
  glow(ctx, color, blur);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
  noGlow(ctx);
}

// Matrix digital-rain texture (static snapshot of falling-code streams)
function drawMatrixRain(ctx, W, H, seedDensity = 0.22) {
  const chars = "アイウエオカキクケコサシスセソ01アカサタナ0123456789$#%&";
  const fontSize = 14;
  const cols = Math.floor(W / fontSize);
  ctx.font = `${fontSize}px monospace`;
  ctx.textAlign = "left";
  for (let c = 0; c < cols; c++) {
    if (Math.random() > seedDensity) continue;
    const x = c * fontSize;
    const streamLen = 5 + Math.floor(Math.random() * 12);
    const startY = Math.random() * H;
    for (let i = 0; i < streamLen; i++) {
      const y = (startY + i * fontSize) % H;
      const alpha = Math.max(0, 1 - i / streamLen);
      ctx.fillStyle = i === 0 ? "rgba(210,255,210,0.85)" : `rgba(0,255,65,${alpha * 0.35})`;
      ctx.fillText(chars[Math.floor(Math.random() * chars.length)], x, y);
    }
  }
}

function drawScanlines(ctx, W, H) {
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  for (let y = 0; y < H; y += 3) ctx.fillRect(0, y, W, 1);
}

function drawVignette(ctx, W, H) {
  const v = ctx.createRadialGradient(W / 2, H / 2, H * 0.25, W / 2, H / 2, H * 0.85);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.55)");
  ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
}

// Sharp terminal box with corner ticks (no rounded corners — hacker HUD look)
function drawTermBox(ctx, x, y, w, h, accent = GREEN, alpha = 0.78) {
  ctx.fillStyle = `rgba(0,8,0,${alpha})`;
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = `rgba(0,255,65,0.25)`; ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

  const t = 9;
  ctx.strokeStyle = accent; ctx.lineWidth = 1.5;
  glow(ctx, accent, 6);
  ctx.beginPath();
  ctx.moveTo(x, y + t); ctx.lineTo(x, y); ctx.lineTo(x + t, y);
  ctx.moveTo(x + w - t, y); ctx.lineTo(x + w, y); ctx.lineTo(x + w, y + t);
  ctx.moveTo(x + w, y + h - t); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w - t, y + h);
  ctx.moveTo(x + t, y + h); ctx.lineTo(x, y + h); ctx.lineTo(x, y + h - t);
  ctx.stroke();
  noGlow(ctx);
}

// Segmented ASCII-style bar: [████████░░░░░░░░]
function drawSegBar(ctx, x, y, w, h, pct, color) {
  const segs = 34, gap = 2;
  const segW = (w - gap * (segs - 1)) / segs;
  const filled = Math.round((pct / 100) * segs);
  for (let i = 0; i < segs; i++) {
    const sx = x + i * (segW + gap);
    if (i < filled) {
      glow(ctx, color, 5);
      ctx.fillStyle = color;
      ctx.fillRect(sx, y, segW, h);
      noGlow(ctx);
    } else {
      ctx.strokeStyle = "rgba(0,255,65,0.18)"; ctx.lineWidth = 1;
      ctx.strokeRect(sx, y, segW, h);
    }
  }
}

// Per-core vertical bar cluster
function drawCoreBars(ctx, x, y, w, h, cores) {
  const maxShow = 8;
  let show = cores.slice(0, maxShow);
  if (cores.length > maxShow) {
    const rest = cores.slice(maxShow);
    show.push(rest.reduce((a, b) => a + b, 0) / rest.length);
  }
  const gap = 6;
  const bw = (w - gap * (show.length - 1)) / show.length;
  show.forEach((pct, i) => {
    const bx = x + i * (bw + gap);
    const bh = Math.max((pct / 100) * h, 3);
    const color = hackColor(pct);
    ctx.strokeStyle = "rgba(0,255,65,0.15)"; ctx.lineWidth = 1;
    ctx.strokeRect(bx, y, bw, h);
    glow(ctx, color, 6);
    ctx.fillStyle = color;
    ctx.fillRect(bx, y + h - bh, bw, bh);
    noGlow(ctx);
    ctx.fillStyle = "rgba(0,255,65,0.6)"; ctx.font = "9px monospace"; ctx.textAlign = "center";
    ctx.fillText(i < maxShow ? `C${i + 1}` : "AVG", bx + bw / 2, y + h + 12);
  });
}

function drawSparkline(ctx, x, y, w, h, history) {
  ctx.strokeStyle = "rgba(0,255,65,0.15)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke();
  if (!history || history.length < 2) {
    ctx.fillStyle = "rgba(0,255,65,0.5)"; ctx.font = "11px monospace"; ctx.textAlign = "left";
    ctx.fillText("> awaiting sufficient trend data...", x, y + h / 2);
    return;
  }
  const pts = history.slice(-15);
  const stepX = w / (pts.length - 1);
  const drawLine = (key, color) => {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const px = x + i * stepX;
      const py = y + h - (p[key] / 100) * h;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    });
    glow(ctx, color, 6); ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke(); noGlow(ctx);
  };
  drawLine("ram", GREEN);
  drawLine("cpu", RED);
}

// ─────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────
module.exports = {
  config: {
    name: "uptime",
    version: "7.0-HACKER",
    author: "HR ID OY",
    countDown: 5,
    role: 0,
    shortDescription: "💀 Hacker-Terminal Live System Monitor",
    category: "System",
    guide: "{pn}",
    dependencies: { canvas: "", "fs-extra": "" },
  },

  onStart: async function ({ api, event, message }) {
    const t0 = Date.now();
    try {
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const ramPct = Math.round((usedMem / totalMem) * 100);
      const ramUsed = (usedMem / 1073741824).toFixed(2);
      const ramFree = (freeMem / 1073741824).toFixed(2);
      const ramTotal = (totalMem / 1073741824).toFixed(2);

      const perCore = await sampleCpuUsage(220);
      const cpuPct = Math.round(perCore.reduce((a, b) => a + b, 0) / perCore.length);
      const cpuModel = os.cpus()[0].model.split("@")[0].trim().substring(0, 26);
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
        for (const k in os.networkInterfaces())
          os.networkInterfaces()[k].forEach((a) => { if (!a.internal && a.family === "IPv4") netIfaces++; });
      } catch {}
      const netSpeed = await testNetworkSpeed();

      const ping = Date.now() - t0;
      const pingColor = hackColor(ping < 80 ? 10 : ping < 200 ? 40 : ping < 500 ? 60 : 90);
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

      const W = 1080, H = 740;
      const cv = createCanvas(W, H);
      const ctx = cv.getContext("2d");

      // Base black background
      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#000000");
      bg.addColorStop(0.5, "#000f02");
      bg.addColorStop(1, "#000000");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

      // Matrix rain texture (behind everything)
      drawMatrixRain(ctx, W, H, 0.16);

      // Faint grid
      ctx.strokeStyle = "rgba(0,255,65,0.03)"; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      // Outer frame
      glow(ctx, GREEN, 26);
      ctx.strokeStyle = GREEN; ctx.lineWidth = 2;
      ctx.strokeRect(9, 9, W - 18, H - 18);
      noGlow(ctx);
      ctx.strokeStyle = "rgba(0,255,65,0.15)"; ctx.lineWidth = 1;
      ctx.strokeRect(15, 15, W - 30, H - 30);

      // Corner ticks
      const cDef = [[15, 15, 1, 1], [W - 15, 15, -1, 1], [15, H - 15, 1, -1], [W - 15, H - 15, -1, -1]];
      ctx.strokeStyle = GREEN; ctx.lineWidth = 2.5;
      glow(ctx, GREEN, 10);
      cDef.forEach(([cx, cy, sx, sy]) => {
        ctx.beginPath(); ctx.moveTo(cx, cy + sy * 34); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * 34, cy); ctx.stroke();
      });
      noGlow(ctx);

      // Boot-log strip along top
      ctx.font = "10px monospace"; ctx.fillStyle = "rgba(0,255,65,0.55)"; ctx.textAlign = "left";
      ctx.fillText(
        `SYS_BOOT::OK  AUTH::VERIFIED  ENCRYPTION::AES-256  FIREWALL::ACTIVE  THREAT_LEVEL::${ramPct > 85 || cpuPct > 85 ? "ELEVATED" : "LOW"}`,
        30, 34
      );

      // ════════════════════════════════
      // LEFT PANEL — user access card
      // ════════════════════════════════
      const LP = 20;
      drawTermBox(ctx, LP, LP + 20, 278, H - LP * 2 - 20, GREEN, 0.72);

      ctx.font = "10px monospace"; ctx.fillStyle = "rgba(0,255,65,0.7)"; ctx.textAlign = "left";
      ctx.fillText("> USER_PROFILE.DAT", LP + 14, LP + 40);

      const AX = LP + 139, AY = 148, AR = 68;
      try {
        const avu = `https://graph.facebook.com/${userID}/picture?width=512&height=512&access_token=6628568379%7Cc1e620fa708a1d5696fb991c1bde5662`;
        const av = await loadImage(avu);

        for (let ring = 3; ring >= 1; ring--) {
          ctx.strokeStyle = `rgba(0,255,65,${0.07 * ring})`;
          ctx.lineWidth = ring * 4;
          ctx.beginPath(); ctx.arc(AX, AY, AR + 8 + ring * 8, 0, Math.PI * 2); ctx.stroke();
        }
        glow(ctx, GREEN, 20);
        ctx.strokeStyle = GREEN; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(AX, AY, AR + 4, 0, Math.PI * 2); ctx.stroke();
        noGlow(ctx);

        ctx.save();
        ctx.beginPath(); ctx.arc(AX, AY, AR, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        ctx.drawImage(av, AX - AR, AY - AR, AR * 2, AR * 2);
        // green duotone overlay for hacker feel
        ctx.fillStyle = "rgba(0,255,65,0.16)";
        ctx.fillRect(AX - AR, AY - AR, AR * 2, AR * 2);
        ctx.restore();
      } catch {
        const initials = (userName || "U").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("");
        glow(ctx, GREEN, 20);
        ctx.strokeStyle = GREEN; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(AX, AY, AR + 4, 0, Math.PI * 2); ctx.stroke();
        noGlow(ctx);
        ctx.fillStyle = "rgba(0,255,65,0.15)";
        ctx.beginPath(); ctx.arc(AX, AY, AR, 0, Math.PI * 2); ctx.fill();
        plainGlow(ctx, initials || "?", AX, AY + 12, GREEN_TEXT, "bold 34px monospace", 10, "center");
      }

      plainGlow(ctx, userName, AX, AY + AR + 28, GREEN_TEXT, "bold 17px monospace", 8, "center");

      ctx.textAlign = "center";
      ctx.strokeStyle = GREEN; ctx.lineWidth = 1;
      ctx.strokeRect(AX - 90, AY + AR + 34, 180, 22);
      plainGlow(ctx, "[ ROOT ACCESS GRANTED ]", AX, AY + AR + 49, GREEN, "bold 10px monospace", 6, "center");

      glow(ctx, GREEN, 12);
      ctx.fillStyle = GREEN;
      ctx.beginPath(); ctx.arc(AX - 58, AY + AR + 72, 4, 0, Math.PI * 2); ctx.fill();
      noGlow(ctx);
      ctx.fillStyle = GREEN_TEXT; ctx.font = "11px monospace"; ctx.textAlign = "left";
      ctx.fillText("CONNECTION::SECURE", AX - 48, AY + AR + 76);

      const miniStats = [
        { label: "BOT_UPTIME", value: botUp },
        { label: "SYS_UPTIME", value: sysUp },
        { label: "NODE_VER", value: nodeVer },
        { label: "HOSTNAME", value: hostname },
        { label: "NET_IF", value: `${netIfaces}` },
        { label: "TOTAL_RUNS", value: `${stats.totalRuns}` },
      ];
      let mY = AY + AR + 96;
      for (const ms of miniStats) {
        ctx.strokeStyle = "rgba(0,255,65,0.18)"; ctx.lineWidth = 1;
        ctx.strokeRect(LP + 12, mY, 254, 40);
        ctx.fillStyle = "rgba(0,255,65,0.7)"; ctx.font = "10px monospace"; ctx.textAlign = "left";
        ctx.fillText(`> ${ms.label}`, LP + 22, mY + 16);
        ctx.fillStyle = GREEN_TEXT; ctx.font = "bold 13px monospace"; ctx.textAlign = "right";
        ctx.fillText(ms.value, LP + 258, mY + 32);
        mY += 46;
      }

      const devY = H - LP - 56;
      ctx.strokeStyle = GREEN; ctx.lineWidth = 1.5;
      glow(ctx, GREEN, 8);
      ctx.strokeRect(LP + 12, devY, 254, 46);
      noGlow(ctx);
      ctx.fillStyle = "rgba(0,255,65,0.6)"; ctx.font = "9px monospace"; ctx.textAlign = "center";
      ctx.fillText("[ SYSTEM_AUTHOR ]", AX, devY + 17);
      plainGlow(ctx, "HR_ID_OY", AX, devY + 36, GREEN, "bold 16px monospace", 10, "center");

      // ════════════════════════════════
      // RIGHT PANEL
      // ════════════════════════════════
      const RX = 318;
      const RW = W - RX - LP;

      glitchText(ctx, "root@sysmon:~# ./live_monitor.sh --scan", RX, 50, "bold 19px monospace");
      ctx.fillStyle = "rgba(0,255,65,0.55)"; ctx.font = "11px monospace"; ctx.textAlign = "left";
      ctx.fillText("[ ULTRA-ADVANCED INTRUSION-GRADE SYSTEM MONITOR ]", RX, 64);

      ctx.strokeStyle = "rgba(0,255,65,0.3)"; ctx.lineWidth = 1;
      ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(RX, 72); ctx.lineTo(W - LP, 72); ctx.stroke();
      ctx.setLineDash([]);

      const chips = [
        `[SESSION::${sessionID}]`,
        `[${dateStr}]`,
        `[${timeStr}]`,
      ];
      let chipX = RX;
      for (const label of chips) {
        ctx.font = "bold 11px monospace";
        const chipW = ctx.measureText(label).width + 20;
        ctx.strokeStyle = "rgba(0,255,65,0.4)"; ctx.lineWidth = 1;
        ctx.strokeRect(chipX, 80, chipW, 22);
        ctx.fillStyle = GREEN; ctx.textAlign = "left";
        ctx.fillText(label, chipX + 10, 95);
        chipX += chipW + 8;
      }

      const pingLabel = `[LATENCY::${ping}ms::${pingStatus}]`;
      ctx.font = "bold 11px monospace";
      const pingW = ctx.measureText(pingLabel).width + 20;
      glow(ctx, pingColor, 8);
      ctx.strokeStyle = pingColor; ctx.lineWidth = 1.5;
      ctx.strokeRect(W - LP - pingW, 80, pingW, 22);
      noGlow(ctx);
      ctx.fillStyle = pingColor; ctx.textAlign = "left";
      ctx.fillText(pingLabel, W - LP - pingW + 10, 95);

      const bars = [
        { label: "RAM_USAGE.SYS", sub: `├─ USED:${ramUsed}GB  ├─ FREE:${ramFree}GB  └─ TOTAL:${ramTotal}GB`, pct: ramPct },
        { label: "CPU_LOAD.SYS", sub: `├─ ${cpuModel}  ├─ CORES:${cores}  └─ LOAD:${load1}/${load5}/${load15}`, pct: cpuPct },
        { label: "DISK_USAGE.SYS", sub: `├─ USED:${disk.used}  ├─ FREE:${disk.free}  └─ TOTAL:${disk.total}`, pct: disk.pct },
      ];

      let bY = 116;
      for (const b of bars) {
        const color = hackColor(b.pct);
        drawTermBox(ctx, RX, bY, RW, 82, color);

        ctx.fillStyle = GREEN_TEXT; ctx.font = "bold 14px monospace"; ctx.textAlign = "left";
        ctx.fillText(`> ${b.label}`, RX + 14, bY + 22);

        const pctLabel = `${b.pct}%`;
        glow(ctx, color, 10);
        ctx.fillStyle = color; ctx.font = "bold 16px monospace"; ctx.textAlign = "right";
        ctx.fillText(pctLabel, RX + RW - 14, bY + 22);
        noGlow(ctx);

        drawSegBar(ctx, RX + 14, bY + 34, RW - 28, 18, b.pct, color);

        ctx.fillStyle = "rgba(0,255,65,0.5)"; ctx.font = "10px monospace"; ctx.textAlign = "left";
        ctx.fillText(b.sub, RX + 14, bY + 70);

        bY += 92;
      }

      const gridY = bY + 8;
      const gridInfos = [
        { label: "PLATFORM", value: `${platform}(${arch})` },
        { label: "LOAD_AVG", value: `${load1}/${load5}/${load15}` },
        { label: "THREADS", value: `${cores}` },
        { label: "CPU_MODEL", value: cpuModel },
        { label: "PROCESSES", value: `${processCount}` },
        { label: "GPU", value: gpuInfo },
      ];
      const gCols = 3;
      const gW = Math.floor(RW / gCols) - 6;
      gridInfos.forEach((inf, i) => {
        const col = i % gCols, row = Math.floor(i / gCols);
        const gx = RX + col * (gW + 9), gy = gridY + row * 58;
        drawTermBox(ctx, gx, gy, gW, 50, GREEN_DIM === GREEN ? GREEN : "#00aa2f");
        ctx.fillStyle = "rgba(0,255,65,0.65)"; ctx.font = "10px monospace"; ctx.textAlign = "left";
        ctx.fillText(`> ${inf.label}`, gx + 12, gy + 18);
        ctx.fillStyle = GREEN_TEXT; ctx.font = "bold 12px monospace"; ctx.textAlign = "right";
        ctx.fillText(String(inf.value).substring(0, 22), gx + gW - 10, gy + 38);
      });

      const coreY = gridY + 116 + 18;
      ctx.fillStyle = "rgba(0,255,65,0.7)"; ctx.font = "bold 11px monospace"; ctx.textAlign = "left";
      ctx.fillText("> PER_CORE_LOAD.MAP", RX, coreY);
      drawCoreBars(ctx, RX, coreY + 10, RW, 34, perCore);

      const sparkY = coreY + 68;
      ctx.fillStyle = "rgba(0,255,65,0.7)"; ctx.font = "bold 11px monospace"; ctx.textAlign = "left";
      ctx.fillText("> TREND_ANALYSIS.LOG (recent runs)", RX, sparkY);
      ctx.fillStyle = GREEN; ctx.font = "10px monospace"; ctx.textAlign = "right";
      ctx.fillText("■ RAM", RX + RW - 55, sparkY);
      ctx.fillStyle = RED;
      ctx.fillText("■ CPU", RX + RW - 10, sparkY);
      drawSparkline(ctx, RX, sparkY + 8, RW, 38, stats.history);

      const sbY = H - LP - 38;
      const sysOk = cpuPct < 80 && ramPct < 85 && ping < 400;
      const sbColor = sysOk ? GREEN : RED;
      const sbLabel = sysOk ? "[STATUS::ALL_SYSTEMS_NOMINAL]" : "[ALERT::HIGH_RESOURCE_USAGE]";

      ctx.strokeStyle = "rgba(0,255,65,0.25)"; ctx.lineWidth = 1;
      ctx.strokeRect(RX, sbY, RW, 30);
      ctx.fillStyle = "rgba(0,255,65,0.6)"; ctx.font = "10px monospace"; ctx.textAlign = "left";
      ctx.fillText(`v7.0-HACKER • HR_ID_OY • NODE_${nodeVer} • NET_${netSpeed}`, RX + 12, sbY + 19);
      glow(ctx, sbColor, sysOk ? 8 : 14);
      ctx.fillStyle = sbColor; ctx.font = "bold 11px monospace"; ctx.textAlign = "right";
      ctx.fillText(sbLabel, RX + RW - 12, sbY + 19);
      noGlow(ctx);

      // Binary/hex data stream footer
      ctx.font = "9px monospace"; ctx.fillStyle = "rgba(0,255,65,0.14)"; ctx.textAlign = "left";
      for (let i = 0; i < 14; i++) {
        const bin = Array.from({ length: 8 }, () => Math.round(Math.random())).join("");
        ctx.fillText(bin, LP + 20 + i * 74, H - 6);
      }

      // CRT overlay
      drawScanlines(ctx, W, H);
      drawVignette(ctx, W, H);

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
