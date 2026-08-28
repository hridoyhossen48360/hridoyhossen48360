const axios = require("axios");

const toru = (
  process.env.HRIDoy_API_URL ||
  process.env.TORU_API_URL ||
  "https://hridoy-api-umhk.onrender.com"
).replace(/\/+$/, "");

const TORU_SECRET = process.env.TORU_BOT_SECRET || "";
const MATCH_THRESHOLD = 0.7;

// ---- Admin-only access for sensitive commands ----
const ADMIN_IDS = ["100019273444463"];
const isAdmin = (senderID) => ADMIN_IDS.includes(String(senderID));
const NOT_ADMIN_MSG = "❌ Etoh command shudhu admin er jonno.";

// Shows the typing indicator WHILE real work (an API call) happens. Both
// the "on" and "off" indicator calls are fire-and-forget (not awaited) —
// they were previously blocking, which added a real network round-trip
// BEFORE the reply could be sent. Now nothing stands between the work
// finishing and message.reply() firing.
const typingWhile = async (api, threadID, workPromise) => {
  try {
    if (typeof api.sendTypingIndicator === "function") {
      Promise.resolve(api.sendTypingIndicator(threadID, true)).catch(() => {});
    }
  } catch {}

  const result = await workPromise;

  try {
    if (typeof api.sendTypingIndicator === "function") {
      Promise.resolve(api.sendTypingIndicator(threadID, false)).catch(() => {});
    }
  } catch {}

  return result;
};

// For instant, no-lookup replies (funny replies picked from a local array)
// there's no work to hide behind a typing indicator, so this fires the
// indicator without blocking the reply at all — no artificial delay.
const flashTyping = (api, threadID) => {
  try {
    if (typeof api.sendTypingIndicator === "function") {
      api.sendTypingIndicator(threadID, true);
      setTimeout(() => {
        try { api.sendTypingIndicator(threadID, false); } catch {}
      }, 500);
    }
  } catch {}
};

// ---- Spam protection (with basic cleanup so the map doesn't grow forever) ----
const spamMap = new Map();
const SPAM_LIMIT = 5;
const SPAM_WINDOW = 8000;
const SPAM_MUTE = 15000;
const SPAM_ENTRY_TTL = 5 * 60 * 1000; // drop entries untouched for 5 min

const isSpamming = (senderID) => {
  const now = Date.now();

  // occasional cleanup of stale entries to avoid unbounded memory growth
  if (spamMap.size > 500) {
    for (const [id, e] of spamMap) {
      const lastHit = e.hits.length ? e.hits[e.hits.length - 1] : 0;
      if (e.mutedUntil < now && now - lastHit > SPAM_ENTRY_TTL) {
        spamMap.delete(id);
      }
    }
  }

  const entry = spamMap.get(senderID) || { hits: [], mutedUntil: 0 };

  if (entry.mutedUntil > now) return true;

  entry.hits = entry.hits.filter(t => now - t < SPAM_WINDOW);
  entry.hits.push(now);

  if (entry.hits.length >= SPAM_LIMIT) {
    entry.mutedUntil = now + SPAM_MUTE;
    entry.hits = [];
    spamMap.set(senderID, entry);
    return true;
  }

  spamMap.set(senderID, entry);
  return false;
};

// ---- Pending "list" results, so a numbered reply can delete an item ----
const pendingLists = new Map();
const PENDING_TTL = 10 * 60 * 1000; // 10 min

function cleanupPendingLists() {
  const now = Date.now();
  for (const [id, e] of pendingLists) {
    if (now - e.ts > PENDING_TTL) pendingLists.delete(id);
  }
}

// Sends a reply and, if it succeeds, remembers which items were shown so a
// numbered reply to that exact message can be resolved back to an item.
function replyAndTrack(message, text, items, threadID) {
  return new Promise((resolve) => {
    try {
      message.reply(text, (err, info) => {
        if (!err && info && info.messageID) {
          pendingLists.set(info.messageID, { items, threadID, ts: Date.now() });
        }
        resolve(info);
      });
    } catch {
      resolve(message.reply(text));
    }
  });
}

function isUsable(text, prefix) {
  if (!text || typeof text !== "string") return false;

  const trimmed = text.trim();

  if (!trimmed) return false;
  if (prefix && trimmed.startsWith(prefix)) return false;
  if (trimmed.length > 500) return false;

  return true;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp[m][n];
}

