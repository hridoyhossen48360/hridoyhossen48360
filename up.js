const { createCanvas, registerFont } = require("canvas");
const os = require("os");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

/* ===== HACKER FONTS (missing font = fallback to monospace, no crash) ===== */
const fontDir = path.join(__dirname, "fonts");
const tryFont = (file, opts) => {
  try { registerFont(path.join(fontDir, file), opts); }
  catch { console.log(`[up] font not found: ${file}, using fallback`); }
};
tryFont("CourierPrime-Regular.ttf", { family: "Hacker" });
tryFont("CourierPrime-Bold.ttf", { family: "Hacker", weight: "bold" });

/* ===== THEMES =====
   Notun theme add korte chaile ekta block copy kore color change koro.
   (shob color 6-digit hex hote hobe, e.g. "#ff00aa") */
/* THEMES:START */
const THEMES = {
  matrix: {
    label: "Matrix Green",
    bg: ["#050a07", "#07140c"], scan: "0,255,100",
    p: "#00ff41", s: "#00cc66", a: "#00ffaa",
    head: "#7dffb0", text: "#d6ffe4", dim: "#4fae70",
    label_: "#e6ff4d", val: "#00ffd5",
    bars: ["#00ff41", "#00d9ff", "#d946ef"],
    g1: "#ff0055", g2: "#0066ff",
    tA: "#eafff0", tB: "#00ff41",
    ok: "#00ff66", warn: "#ffd400", bad: "#ff3b3b"
  },
  cyberpunk: {
    label: "Cyberpunk Neon",
    bg: ["#0b0614", "#150a24"], scan: "255,43,214",
    p: "#ff2bd6", s: "#00f0ff", a: "#fcee0a",
    head: "#ff7be9", text: "#f6e8ff", dim: "#9a7bb5",
    label_: "#fcee0a", val: "#00f0ff",
    bars: ["#ff2bd6", "#00f0ff", "#fcee0a"],
    g1: "#00f0ff", g2: "#ff2bd6",
    tA: "#ffffff", tB: "#ff2bd6",
    ok: "#39ff88", warn: "#fcee0a", bad: "#ff3355"
  },
  frost: {
    label: "Ice Frost",
    bg: ["#050b14", "#0a1a2c"], scan: "120,200,255",
    p: "#4cc9ff", s: "#9ae6ff", a: "#ffffff",
    head: "#bfeaff", text: "#eaf8ff", dim: "#6a96b3",
    label_: "#ffffff", val: "#7df9ff",
    bars: ["#4cc9ff", "#7b8cff", "#b4f0ff"],
    g1: "#7b8cff", g2: "#00e5ff",
    tA: "#ffffff", tB: "#4cc9ff",
    ok: "#5dffb0", warn: "#ffd166", bad: "#ff5c7a"
  },
  crimson: {
    label: "Crimson Blood",
    bg: ["#0a0405", "#1a0709"], scan: "255,40,60",
    p: "#ff2a3d", s: "#ff7a45", a: "#ffb703",
    head: "#ff7b88", text: "#ffe9ea", dim: "#a85a60",
    label_: "#ffb703", val: "#ffe066",
    bars: ["#ff2a3d", "#ff7a45", "#ffb703"],
    g1: "#ffb703", g2: "#7a00ff",
    tA: "#fff1f1", tB: "#ff2a3d",
    ok: "#3dff8a", warn: "#ffb703", bad: "#ff2a3d"
  },
  aurora: {
    label: "Aurora Violet",
    bg: ["#07061a", "#0b1730"], scan: "139,92,246",
    p: "#8b5cf6", s: "#2dd4bf", a: "#f472b6",
    head: "#c4b5fd", text: "#eef2ff", dim: "#7c86b8",
    label_: "#5eead4", val: "#f0abfc",
    bars: ["#8b5cf6", "#2dd4bf", "#f472b6"],
    g1: "#2dd4bf", g2: "#f472b6",
    tA: "#ffffff", tB: "#a78bfa",
    ok: "#34d399", warn: "#fbbf24", bad: "#fb7185"
  },
  gold: {
    label: "Royal Gold",
    bg: ["#0a0803", "#17110a"], scan: "255,194,51",
    p: "#ffc233", s: "#ffdf8a", a: "#fff2c4",
    head: "#ffd77a", text: "#fff6dd", dim: "#a8924f",
    label_: "#ffdf8a", val: "#ffffff",
    bars: ["#ffc233", "#ff9f1c", "#fff2c4"],
    g1: "#ff6a00", g2: "#ffe600",
    tA: "#fff8e1", tB: "#ffc233",
    ok: "#7dff9b", warn: "#ffc233", bad: "#ff4d4d"
  }
};
/* THEMES:END */

