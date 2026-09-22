const os = require("os");
const https = require("https");
const { execSync } = require("child_process");
const { createCanvas, loadImage } = require("canvas");
const fs = require("fs-extra");
const path = require("path");

const CACHE_PATH = path.join(__dirname, "cache");
const STATS_FILE = path.join(CACHE_PATH, "stats.json");

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function roundRect(ctx, x, y, w, h, r) {
  if (w < 2 * r) r = w / 2;
  if (h < 2 * r) r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function formatUptime(s) {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

// Accurate CPU usage via delta-sampling (single-snapshot method is misleading —
// os.cpus() returns cumulative time since boot, not "current" load).
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
    if (os.platform() === "win32") {
      return execSync("tasklist /NH").toString().trim().split("\n").length;
    }
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
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    try {
      const req = https.get("https://www.google.com/favicon.ico", { timeout: 1800 }, (res) => {
        let bytes = 0;
        res.on("data", (d) => (bytes += d.length));
        res.on("end", () => {
          const dur = (Date.now() - start) / 1000;
          finish(dur > 0 ? `${(bytes / 1024 / dur).toFixed(1)} KB/s` : "N/A");
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
  try {
    return fs.readJsonSync(STATS_FILE);
  } catch {
    return { totalRuns: 0, history: [] };
  }
}
function saveStats(stats) {
  try {
    fs.mkdirSync(CACHE_PATH, { recursive: true });
    fs.writeJsonSync(STATS_FILE, stats);
  } catch {}
}

function barColor(pct) {
  if (pct < 50) return ["#00ff9d", "#00cc7a", "rgba(0,255,157,0.15)"];
  if (pct < 75) return ["#ffdd00", "#ff9900", "rgba(255,200,0,0.15)"];
  return ["#ff4466", "#cc1133", "rgba(255,50,80,0.15)"];
}

function glow(ctx, color, blur = 16) { ctx.shadowColor = color; ctx.shadowBlur = blur; }
function noGlow(ctx) { ctx.shadowBlur = 0; }

function drawProgressBar(ctx, x, y, w, h, pct, colors) {
  ctx.fillStyle = "rgba(255,255,255,0.05)";
  roundRect(ctx, x, y, w, h, h / 2); ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.08)"; ctx.lineWidth = 1;
  roundRect(ctx, x, y, w, h, h / 2); ctx.stroke();

  const fw = Math.max((pct / 100) * w, h);
  const g = ctx.createLinearGradient(x, 0, x + fw, 0);
  g.addColorStop(0, colors[0]);
  g.addColorStop(1, colors[1]);
  glow(ctx, colors[0], 10);
  ctx.fillStyle = g;
  roundRect(ctx, x, y, fw, h, h / 2); ctx.fill();
  noGlow(ctx);

  ctx.fillStyle = "rgba(255,255,255,0.1)";
  roundRect(ctx, x + 2, y + 2, fw - 4, h / 2 - 2, h / 2); ctx.fill();

  ctx.strokeStyle = "rgba(0,0,0,0.2)"; ctx.lineWidth = 1;
  for (let i = 1; i < 10; i++) {
    const tx = x + (w / 10) * i;
    if (tx < x + fw) {
      ctx.beginPath(); ctx.moveTo(tx, y + 2); ctx.lineTo(tx, y + h - 2); ctx.stroke();
    }
  }
}

function drawCard(ctx, x, y, w, h, r = 14, alpha = 0.75) {
  ctx.fillStyle = `rgba(6, 12, 26, ${alpha})`;
  roundRect(ctx, x, y, w, h, r); ctx.fill();
  const border = ctx.createLinearGradient(x, y, x + w, y + h);
  border.addColorStop(0, "rgba(0,229,255,0.25)");
  border.addColorStop(1, "rgba(0,100,255,0.10)");
  ctx.strokeStyle = border; ctx.lineWidth = 1.2;
  roundRect(ctx, x, y, w, h, r); ctx.stroke();
}

function drawAccent(ctx, x, y, h, color = "#00e5ff") {
  const g = ctx.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, color);
  g.addColorStop(0.5, color);
  g.addColorStop(1, "transparent");
  ctx.fillStyle = g;
  roundRect(ctx, x, y, 4, h, 2); ctx.fill();
}

function glowText(ctx, text, x, y, color, font, blur = 14, align = "left") {
  ctx.font = font; ctx.textAlign = align;
  glow(ctx, color, blur);
  ctx.fillStyle = color; ctx.fillText(text, x, y);
  noGlow(ctx);
}

function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r},${g},${b}`;
}

// Per-core mini equalizer bars
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
    const [c1, c2] = barColor(pct);
    ctx.fillStyle = "rgba(255,255,255,0.05)";
    roundRect(ctx, bx, y, bw, h, 4); ctx.fill();
    const g = ctx.createLinearGradient(0, y + h, 0, y + h - bh);
    g.addColorStop(0, c2); g.addColorStop(1, c1);
    ctx.fillStyle = g;
    roundRect(ctx, bx, y + h - bh, bw, bh, 4); ctx.fill();
    ctx.fillStyle = "rgba(200,230,255,0.6)"; ctx.font = "9px Arial"; ctx.textAlign = "center";
    ctx.fillText(i < maxShow ? `C${i + 1}` : "AVG", bx + bw / 2, y + h + 12);
  });
}

// CPU/RAM trend sparkline built from persisted run history
function drawSparkline(ctx, x, y, w, h, history) {
  ctx.strokeStyle = "rgba(255,255,255,0.06)"; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.stroke();

  if (!history || history.length < 2) {
    ctx.fillStyle = "rgba(180,220,255,0.4)"; ctx.font = "11px Arial"; ctx.textAlign = "left";
    ctx.fillText("Collecting trend data...", x, y + h / 2);
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
    glow(ctx, color, 6);
    ctx.strokeStyle = color; ctx.lineWidth = 2;
    ctx.stroke();
    noGlow(ctx);
  };
  drawLine("ram", "#00aaff");
  drawLine("cpu", "#ff9d00");
}

// ─────────────────────────────────────────────
// Command
// ─────────────────────────────────────────────
module.exports = {
  config: {
    name: "uptime",
    aliases: ["up", "status", "upt", "sys"],
    version: "6.0",
    author: "HR ID OY",
    countDown: 5,
    role: 0,
    shortDescription: "⚡ Ultra Advanced Live System Dashboard",
    category: "System",
    guide: "{pn}",
    dependencies: { canvas: "", "fs-extra": "" },
  },

  onStart: async function ({ api, event, message }) {
    const t0 = Date.now();

    try {
      // ── Live system stats ──
      const totalMem = os.totalmem();
      const freeMem = os.freemem();
      const usedMem = totalMem - freeMem;
      const ramPct = Math.round((usedMem / totalMem) * 100);
      const ramUsed = (usedMem / 1073741824).toFixed(2);
      const ramFree = (freeMem / 1073741824).toFixed(2);
      const ramTotal = (totalMem / 1073741824).toFixed(2);

      // Accurate delta-sampled CPU usage (also gives per-core numbers)
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

      // Disk (cross-platform)
      const disk = getDiskUsage();

      // Network interfaces + live speed test (bounded by timeout, never blocks long)
      let netIfaces = 0;
      try {
        for (const k in os.networkInterfaces())
          os.networkInterfaces()[k].forEach((a) => { if (!a.internal && a.family === "IPv4") netIfaces++; });
      } catch {}
      const netSpeed = await testNetworkSpeed();

      // Ping
      const ping = Date.now() - t0;
      const pingColor = ping < 80 ? "#00ff9d" : ping < 200 ? "#aaff00" : ping < 500 ? "#ffdd00" : "#ff4466";
      const pingStatus = ping < 80 ? "PERFECT" : ping < 200 ? "EXCELLENT" : ping < 500 ? "GOOD" : "POOR";

      // Persistent usage stats (total runs + CPU/RAM history for the sparkline)
      const stats = loadStats();
      stats.totalRuns = (stats.totalRuns || 0) + 1;
      stats.history = [...(stats.history || []), { cpu: cpuPct, ram: ramPct }].slice(-15);
      saveStats(stats);

      // User
      let userName = "User", userID = event.senderID;
      try {
        const info = await api.getUserInfo(userID);
        userName = info[userID]?.name || "User";
        if (userName.length > 16) userName = userName.substring(0, 15) + "…";
      } catch {}

      // Time
      const now = new Date();
      const dateStr = now.toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });
      const timeStr = now.toLocaleTimeString("en-GB", { hour12: false });
      const sessionID = Date.now().toString(16).toUpperCase().substring(0, 10);

      // ── Canvas 1080 x 740 ──
      const W = 1080, H = 740;
      const cv = createCanvas(W, H);
      const ctx = cv.getContext("2d");

      const bg = ctx.createLinearGradient(0, 0, W, H);
      bg.addColorStop(0, "#020812");
      bg.addColorStop(0.4, "#050d1e");
      bg.addColorStop(0.7, "#040b1a");
      bg.addColorStop(1, "#030910");
      ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);

      const amb1 = ctx.createRadialGradient(160, 320, 0, 160, 320, 320);
      amb1.addColorStop(0, "rgba(0,150,255,0.06)");
      amb1.addColorStop(1, "transparent");
      ctx.fillStyle = amb1; ctx.fillRect(0, 0, W, H);

      const amb2 = ctx.createRadialGradient(W - 200, 200, 0, W - 200, 200, 400);
      amb2.addColorStop(0, "rgba(0,229,255,0.04)");
      amb2.addColorStop(1, "transparent");
      ctx.fillStyle = amb2; ctx.fillRect(0, 0, W, H);

      ctx.strokeStyle = "rgba(0,180,255,0.035)"; ctx.lineWidth = 1;
      for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

      ctx.strokeStyle = "rgba(0,229,255,0.015)"; ctx.lineWidth = 1;
      for (let i = -H; i < W; i += 30) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i + H, H); ctx.stroke(); }

      glow(ctx, "#00e5ff", 30);
      ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = 2;
      roundRect(ctx, 8, 8, W - 16, H - 16, 22); ctx.stroke();
      noGlow(ctx);

      ctx.strokeStyle = "rgba(0,229,255,0.12)"; ctx.lineWidth = 1;
      roundRect(ctx, 14, 14, W - 28, H - 28, 18); ctx.stroke();

      const cDef = [[14, 14, 1, 1], [W - 14, 14, -1, 1], [14, H - 14, 1, -1], [W - 14, H - 14, -1, -1]];
      ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = 3;
      glow(ctx, "#00e5ff", 12);
      cDef.forEach(([cx, cy, sx, sy]) => {
        ctx.beginPath(); ctx.moveTo(cx, cy + sy * 36); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * 36, cy); ctx.stroke();
        ctx.save(); ctx.translate(cx + sx * 50, cy + sy * 50);
        ctx.rotate(Math.PI / 4);
        ctx.strokeRect(-4, -4, 8, 8);
        ctx.restore();
      });
      noGlow(ctx);

      // ════════════════════════════════
      // LEFT PANEL
      // ════════════════════════════════
      const LP = 20;
      drawCard(ctx, LP, LP, 278, H - LP * 2, 18, 0.80);

      const lpInner = ctx.createLinearGradient(LP, LP, LP, H - LP);
      lpInner.addColorStop(0, "rgba(0,229,255,0.05)");
      lpInner.addColorStop(0.5, "transparent");
      lpInner.addColorStop(1, "rgba(0,100,255,0.03)");
      ctx.fillStyle = lpInner;
      roundRect(ctx, LP, LP, 278, H - LP * 2, 18); ctx.fill();

      const AX = LP + 139, AY = 128, AR = 72;
      try {
        const avu = `https://graph.facebook.com/${userID}/picture?width=512&height=512&access_token=6628568379%7Cc1e620fa708a1d5696fb991c1bde5662`;
        const av = await loadImage(avu);

        for (let ring = 3; ring >= 1; ring--) {
          ctx.strokeStyle = `rgba(0,229,255,${0.08 * ring})`;
          ctx.lineWidth = ring * 4;
          ctx.beginPath(); ctx.arc(AX, AY, AR + 8 + ring * 8, 0, Math.PI * 2); ctx.stroke();
        }

        glow(ctx, "#00e5ff", 20);
        ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(AX, AY, AR + 4, 0, Math.PI * 2); ctx.stroke();
        noGlow(ctx);

        ctx.save();
        ctx.beginPath(); ctx.arc(AX, AY, AR, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        ctx.drawImage(av, AX - AR, AY - AR, AR * 2, AR * 2);
        ctx.restore();

        const shine = ctx.createRadialGradient(AX - AR * 0.3, AY - AR * 0.3, 0, AX, AY, AR);
        shine.addColorStop(0, "rgba(255,255,255,0.15)");
        shine.addColorStop(1, "transparent");
        ctx.fillStyle = shine;
        ctx.save(); ctx.beginPath(); ctx.arc(AX, AY, AR, 0, Math.PI * 2); ctx.closePath(); ctx.clip();
        ctx.fill(); ctx.restore();
      } catch {
        // Fallback: initials avatar instead of a bare circle
        const initials = (userName || "U").trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
        glow(ctx, "#00e5ff", 20);
        ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.arc(AX, AY, AR + 4, 0, Math.PI * 2); ctx.stroke();
        noGlow(ctx);
        const fg = ctx.createLinearGradient(AX - AR, AY - AR, AX + AR, AY + AR);
        fg.addColorStop(0, "rgba(0,229,255,0.25)");
        fg.addColorStop(1, "rgba(0,100,255,0.15)");
        ctx.fillStyle = fg;
        ctx.beginPath(); ctx.arc(AX, AY, AR, 0, Math.PI * 2); ctx.fill();
        glowText(ctx, initials || "?", AX, AY + 14, "#e0f7ff", "bold 40px Arial", 10, "center");
      }

      glowText(ctx, userName, AX, AY + AR + 30, "#ffffff", "bold 20px Arial", 10, "center");

      ctx.textAlign = "center";
      const roleBg = ctx.createLinearGradient(AX - 80, AY + AR + 36, AX + 80, AY + AR + 56);
      roleBg.addColorStop(0, "rgba(0,229,255,0.12)");
      roleBg.addColorStop(1, "rgba(0,100,255,0.08)");
      ctx.fillStyle = roleBg;
      roundRect(ctx, AX - 80, AY + AR + 36, 160, 22, 11); ctx.fill();
      ctx.strokeStyle = "rgba(0,229,255,0.35)"; ctx.lineWidth = 1;
      roundRect(ctx, AX - 80, AY + AR + 36, 160, 22, 11); ctx.stroke();
      glowText(ctx, "◈  SYSTEM CONTROLLER  ◈", AX, AY + AR + 52, "#00e5ff", "bold 10px Arial", 8, "center");

      glow(ctx, "#00ff9d", 14);
      ctx.fillStyle = "#00ff9d";
      ctx.beginPath(); ctx.arc(AX - 52, AY + AR + 76, 5, 0, Math.PI * 2); ctx.fill();
      noGlow(ctx);
      ctx.fillStyle = "#ccffe8"; ctx.font = "12px Arial"; ctx.textAlign = "left";
      ctx.fillText("ONLINE  •  ACTIVE", AX - 42, AY + AR + 81);

      const miniStats = [
        { icon: "🤖", label: "BOT UPTIME", value: botUp },
        { icon: "🖥", label: "SYS UPTIME", value: sysUp },
        { icon: "🟢", label: "NODE.JS", value: nodeVer },
        { icon: "🌐", label: "HOSTNAME", value: hostname },
        { icon: "📡", label: "NET IF", value: `${netIfaces} active` },
        { icon: "📈", label: "TOTAL RUNS", value: `${stats.totalRuns}` },
      ];

      let mY = AY + AR + 98;
      for (const ms of miniStats) {
        ctx.fillStyle = "rgba(0,229,255,0.05)";
        roundRect(ctx, LP + 12, mY, 254, 42, 9); ctx.fill();
        ctx.strokeStyle = "rgba(0,229,255,0.1)"; ctx.lineWidth = 1;
        roundRect(ctx, LP + 12, mY, 254, 42, 9); ctx.stroke();
        drawAccent(ctx, LP + 12, mY, 42);

        ctx.fillStyle = "#7df9ff"; ctx.font = "bold 10px Arial"; ctx.textAlign = "left";
        ctx.fillText(`${ms.icon}  ${ms.label}`, LP + 24, mY + 16);
        ctx.fillStyle = "#e0f7ff"; ctx.font = "bold 13px Arial"; ctx.textAlign = "right";
        ctx.fillText(ms.value, LP + 258, mY + 34);
        mY += 48;
      }

      const devY = H - LP - 58;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      roundRect(ctx, LP + 12, devY, 254, 48, 12); ctx.fill();
      glow(ctx, "#00e5ff", 8);
      ctx.strokeStyle = "#00e5ff"; ctx.lineWidth = 1.5;
      roundRect(ctx, LP + 12, devY, 254, 48, 12); ctx.stroke();
      noGlow(ctx);

      ctx.fillStyle = "rgba(0,229,255,0.6)"; ctx.font = "bold 10px Arial"; ctx.textAlign = "center";
      ctx.fillText("DEVELOPER", AX, devY + 18);
      glowText(ctx, "◆  HR ID OY  ◆", AX, devY + 38, "#00e5ff", "bold 17px Arial", 12, "center");

      // ════════════════════════════════
      // RIGHT PANEL
      // ════════════════════════════════
      const RX = 318;
      const RW = W - RX - LP;

      glowText(ctx, "⬡  ULTRA LIVE PERFORMANCE MONITOR", RX, 50, "#00e5ff", "bold 21px Arial", 16);

      ctx.strokeStyle = "rgba(0,229,255,0.25)"; ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath(); ctx.moveTo(RX, 60); ctx.lineTo(W - LP, 60); ctx.stroke();
      ctx.setLineDash([]);

      const chips = [
        { label: `🔑 SESSION: ${sessionID}`, color: "#00e5ff" },
        { label: `📅 ${dateStr}`, color: "#aaff00" },
        { label: `🕐 ${timeStr}`, color: "#ffdd00" },
      ];
      let chipX = RX;
      for (const chip of chips) {
        ctx.font = "bold 11px Arial";
        const chipW = ctx.measureText(chip.label).width + 24;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        roundRect(ctx, chipX, 66, chipW, 22, 11); ctx.fill();
        ctx.strokeStyle = `rgba(${hexToRgb(chip.color)},0.4)`; ctx.lineWidth = 1;
        roundRect(ctx, chipX, 66, chipW, 22, 11); ctx.stroke();
        ctx.fillStyle = chip.color; ctx.textAlign = "left";
        ctx.fillText(chip.label, chipX + 12, 81);
        chipX += chipW + 8;
      }

      const pingLabel = `⚡ ${ping}ms — ${pingStatus}`;
      ctx.font = "bold 11px Arial";
      const pingW = ctx.measureText(pingLabel).width + 24;
      glow(ctx, pingColor, 8);
      ctx.strokeStyle = pingColor; ctx.lineWidth = 1.5;
      roundRect(ctx, W - LP - pingW, 66, pingW, 22, 11); ctx.stroke();
      noGlow(ctx);
      ctx.fillStyle = pingColor; ctx.textAlign = "left";
      ctx.fillText(pingLabel, W - LP - pingW + 12, 81);

      const bars = [
        { icon: "💾", label: "RAM USAGE", sub: `Used: ${ramUsed}GB  Free: ${ramFree}GB  Total: ${ramTotal}GB`, pct: ramPct },
        { icon: "⚙️", label: "CPU LOAD", sub: `Model: ${cpuModel}  Cores: ${cores}  Load: ${load1} / ${load5} / ${load15}`, pct: cpuPct },
        { icon: "💿", label: "DISK USAGE", sub: `Used: ${disk.used}  Free: ${disk.free}  Total: ${disk.total}`, pct: disk.pct },
      ];

      let bY = 104;
      for (const b of bars) {
        const [c1, c2, cBg] = barColor(b.pct);
        drawCard(ctx, RX, bY, RW, 82, 12);
        drawAccent(ctx, RX, bY, 82, c1);

        ctx.fillStyle = "#7df9ff"; ctx.font = "bold 14px Arial"; ctx.textAlign = "left";
        ctx.fillText(`${b.icon}  ${b.label}`, RX + 14, bY + 22);

        const pctLabel = `${b.pct}%`;
        ctx.font = "bold 16px Arial";
        const pctW = ctx.measureText(pctLabel).width + 20;
        ctx.fillStyle = cBg;
        roundRect(ctx, RX + RW - pctW - 8, bY + 8, pctW, 24, 8); ctx.fill();
        glow(ctx, c1, 8); ctx.fillStyle = c1; ctx.textAlign = "right";
        ctx.fillText(pctLabel, RX + RW - 16, bY + 25);
        noGlow(ctx);

        drawProgressBar(ctx, RX + 14, bY + 32, RW - 28, 20, b.pct, [c1, c2]);

        ctx.fillStyle = "rgba(180,220,255,0.5)"; ctx.font = "11px Arial"; ctx.textAlign = "left";
        ctx.fillText(b.sub, RX + 14, bY + 68);

        bY += 92;
      }

      // ── Info Grid 3x2 ──
      const gridY = bY + 8;
      const gridInfos = [
        { icon: "🖥", label: "PLATFORM", value: `${platform} (${arch})` },
        { icon: "📊", label: "LOAD AVG", value: `${load1} / ${load5} / ${load15}` },
        { icon: "🧵", label: "CPU THREADS", value: `${cores} logical cores` },
        { icon: "🌡", label: "CPU MODEL", value: cpuModel },
        { icon: "🧮", label: "PROCESSES", value: `${processCount}` },
        { icon: "🎮", label: "GPU", value: gpuInfo },
      ];

      const gCols = 3;
      const gW = Math.floor(RW / gCols) - 6;
      gridInfos.forEach((inf, i) => {
        const col = i % gCols;
        const row = Math.floor(i / gCols);
        const gx = RX + col * (gW + 9);
        const gy = gridY + row * 60;

        drawCard(ctx, gx, gy, gW, 52, 10);
        drawAccent(ctx, gx, gy, 52, "#00aaff");

        ctx.fillStyle = "#7df9ff"; ctx.font = "bold 11px Arial"; ctx.textAlign = "left";
        ctx.fillText(`${inf.icon}  ${inf.label}`, gx + 14, gy + 19);
        ctx.fillStyle = "#e8f8ff"; ctx.font = "bold 13px Arial"; ctx.textAlign = "right";
        ctx.fillText(inf.value, gx + gW - 10, gy + 40);
      });

      // ── Per-core CPU bars ──
      const coreY = gridY + 120 + 18;
      ctx.fillStyle = "#7df9ff"; ctx.font = "bold 11px Arial"; ctx.textAlign = "left";
      ctx.fillText("⚙️  PER-CORE LOAD", RX, coreY);
      drawCoreBars(ctx, RX, coreY + 10, RW, 36, perCore);

      // ── Trend sparkline + network speed ──
      const sparkY = coreY + 70;
      ctx.fillStyle = "#7df9ff"; ctx.font = "bold 11px Arial"; ctx.textAlign = "left";
      ctx.fillText("📉  CPU / RAM TREND (recent runs)", RX, sparkY);
      ctx.fillStyle = "rgba(0,170,255,0.8)"; ctx.font = "10px Arial"; ctx.textAlign = "right";
      ctx.fillText("● RAM", RX + RW - 60, sparkY);
      ctx.fillStyle = "rgba(255,157,0,0.8)";
      ctx.fillText("● CPU", RX + RW - 10, sparkY);
      drawSparkline(ctx, RX, sparkY + 8, RW, 40, stats.history);

      // ── Bottom Status Bar ──
      const sbY = H - LP - 38;
      const sysOk = cpuPct < 80 && ramPct < 85 && ping < 400;
      const sbColor = sysOk ? "#00ff9d" : "#ffdd00";
      const sbLabel = sysOk ? "● ALL SYSTEMS OPERATIONAL" : "⚠ HIGH RESOURCE USAGE";

      ctx.fillStyle = "rgba(0,229,255,0.05)";
      roundRect(ctx, RX, sbY, RW, 30, 8); ctx.fill();
      ctx.strokeStyle = "rgba(0,229,255,0.18)"; ctx.lineWidth = 1;
      roundRect(ctx, RX, sbY, RW, 30, 8); ctx.stroke();

      ctx.fillStyle = "rgba(0,229,255,0.5)"; ctx.font = "11px Arial"; ctx.textAlign = "left";
      ctx.fillText(`v6.0 • by HR ID OY • NODE ${nodeVer} • NET ${netSpeed}`, RX + 12, sbY + 20);

      glow(ctx, sbColor, 8);
      ctx.fillStyle = sbColor; ctx.font = "bold 12px Arial"; ctx.textAlign = "right";
      ctx.fillText(sbLabel, RX + RW - 12, sbY + 20);
      noGlow(ctx);

      ctx.font = "10px monospace"; ctx.fillStyle = "rgba(0,180,255,0.12)"; ctx.textAlign = "left";
      for (let i = 0; i < 12; i++) {
        const hx = Math.floor(Math.random() * 0xFFFFFF).toString(16).toUpperCase().padStart(6, "0");
        ctx.fillText(`0x${hx}`, LP + 20 + i * 86, H - 6);
      }

      // ── Save & Send ──
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