function similarity(a, b) {
  const x = (a || "").toLowerCase().trim();
  const y = (b || "").toLowerCase().trim();

  if (!x.length && !y.length) return 1;

  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 1;

  return 1 - levenshtein(x, y) / maxLen;
}

async function findBestMatch(query) {
  try {
    const res = await axios.get(
      `${toru}/api/qa`,
      { params: { search: query }, timeout: 12000 }
    );

    const items = Array.isArray(res.data)
      ? res.data
      : (res.data?.data || []);

    let best = null;
    let bestScore = 0;

    for (const it of items) {
      const score = similarity(query, it.question);
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }

    return best ? { item: best, score: bestScore } : null;
  } catch {
    return null;
  }
}

async function findExactItem(ask, answerFilter) {
  try {
    const res = await axios.get(
      `${toru}/api/qa`,
      { params: { search: ask }, timeout: 12000 }
    );

    const items = Array.isArray(res.data)
      ? res.data
      : (res.data?.data || []);

    const askNorm = ask.trim().toLowerCase();
    const ansNorm = answerFilter.trim().toLowerCase();

    return (
      items.find(
        it =>
          String(it.question || "").trim().toLowerCase() === askNorm &&
          String(it.answer || "").trim().toLowerCase() === ansNorm
      ) || null
    );
  } catch {
    return null;
  }
}