const THEME_KEYS = Object.keys(THEMES);
const DEFAULT_THEME = "random"; // "random" ba theme name (matrix, cyberpunk, frost, crimson, aurora, gold)

const pickTheme = (arg) => {
  const a = String(arg || "").toLowerCase();
  if (THEMES[a]) return a;
  const n = parseInt(a);
  if (n >= 1 && n <= THEME_KEYS.length) return THEME_KEYS[n - 1];
  if (THEMES[DEFAULT_THEME]) return DEFAULT_THEME;
  return THEME_KEYS[Math.floor(Math.random() * THEME_KEYS.length)];
};

/* ===== SYSTEM HELPERS ===== */
let prev = null;
const getCPU = () => {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    for (const t in c.times) total += c.times[t];
    idle += c.times.idle;
  }
  const cur = { idle, total };
  if (!prev) { prev = cur; return 0; }
  const di = cur.idle - prev.idle;
  const dt = cur.total - prev.total;
  prev = cur;
  return dt ? Math.round(100 - (100 * di / dt)) : 0;
};
getCPU(); // prime: first command e 0% dekhabe na

const getDisk = () => {
  try {
    const d = execSync("df -k /").toString().split("\n")[1].split(/\s+/);
    return Math.round((parseInt(d[2]) / parseInt(d[1])) * 100);
  } catch {
    return Math.floor(Math.random() * 30) + 40;
  }
};

const getNetwork = () => {
  try {
    const interfaces = os.networkInterfaces();
    let total = 0;
    for (const iface in interfaces) {
      interfaces[iface].forEach(addr => {
        if (addr.internal === false && addr.family === "IPv4") total++;
      });
    }
    return total;
  } catch {
    return 3;
  }
};

const getTemperature = () => {
  try {
    if (os.platform() === "linux") {
      const temp = execSync("cat /sys/class/thermal/thermal_zone0/temp").toString();
      return Math.round(parseInt(temp) / 1000);
    } else if (os.platform() === "darwin") {
      const temp = execSync("sudo powermetrics --samplers smc -i1 -n1 | grep -i 'CPU die temperature'").toString();
      const match = temp.match(/(\d+\.?\d*)/);
      return match ? Math.round(parseFloat(match[0])) : 45;
    }
  } catch {
    return Math.floor(Math.random() * 20) + 40;
  }
  return 45;
};

/* ===== DRAW (pure canvas, no node deps) ===== */
/* DRAW:START */
function drawDashboard(c, W, H, d, T) {
  const FONT = "'Hacker', monospace";
  const f = (px, bold) => `${bold ? "bold " : ""}${px}px ${FONT}`;
  const rgba = (hex, a) => {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
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
  const glow = (color, blur) => { c.shadowColor = color; c.shadowBlur = blur; };
  const noGlow = () => { c.shadowBlur = 0; c.shadowColor = "transparent"; };

  /* ---- background ---- */
  const bg = c.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, T.bg[0]);
  bg.addColorStop(1, T.bg[1]);
  c.fillStyle = bg;
  c.fillRect(0, 0, W, H);

  c.strokeStyle = rgba(T.p, 0.045);
  c.lineWidth = 1;
  for (let x = 0; x <= W; x += 60) { c.beginPath(); c.moveTo(x + 0.5, 0); c.lineTo(x + 0.5, H); c.stroke(); }
  for (let y = 0; y <= H; y += 60) { c.beginPath(); c.moveTo(0, y + 0.5); c.lineTo(W, y + 0.5); c.stroke(); }

  const g1 = c.createRadialGradient(W / 2, 140, 0, W / 2, 140, 760);
  g1.addColorStop(0, rgba(T.p, 0.16));
  g1.addColorStop(1, rgba(T.p, 0));
  c.fillStyle = g1; c.fillRect(0, 0, W, H);
  const g2 = c.createRadialGradient(W / 2, H, 0, W / 2, H, 620);
  g2.addColorStop(0, rgba(T.s, 0.09));
  g2.addColorStop(1, rgba(T.s, 0));
  c.fillStyle = g2; c.fillRect(0, 0, W, H);

  for (let y = 0; y < H; y += 4) {
    c.fillStyle = `rgba(${T.scan},${y % 8 === 0 ? 0.05 : 0.02})`;
    c.fillRect(0, y, W, 1);
  }
  const vg = c.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, W * 0.65);
  vg.addColorStop(0, "rgba(0,0,0,0)");
  vg.addColorStop(1, "rgba(0,0,0,0.55)");
  c.fillStyle = vg; c.fillRect(0, 0, W, H);

  /* ---- header ---- */
  const title = "█▓▒░ TORU CHAN UPTIME ░▒▓█";
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  c.font = f(85, true);
  c.fillStyle = rgba(T.g1, 0.8); c.fillText(title, W / 2 + 4, 128);
  c.fillStyle = rgba(T.g2, 0.8); c.fillText(title, W / 2 - 4, 119);
  const tg = c.createLinearGradient(0, 60, 0, 135);
  tg.addColorStop(0, T.tA);
  tg.addColorStop(1, T.tB);
  glow(T.p, 28); c.fillStyle = tg; c.fillText(title, W / 2, 123); noGlow();

  const sub = ">>> REAL-TIME SYSTEM MONITOR v3.0 <<<";
  c.font = f(36);
  const sw = c.measureText(sub).width;
  glow(T.s, 10); c.fillStyle = T.s; c.fillText(sub, W / 2, 185); noGlow();
  [[-1], [1]].forEach(([dir]) => {
    const x0 = W / 2 + dir * (sw / 2 + 24), x1 = W / 2 + dir * (sw / 2 + 24 + 150);
    const lg = c.createLinearGradient(x0, 0, x1, 0);
    lg.addColorStop(0, rgba(T.s, 0.8));
    lg.addColorStop(1, rgba(T.s, 0));
    c.strokeStyle = lg; c.lineWidth = 2;
    c.beginPath(); c.moveTo(x0, 174); c.lineTo(x1, 174); c.stroke();
  });

  /* ---- info chips ---- */
  const chip = (text, x, rightAlign, dotColor) => {
    c.font = f(26);
    const w = c.measureText(text).width + (dotColor ? 66 : 40);
    const cx = rightAlign ? x - w : x;
    rr(cx, 212, w, 46, 23);
    c.fillStyle = rgba(T.p, 0.08); c.fill();
    c.strokeStyle = rgba(T.p, 0.4); c.lineWidth = 2; c.stroke();
    if (dotColor) {
      glow(dotColor, 12); c.fillStyle = dotColor;
      c.beginPath(); c.arc(cx + 28, 235, 7, 0, Math.PI * 2); c.fill(); noGlow();
    }
    c.textAlign = "left"; c.fillStyle = T.s;
    c.fillText(text, cx + (dotColor ? 50 : 20), 244);
  };
  chip(`CONNECTED TO: ${d.hostname.substring(0, 20)}`, 100, false, T.ok);
  chip(`SESSION: ${d.session}`, W - 100, true, null);

  /* ---- main frame ---- */
  const fx = 80, fy = 280, fw = W - 160, fh = 700;
  rr(fx, fy, fw, fh, 18);
  c.fillStyle = rgba(T.p, 0.035); c.fill();
  glow(T.p, 18); c.strokeStyle = T.p; c.lineWidth = 3; c.stroke(); noGlow();

  // corner brackets
  const bl = 46;
  c.strokeStyle = T.a; c.lineWidth = 6; c.lineCap = "square"; glow(T.a, 14);
  [[fx, fy, 1, 1], [fx + fw, fy, -1, 1], [fx, fy + fh, 1, -1], [fx + fw, fy + fh, -1, -1]].forEach(([x, y, sx, sy]) => {
    c.beginPath(); c.moveTo(x, y + sy * bl); c.lineTo(x, y); c.lineTo(x + sx * bl, y); c.stroke();
  });
  noGlow(); c.lineCap = "butt";

  // tabs on top border
  const tab = (x, w, color) => {
    rr(x, 262, w, 36, 10);
    c.fillStyle = T.bg[0]; c.fill();
    c.strokeStyle = rgba(color, 0.7); c.lineWidth = 2; c.stroke();
  };
  tab(140, 260, T.p);
  c.font = f(20, true); c.textAlign = "center"; c.fillStyle = T.head;
  c.fillText("SYS://MONITOR", 270, 287);
  tab(W - 140 - 150, 150, T.ok);
  glow(T.ok, 10); c.fillStyle = T.ok;
  c.beginPath(); c.arc(W - 140 - 150 + 30, 280, 6, 0, Math.PI * 2); c.fill(); noGlow();
  c.textAlign = "left"; c.fillText("LIVE", W - 140 - 150 + 48, 287);

  // vertical divider
  c.strokeStyle = rgba(T.p, 0.5); c.lineWidth = 1; c.setLineDash([6, 4]);
  c.beginPath(); c.moveTo(W / 2, 315); c.lineTo(W / 2, 735); c.stroke();
  c.setLineDash([]);

  const panelHead = (text, x, w) => {
    c.textAlign = "left"; c.font = f(44, true);
    glow(T.p, 12); c.fillStyle = T.head; c.fillText(text, x, 350); noGlow();
    const ug = c.createLinearGradient(x, 0, x + w, 0);
    ug.addColorStop(0, rgba(T.p, 0.95));
    ug.addColorStop(1, rgba(T.p, 0));
    c.fillStyle = ug; c.fillRect(x, 366, w, 3);
  };

  /* ---- left panel: specs ---- */
  const lx = 120;
  panelHead("> SYSTEM SPECIFICATIONS", lx, 720);
  const tempCol = d.temp >= 80 ? T.bad : d.temp >= 65 ? T.warn : T.text;
  const loadCol = d.load >= 4 ? T.bad : d.load >= 2 ? T.warn : T.text;
  const rows = [
    ["OS", `${d.platform} ${d.arch}`, T.text],
    ["CORES", `${d.threads}`, T.text],
    ["CPU", d.cpuModel.substring(0, 24), T.text],
    ["NET", `${d.network} ACTIVE IFACES`, T.text],
    ["NODE", d.nodeVer.substring(0, 12), T.text],
    ["LOAD", `${d.load}`, loadCol],
    ["TEMP", `${d.temp}°C`, tempCol]
  ];
  rows.forEach(([k, v, col], i) => {
    const y = 428 + i * 47;
    c.save(); c.translate(140, y - 11); c.rotate(Math.PI / 4);
    glow(T.a, 8); c.fillStyle = T.a; c.fillRect(-6, -6, 12, 12); noGlow(); c.restore();
    c.textAlign = "left";
    c.font = f(30); c.fillStyle = T.dim; c.fillText(k, 165, y);
    c.font = f(32, true); c.fillStyle = col; c.fillText(v, 400, y);
    c.fillStyle = rgba(T.p, 0.09); c.fillRect(130, y + 14, 710, 1);
  });

  /* ---- right panel: live metrics ---- */
  const rx = W / 2 + 120;
  panelHead("> LIVE METRICS", rx, 560);

  const bar = (x, y, v, label, color) => {
    const w = 560, h = 38, by = y + 16;
    const col = v >= 90 ? T.bad : v >= 75 ? T.warn : color;
    c.textAlign = "left"; c.font = f(30); c.fillStyle = T.s; c.fillText(label, x, y);
    c.textAlign = "right"; c.font = f(34, true);
    glow(col, 10); c.fillStyle = col; c.fillText(`${v}%`, x + w, y); noGlow();

    rr(x, by, w, h, 10); c.fillStyle = "rgba(0,0,0,0.5)"; c.fill();
    c.save();
    rr(x, by, w, h, 10); c.clip();
    const fillW = v > 0 ? Math.max((v / 100) * w, 6) : 0;
    const fg = c.createLinearGradient(x, 0, x + Math.max(fillW, 1), 0);
    fg.addColorStop(0, rgba(col, 0.5));
    fg.addColorStop(1, col);
    c.fillStyle = fg; c.fillRect(x, by, fillW, h);
    c.fillStyle = "rgba(255,255,255,0.16)"; c.fillRect(x, by, fillW, h * 0.45);
    c.fillStyle = "rgba(0,0,0,0.45)";
    for (let i = 1; i < 20; i++) c.fillRect(x + (i * w) / 20 - 1, by, 2, h);
    c.restore();
    if (fillW > 8) {
      glow(col, 16); c.fillStyle = "#ffffff";
      c.fillRect(x + fillW - 3, by - 3, 3, h + 6); noGlow();
    }
    rr(x, by, w, h, 10);
    glow(col, 12); c.strokeStyle = rgba(col, 0.75); c.lineWidth = 2; c.stroke(); noGlow();
  };
  bar(rx, 430, d.cpu, "CPU LOAD", T.bars[0]);
  bar(rx, 530, d.ram, "MEMORY USAGE", T.bars[1]);
  bar(rx, 630, d.disk, "STORAGE USAGE", T.bars[2]);

  /* ---- horizontal divider ---- */
  c.strokeStyle = rgba(T.p, 0.6); c.lineWidth = 2; c.setLineDash([12, 6]);
  c.beginPath(); c.moveTo(100, 750); c.lineTo(W - 100, 750); c.stroke();
  c.setLineDash([]);

  /* ---- uptime + response ---- */
  const labelFont = f(44, true);
  c.font = labelFont;
  const labelW = Math.max(c.measureText("BOT UPTIME").width, c.measureText("RESPONSE TIME").width);
  const boxX = 190 + labelW + 40;

  const pill = (x, y, text, color, font) => {
    c.font = font;
    const tw = c.measureText(text).width, w = tw + 60, h = 78, top = y - 52;
    rr(x, top, w, h, 16);
    c.fillStyle = rgba(color, 0.12); c.fill();
    const pg = c.createLinearGradient(x, 0, x + w, 0);
    pg.addColorStop(0, color); pg.addColorStop(1, T.a);
    glow(color, 16); c.strokeStyle = pg; c.lineWidth = 3; c.stroke(); noGlow();
    c.textAlign = "left"; glow(color, 8); c.fillStyle = color; c.fillText(text, x + 30, y); noGlow();
  };

  // row 1: uptime (clock icon)
  const y1 = 840;
  c.strokeStyle = T.label_; c.lineWidth = 4; c.lineCap = "round";
  c.beginPath(); c.arc(140, y1 - 16, 24, 0, Math.PI * 2); c.stroke();
  c.beginPath(); c.moveTo(140, y1 - 16); c.lineTo(140, y1 - 32); c.moveTo(140, y1 - 16); c.lineTo(153, y1 - 10); c.stroke();
  c.lineCap = "butt";
  c.textAlign = "left"; c.font = labelFont;
  glow(T.label_, 8); c.fillStyle = T.label_; c.fillText("BOT UPTIME", 190, y1); noGlow();
  pill(boxX, y1, `[ ${d.uptime} ]`, T.val, f(56, true));

  // row 2: response (signal icon)
  const y2 = 935;
  let pingColor = T.ok, pingStatus = "EXCELLENT";
  if (d.ping > 200) { pingColor = T.warn; pingStatus = "GOOD"; }
  if (d.ping > 500) { pingColor = "#ff7a1a"; pingStatus = "SLOW"; }
  if (d.ping > 1000) { pingColor = T.bad; pingStatus = "POOR"; }
  c.strokeStyle = T.label_; c.lineWidth = 4; c.lineCap = "round";
  [14, 26, 38].forEach(r => { c.beginPath(); c.arc(140, y2 + 4, r, Math.PI * 1.25, Math.PI * 1.75); c.stroke(); });
  c.fillStyle = T.label_; c.beginPath(); c.arc(140, y2 + 4, 5, 0, Math.PI * 2); c.fill();
  c.lineCap = "butt";
  c.textAlign = "left"; c.font = labelFont;
  glow(T.label_, 8); c.fillStyle = T.label_; c.fillText("RESPONSE TIME", 190, y2); noGlow();
  pill(boxX, y2, `[ ${d.ping}ms | ${pingStatus} ]`, pingColor, f(50, true));

  /* ---- footer ---- */
  const status = d.ping < 100 ? "OPTIMAL" : d.ping < 300 ? "STABLE" : "LAG DETECTED";
  const sCol = d.ping < 100 ? T.ok : d.ping < 300 ? T.warn : T.bad;
  const stText = `<<< SYSTEM STATUS: ${status} >>>`;
  c.font = f(36, true);
  const stW = c.measureText(stText).width + 90;
  rr(W / 2 - stW / 2, 1004, stW, 58, 29);
  c.fillStyle = rgba(sCol, 0.1); c.fill();
  glow(sCol, 18); c.strokeStyle = sCol; c.lineWidth = 2.5; c.stroke(); noGlow();
  c.textAlign = "center"; glow(sCol, 10); c.fillStyle = sCol; c.fillText(stText, W / 2, 1044); noGlow();
  // blinking cursor
  c.fillStyle = Math.floor(Date.now() / 500) % 2 ? sCol : rgba(sCol, 0.25);
  c.fillRect(W / 2 + stW / 2 + 16, 1014, 16, 38);

  // hex stream
  c.font = f(20); c.textAlign = "left"; c.fillStyle = rgba(T.s, 0.45);
  const hexCount = 8, hexSpacing = (W - 200) / hexCount;
  for (let i = 0; i < hexCount; i++) {
    const hex = Math.random().toString(16).slice(2, 8).toUpperCase().padEnd(6, "0");
    c.fillText(`0x${hex}`, 100 + i * hexSpacing, H - 16);
  }
}
/* DRAW:END */