async function autoLearnFromReply(question, answer) {
  try {
    await axios.post(
      `${toru}/api/learn`,
      { question, answer, secret: TORU_SECRET },
      { timeout: 12000, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error(
      "Baby auto-learn gateway error:",
      err.response?.data?.error || err.response?.data?.message || err.message
    );
  }
}

async function getSmartReply(query, threadID) {
  const match = await findBestMatch(query);

  if (match && match.score >= MATCH_THRESHOLD) {
    return match.item.answer;
  }

  try {
    const res = await axios.post(
      `${toru}/api/chat`,
      { message: query, sessionId: `fb-${threadID}` },
      { timeout: 20000 }
    );

    return res.data?.reply || "Hmm, bujhi nai baby 😅";
  } catch (err) {
    console.error(
      "Baby chat gateway error:",
      err.response?.data?.error || err.response?.data?.message || err.message
    );
    return "❌ Ekhon connect korte parchi na, ektu pore try koro baby 😔";
  }
}

// Triggers are stored WITHOUT a trailing space. matchPrefix below handles
// both cases: the trigger typed completely alone ("toru") and the trigger
// followed by a message ("toru kemon acho"). This also blocks false
// matches on unrelated words (e.g. "jan" no longer matches "january").
const PREFIX_TRIGGERS = [ "toru","bby","toruchan","tori","bot","তরু","বট","jan","জান","বেবি","baby"
];

function matchPrefix(raw) {
  for (const p of PREFIX_TRIGGERS) {
    if (raw === p) return p;              // typed alone, nothing after
    if (raw.startsWith(p + " ")) return p + " "; // trigger + message
  }
  return null;
}

const FUNNY_REPLIES = [
  "𝐀𝐬𝐬𝐚𝐥𝐚𝐦𝐮 𝐰𝐚𝐥𝐚𝐢𝐤𝐮𝐦 ♥",
  "বলেন sir__😌",
  "𝐁𝐨𝐥𝐨 𝐣𝐚𝐧 𝐤𝐢 𝐤𝐨𝐫𝐭𝐞 𝐩𝐚𝐫𝐢 𝐭𝐨𝐦𝐫 𝐣𝐨𝐧𝐧𝐨 🐸",
  "𝐋𝐞𝐛𝐮 𝐤𝐡𝐚𝐰 𝐝𝐚𝐤𝐭𝐞 𝐝𝐚𝐤𝐭𝐞 𝐭𝐨 𝐡𝐚𝐩𝐚𝐲 𝐠𝐞𝐬𝐨.🫴🍋",
  "𝐆𝐚𝐧𝐣𝐚 𝐤𝐡𝐚 𝐦𝐚𝐧𝐮𝐬𝐡 𝐡𝐨 🍁",
  "মদ খাও মানুষ হও 🍷",
  "𝐋𝐞𝐦𝐨𝐧 𝐭𝐮𝐬 🍋",
  "মুড়ি খাও 🫥",
  "𝐚𝐦𝐤𝐞 𝐬𝐞𝐫𝐞 𝐝𝐞𝐰 𝐚𝐦𝐢 𝐚𝐦𝐦𝐮𝐫 𝐤𝐚𝐬𝐞 𝐣𝐚𝐛𝐨!!🥺.....😗",
  "অন্যকে নই, নিজেকে ভালোবাসতে শিখো প্রিয় 😌",
  "একা বাঁচতে শিখো দেখবে পৃথিবী অনেক সুন্দর ✨",
  "──‎ 𝐇𝐮𝐌..? 👉👈",
  "আম গাছে আম নাই ঢিল কেন মারো, তোমার সাথে প্রেম নাই বেবি কেন ডাকো 😒🐸",
  "কি হলো, মিস টিস করচ্ছো নাকি 🤣",
  "𝐓𝐫𝐮𝐬𝐭 𝐦𝐞 𝐢𝐚𝐦 𝐭𝐨𝐫𝐮 𝐟𝐫𝐨𝐦 𝐇𝐫 𝐢𝐝 𝐨𝐲🧃",
  "𝗛𝗲𝘆 𝘅𝗮𝗻 𝗶𝗮𝗺 𝘁𝗼𝗿𝘂 𝗰𝗵𝗮𝗻✨",
  "𝐓𝐨𝐫 𝐣𝐧𝐧𝐨 𝐛𝐬𝐢 𝐚𝐜𝐡𝐢, 𝐣𝐥𝐝𝐢 𝐛𝐨𝐥 𝐤𝐢 𝐝𝐫𝐤𝐚𝐫 ✨",
  "একাকিত্ব মানুষকে ধীরে ধীরে শেষ করে ফেলে🥀",
  "চা খাবেন ,ঢেলে দেবো..?😙🤏",
  "𝙜𝙤𝙥 𝙜𝙤𝙥 𝙜𝙤𝙥 🙊"
];

module.exports = {
  config: {
    // NOTE: must stay lowercase. The bot core pushes this exact string into
    // GoatBot.onChat[] but stores commands in GoatBot.commands keyed by
    // name.toLowerCase(). A mixed-case name here made every onChat lookup
    // silently miss on cold boot (no error, just never fires) — that was
    // the actual bug, not this file's trigger logic.
    name: "babyai",
    version: "2.4.0",
    author: "Hridoy",
    countDown: 0,
    role: 0,
    shortDescription: "Toru Chan AI — HR ID OY Gateway",
    longDescription:
      "Teachable TORU AI with fuzzy-match replies, noprefix chat, and admin-only manage commands.",
    category: "System",
    // Declared so the bot's dependency loader installs axios automatically.
    dependencies: {
      axios: ""
    },
    // All of these route to this same command file — needed so
    // "babyteach", "babylist", etc. (glued, no space) are recognized as
    // this command and not treated as unknown commands.
    aliases: [
      "babyteach",
      "babyautoteach",
      "babylist",
      "babyreply",
      "babymsg",
      "babyedit",
      "babyremove",
      "babyrm"
    ],
    guide: {
      en:
        "{p}baby [message]\n" +
        "{p}babyteach [q] - [a]\n" +
        "{p}babyautoteach on/off  (admin only)\n" +
        "{p}babylist\n" +
        "{p}babylist [text]  (numbered results, reply with a number to delete — admin only)\n" +
        "{p}babyreply [text]  (searches inside all replies, reply with a number to delete — admin only)\n" +
        "{p}babymsg [trigger]\n" +
        "{p}babyedit [q] - [old] - [new]  (admin only)\n" +
        "{p}babyremove/babyrm [q] - [a]  (admin only)"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    const senderID = event.senderID;

    if (senderID === api.getCurrentUserID()) return;
    if (isSpamming(senderID)) return;

    const threadID = event.threadID;

    // Parse the raw text ourselves so subcommands can be typed glued
    // directly to "baby" with NO space — babyteach, babylist, babymsg,
    // babyedit, babyremove/babyrm, babyautoteach — while a lone "baby" or
    // "baby <message>" still works as plain chat.
    const prefix =
      (global.GoatBot && global.GoatBot.config && global.GoatBot.config.prefix) || "";

    let bodyText = (event.body || "").trim();
    if (prefix && bodyText.toLowerCase().startsWith(prefix.toLowerCase())) {
      bodyText = bodyText.slice(prefix.length).trim();
    }
    const lowerBody = bodyText.toLowerCase();

    const stripKeyword = (kw) => {
      if (lowerBody === kw) return "";
      if (lowerBody.startsWith(kw + " ")) return bodyText.slice(kw.length).trim();
      return null;
    };

    // Longest/most specific keywords first so "babyteach" is never
    // swallowed by the plain "baby" match.
    const KEYWORD_ORDER = [
      ["autoteach", "babyautoteach"],
      ["teach", "babyteach"],
      ["list", "babylist"],
      ["reply", "babyreply"],
      ["msg", "babymsg"],
      ["edit", "babyedit"],
      ["remove", "babyremove"],
      ["rm", "babyrm"]
    ];

    let sub = null;
    let rawArgs = "";

    for (const [name, kw] of KEYWORD_ORDER) {
      const r = stripKeyword(kw);
      if (r !== null) {
        sub = name;
        rawArgs = r;
        break;
      }
    }

    if (sub === null) {
      const r = stripKeyword("baby");
      rawArgs = r !== null ? r : (args.join(" ").trim() || bodyText);
    }

    try {
      if (!sub && !rawArgs) {
        flashTyping(api, threadID);

        return message.reply(
          FUNNY_REPLIES[Math.floor(Math.random() * FUNNY_REPLIES.length)]
        );
      }

      if (sub === "autoteach") {
        if (!isAdmin(senderID)) {
          return message.reply(NOT_ADMIN_MSG);
        }

        const mode = (rawArgs.split(/\s+/)[0] || "").toLowerCase();

        if (!["on", "off"].includes(mode)) {
          return message.reply("Use: babyautoteach on/off");
        }

        const status = mode === "on";

        const res = await axios.post(
          `${toru}/api/setting`,
          { autoTeach: status, secret: TORU_SECRET },
          { timeout: 12000 }
        );

        if (!res.data?.success) {
          return message.reply(
            res.data?.error || res.data?.message || "❌ Change kora jayni."
          );
        }

        return message.reply(`✅ Auto Teach ekhon ${status ? "ON 🟢" : "OFF 🔴"}`);
      }

      if (sub === "list") {
        const query = rawArgs.trim();

        if (!query) {
          // Original behavior: overall status summary.
          const res = await axios.get(`${toru}/api/status`, { timeout: 12000 });
          const d = res.data || {};

          return message.reply(
`╭─╼🌟 𝐓𝐨𝐫𝐮 𝐀𝐈 𝐒𝐭𝐚𝐭𝐮𝐬
├ 📝 𝐓𝐞𝐚𝐜𝐡𝐞𝐝 𝐐𝐮𝐞𝐬𝐭𝐢𝐨𝐧𝐬: ${d.teachedQuestions || 0}
├ 📦 𝐒𝐭𝐨𝐫𝐞𝐝 𝐑𝐞𝐩𝐥𝐢𝐞𝐬: ${d.storedReplies || 0}
├ 🔁 𝐀𝐮𝐭𝐨 𝐓𝐞𝐚𝐜𝐡: ${d.autoTeach ? "ON 🟢" : "OFF 🔴"}
╰─╼👤 𝐃𝐞𝐯: ${d.developer || "Toru"}`
          );
        }

        // New behavior: numbered search results; replying with a number
        // to this exact message deletes that entry (admin only).
        const res = await axios.get(
          `${toru}/api/qa`,
          { params: { search: query }, timeout: 12000 }
        );

        const items = Array.isArray(res.data) ? res.data : (res.data?.data || []);

        if (!items.length) {
          return message.reply("❌ Ei text er kono answer paoa jayni.");
        }

        const limited = items.slice(0, 15);
        const formatted = limited
          .map((it, i) => `➤ ${i + 1}. [${it.question}] → ${it.answer}`)
          .join("\n");

        const listText =
`📌 𝗦𝗲𝗮𝗿𝗰𝗵: ${query}
📋 𝗧𝗼𝘁𝗮𝗹: ${items.length}
━━━━━━━━━━━━━━
${formatted}
━━━━━━━━━━━━━━
🗑️ Delete korte number diye EI message-e reply koro (shudhu admin)`;

        cleanupPendingLists();
        return await replyAndTrack(message, listText, limited, threadID);
      }

      if (sub === "reply") {
        const query = rawArgs.trim();

        if (!query) {
          return message.reply("Use: babyreply [text]");
        }

        // Pull the full QA set (empty search = no filter) and match on the
        // ANSWER/reply text ourselves — babylist matches via the API's own
        // search (question side), this one searches inside every reply.
        const res = await axios.get(
          `${toru}/api/qa`,
          { params: { search: "" }, timeout: 12000 }
        );

        const allItems = Array.isArray(res.data) ? res.data : (res.data?.data || []);
        const q = query.toLowerCase();
        const items = allItems.filter(it =>
          String(it.answer || "").toLowerCase().includes(q)
        );

        if (!items.length) {
          return message.reply("❌ Ei text shoho kono reply paoa jayni.");
        }

        const limited = items.slice(0, 15);
        const formatted = limited
          .map((it, i) => `➤ ${i + 1}. [${it.question}] → ${it.answer}`)
          .join("\n");

        const replyText =
`📌 𝗥𝗲𝗽𝗹𝘆 𝗦𝗲𝗮𝗿𝗰𝗵: ${query}
📋 𝗧𝗼𝘁𝗮𝗹: ${items.length}
━━━━━━━━━━━━━━
${formatted}
━━━━━━━━━━━━━━
🗑️ Delete korte number diye EI message-e reply koro (shudhu admin)`;

        cleanupPendingLists();
        return await replyAndTrack(message, replyText, limited, threadID);
      }

      if (sub === "msg") {
        const trigger = rawArgs.trim();

        if (!trigger) {
          return message.reply("Use: babymsg [trigger]");
        }

        const res = await axios.get(
          `${toru}/api/qa`,
          { params: { search: trigger }, timeout: 12000 }
        );

        const items = Array.isArray(res.data) ? res.data : (res.data?.data || []);

        if (!items.length) {
          return message.reply("❌ Ei trigger-er kono answer paoa jayni.");
        }

        const formatted = items
          .slice(0, 15)
          .map((it, i) => `➤ ${i + 1}. [${it.question}] → ${it.answer}`)
          .join("\n");

        return message.reply(
`📌 𝗧𝗿𝗶𝗴𝗴𝗲𝗿: ${trigger}
📋 𝗧𝗼𝘁𝗮𝗹: ${items.length}
━━━━━━━━━━━━━━
${formatted}`
        );
      }

      if (sub === "teach") {
        const parts = rawArgs.split(" - ");

        if (parts.length < 2) {
          return message.reply("Use: babyteach question - answer");
        }

        const [ask, ans] = parts.map(s => s.trim());

        const res = await axios.post(
          `${toru}/api/teach`,
          { question: ask, answer: ans, secret: TORU_SECRET },
          { timeout: 12000 }
        );

        return message.reply(
          res.data?.success
            ? "✅ Shekhano hoyeche!"
            : (res.data?.error || res.data?.message || "❌ Vul hoyeche.")
        );
      }

      if (sub === "edit") {
        if (!isAdmin(senderID)) {
          return message.reply(NOT_ADMIN_MSG);
        }

        const parts = rawArgs.split(" - ");

        if (parts.length < 3) {
          return message.reply("Use: babyedit question - old reply - new reply");
        }

        const [ask, oldR, newR] = parts.map(s => s.trim());
        const found = await findExactItem(ask, oldR);

        if (!found) {
          return message.reply("❌ Ei question/old-answer mile emon kichu paoa jayni.");
        }

        const res = await axios.put(
          `${toru}/api/qa/${encodeURIComponent(found.id)}`,
          { question: ask, answer: newR, secret: TORU_SECRET },
          { timeout: 12000 }
        );

        return message.reply(
          res.data?.success
            ? "✅ Edit hoyeche!"
            : (res.data?.error || res.data?.message || "❌ Vul hoyeche.")
        );
      }

      if (sub === "remove" || sub === "rm") {
        if (!isAdmin(senderID)) {
          return message.reply(NOT_ADMIN_MSG);
        }

        const parts = rawArgs.split(" - ");

        if (parts.length < 2) {
          return message.reply("Use: babyremove question - answer");
        }

        const [ask, ans] = parts.map(s => s.trim());
        const found = await findExactItem(ask, ans);

        if (!found) {
          return message.reply("❌ Ei question/answer mile emon kichu paoa jayni.");
        }

        const res = await axios.delete(
          `${toru}/api/qa/${encodeURIComponent(found.id)}`,
          { timeout: 12000, data: { secret: TORU_SECRET } }
        );

        return message.reply(
          res.data?.success
            ? "✅ Delete hoyeche!"
            : (res.data?.error || res.data?.message || "❌ Vul hoyeche.")
        );
      }

      const reply = await typingWhile(api, threadID, getSmartReply(rawArgs, threadID));
      return message.reply(reply);

    } catch (err) {
      console.error(
        "baby command error:",
        err.response?.data?.error || err.response?.data?.message || err.message
      );

      return message.reply(
        "❌ Error: " + (err.response?.data?.error || err.response?.data?.message || err.message)
      );
    }
  },

  onChat: async function ({ api, event, message }) {
    const senderID = event.senderID;
    const botID = api.getCurrentUserID();

    if (senderID === botID) return;
    if (isSpamming(senderID)) return;

    const prefix =
      (global.GoatBot && global.GoatBot.config && global.GoatBot.config.prefix) || "";

    const raw = event.body ? event.body.toLowerCase().trim() : "";
    const threadID = event.threadID;

    try {
      const repliedToBot =
        event.messageReply && event.messageReply.senderID === botID;

      // Reply-to-a-"baby list" message with a number -> delete that item.
      // Admin only. Falls through to normal handling if it's not a number
      // or there's no pending list for that message.
      if (
        repliedToBot &&
        event.messageReply.messageID &&
        pendingLists.has(event.messageReply.messageID)
      ) {
        const numMatch = event.body && event.body.trim().match(/^\d+$/);

        if (numMatch) {
          if (!isAdmin(senderID)) {
            return message.reply(NOT_ADMIN_MSG);
          }

          const entry = pendingLists.get(event.messageReply.messageID);
          const idx = parseInt(numMatch[0], 10) - 1;
          const item = entry.items[idx];

          if (!item) {
            return message.reply("❌ Vul number, abar check koro.");
          }

          try {
            const res = await axios.delete(
              `${toru}/api/qa/${encodeURIComponent(item.id)}`,
              { timeout: 12000, data: { secret: TORU_SECRET } }
            );

            if (res.data?.success) {
              pendingLists.delete(event.messageReply.messageID);
              return message.reply(
                `✅ Delete hoyeche: [${item.question}] → ${item.answer}`
              );
            }

            return message.reply(
              res.data?.error || res.data?.message || "❌ Vul hoyeche."
            );
          } catch (err) {
            return message.reply(
              "❌ Error: " + (err.response?.data?.error || err.response?.data?.message || err.message)
            );
          }
        }
      }

      // Only auto-learn from genuine user<->user Q&A exchanges — replies
      // that target the bot's own message are handled separately below
      // as a smart-reply, not something to re-teach back to the bot.
      if (event.messageReply && !repliedToBot) {
        const question = event.messageReply.body;
        const answer = event.body;

        if (isUsable(question, prefix) && isUsable(answer, prefix)) {
          await autoLearnFromReply(question.trim(), answer.trim());
        }
      }

      if (repliedToBot && isUsable(event.body, prefix)) {
        const reply = await typingWhile(api, threadID, getSmartReply(event.body.trim(), threadID));
        return message.reply(reply);
      }

      if (!raw) return;

      const foundPrefix = matchPrefix(raw);

      if (foundPrefix) {
        const q = event.body.slice(foundPrefix.length).trim();

        if (!q) {
          // Just the trigger word alone (e.g. "toru", "baby") — send a
          // random funny reply instead of staying silent.
          flashTyping(api, threadID);
          return message.reply(
            FUNNY_REPLIES[Math.floor(Math.random() * FUNNY_REPLIES.length)]
          );
        }

        const reply = await typingWhile(api, threadID, getSmartReply(q, threadID));
        return message.reply(reply);
      }

    } catch (err) {
      console.error(
        "baby onChat error:",
        err.response?.data?.error || err.response?.data?.message || err.message
      );
    }
  }
};