module.exports = {
  config: {
    guide: "{pn} [theme | list]\nThemes: " + THEME_KEYS.join(", "),
    name: "up",
    aliases: ["uptime", "status", "upt", "up"],
    version: "3.0",
    author: "HR ID OY",
    role: 0,
    category: "System",
    shortDescription: "Display system status in hacker terminal style"
  },

  onStart: async function ({ message, args = [], event, api }) {
    try {
      if ((args[0] || "").toLowerCase() === "list") {
        const list = THEME_KEYS.map((k, i) => `${i + 1}. ${k} — ${THEMES[k].label}`).join("\n");
        return message.reply(`🎨 Available themes:\n${list}\n\nUse: up <name | number>`);
      }

      const start = Date.now();
      const themeKey = pickTheme(args[0]);

      // System metrics
      const cpu = Math.min(getCPU(), 99);
      const total = os.totalmem();
      const used = total - os.freemem();
      const ram = Math.min(Math.round((used / total) * 100), 99);
      const disk = Math.min(getDisk(), 99);
      const network = Math.min(getNetwork(), 9);
      const temp = getTemperature();

      // Bot uptime
      const sec = process.uptime();
      const dd = Math.floor(sec / 86400);
      const h = Math.floor((sec % 86400) / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = Math.floor(sec % 60);
      const uptime = dd > 0 ? `${dd}d ${h}h ${m}m` : `${h}h ${m}m ${s}s`;

      const ping = Math.min(Date.now() - start, 9999);

      const data = {
        cpu, ram, disk, network, temp, ping, uptime,
        threads: os.cpus().length,
        platform: os.platform().toUpperCase(),
        arch: os.arch(),
        hostname: os.hostname(),
        load: Math.min(parseFloat(os.loadavg()[0].toFixed(2)), 9.99),
        cpuModel: os.cpus()[0].model.split("@")[0].replace(/\((R|TM|tm)\)/g, "").replace(/\s+/g, " ").trim(),
        nodeVer: process.version,
        session: Date.now().toString(16).toUpperCase().substring(0, 12)
      };

      const W = 1800, H = 1100;
      const cv = createCanvas(W, H);
      drawDashboard(cv.getContext("2d"), W, H, data, THEMES[themeKey]);

      const file = path.join(__dirname, "cache", `terminal_${Date.now()}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, cv.toBuffer("image/png"));

      await message.reply({ attachment: fs.createReadStream(file) });

      setTimeout(() => { if (fs.existsSync(file)) fs.unlinkSync(file); }, 15000);
    } catch (error) {
      console.error("TERMINAL ERROR:", error);
      message.reply("❌ System terminal failed to generate.");
    }
  },

  onChat: async function ({ event, api }) {
    if (event.body && event.body.toLowerCase() === "hack") {
      api.sendMessage("```ACCESS DENIED\nINSUFFICIENT PRIVILEGES\n>_```", event.threadID);
    }
  }
};
