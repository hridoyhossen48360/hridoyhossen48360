const fs = require("fs-extra");
const path = require("path");
const axios = require("axios");

// Keep the logging destination explicit and visible to maintainers.
const TARGET_GROUP = "4531854703747113";

const CACHE_DIR = path.join(__dirname, "cache", "resend");
fs.ensureDirSync(CACHE_DIR);

if (!global.resendCache) {
  global.resendCache = new Map();
}

const MAX_CACHE = 2000;
const CACHE_EXPIRE = 30 * 60 * 1000; // 30 minutes

module.exports = {
  config: {
    name: "resend",
    version: "9.0.0",
    author: "Hridoy", //author chnage kkrle tor ma re cdmu raja condom lagai 🐍 
    countDown: 5,
    role: 1,
    description: "Send unsent messages and attachments to the log group",
    category: "Utility",
    guide: {
      en: "{pn} on\n{pn} off\n{pn}"
    }
  },

  // ================================
  // COMMAND
  // ================================
  onStart: async function ({ message, event, args, threadsData, role }) {
    if (role < 1) {
      return message.reply(
        "❌ এই command ব্যবহার করার permission তোমার নেই।"
      );
    }

    const threadID = event.threadID;

    const data = await threadsData.get(threadID, "data", {});
    const enabled = data?.resend !== false;

    if (!args[0]) {
      return message.reply(
        `📌 RESEND STATUS\n\n` +
        `Status: ${enabled ? "✅ ON" : "❌ OFF"}\n\n` +
        `• resend on\n` +
        `• resend off`
      );
    }

    const input = String(args[0]).toLowerCase();

    if (input === "on") {
      await threadsData.set(threadID, true, "data.resend");

      return message.reply(
        "✅ Resend system ON করা হয়েছে।\n\n" +
        "এই group-এর unsend message target log group-এ যাবে।"
      );
    }

    if (input === "off") {
      await threadsData.set(threadID, false, "data.resend");

      return message.reply(
        "❌ Resend system OFF করা হয়েছে।"
      );
    }

    return message.reply(
      "⚠️ ব্যবহার:\n\n" +
      "resend on\n" +
      "resend off"
    );
  },

  // ================================
  // CHAT EVENT
  // ================================
  onChat: async function ({
    api,
    event,
    usersData,
    threadsData
  }) {
    try {
      const {
        type,
        messageID,
        senderID,
        threadID,
        body,
        attachments
      } = event;

      // ==========================================
      // CACHE NORMAL MESSAGE
      // ==========================================
      if (
        type === "message" ||
        type === "message_reply"
      ) {
        if (!messageID) return;

        const files = [];

        if (Array.isArray(attachments)) {
          for (const att of attachments) {
            try {
              if (!att?.url) continue;

              const downloaded = await downloadAttachment(att);

              if (downloaded) {
                files.push({
                  path: downloaded.path,
                  type: att.type || "unknown",
                  filename: downloaded.filename
                });
              }
            } catch (e) {
              console.log(
                "[resend] Cache attachment error:",
                e.message
              );
            }
          }
        }

        global.resendCache.set(messageID, {
          messageID,
          senderID,
          threadID,
          body: body || "",
          attachments: files,
          timestamp: Date.now()
        });

        // Maximum cache
        if (global.resendCache.size > MAX_CACHE) {
          const firstKey =
            global.resendCache.keys().next().value;

          if (firstKey) {
            const old = global.resendCache.get(firstKey);

            cleanupFiles(old?.attachments);

            global.resendCache.delete(firstKey);
          }
        }

        cleanupExpiredCache();

        return;
      }

      // ==========================================
      // UNSEND EVENT
      // ==========================================
      if (type !== "message_unsend") return;

      // Check system status
      const data = await threadsData.get(
        threadID,
        "data",
        {}
      );

    if (data?.resend === false) {
        return;
      }

      const cached = global.resendCache.get(messageID);
    if (!cached) {
      console.log(`[resend] No cached message found for ${messageID}`);
      return;
    }

    const originalSenderID = cached.senderID || senderID;
    const originalThreadID = cached.threadID || threadID;

      let userName = "Unknown User";
      let groupName = "Unknown Group";

      // ==========================================
      // USER NAME
      // ==========================================
      try {
        const user = await usersData.get(originalSenderID);

        if (user?.name) {
          userName = user.name;
        }
      } catch {}

      if (userName === "Unknown User") {
        try {
          const info = await api.getUserInfo(originalSenderID);

          if (info?.[originalSenderID]?.name) {
            userName = info[originalSenderID].name;
          }
        } catch {}
      }

      // ==========================================
      // GROUP NAME
      // ==========================================
      try {
        const info = await api.getThreadInfo(originalThreadID);

        groupName =
          info?.threadName ||
          info?.name ||
          "Unknown Group";
      } catch {
        try {
          const thread = await threadsData.get(originalThreadID);

          groupName =
            thread?.threadName ||
            thread?.name ||
            "Unknown Group";
        } catch {}
      }

      // ==========================================
      // MESSAGE CONTENT
      // ==========================================
      const deletedText =
        cached?.body?.trim()
          ? cached.body
          : "(No text content)";

      const time = new Date().toLocaleString(
        "en-BD",
        {
          timeZone: "Asia/Dhaka"
        }
      );

      const header =
`🗑️ MESSAGE UNSEND ALERT

━━━━━━━━━━━━━━━━━━
👤 User: ${userName}
🆔 UID: ${originalSenderID}

👥 Group: ${groupName}
🆔 Group ID: ${originalThreadID}

⏰ Time: ${time}
━━━━━━━━━━━━━━━━━━

💬 Message:
${deletedText}`;

      // ==========================================
      // SEND TEXT FIRST
      // ==========================================
      await sendMessage(api, { body: header }, TARGET_GROUP);

      // ==========================================
      // SEND ATTACHMENTS
      // ==========================================
      if (
        cached?.attachments &&
        cached.attachments.length > 0
      ) {
        for (const file of cached.attachments) {
          try {
            if (
              !file?.path ||
              !fs.existsSync(file.path)
            ) {
              continue;
            }

            await sendAttachmentToGroup(
              api,
              file.path,
              `📎 Deleted ${getAttachmentName(file.type)}`,
              TARGET_GROUP,
              file.filename
            );
          } catch (e) {
            console.log(
              "[resend] Send attachment error:",
              e.message
            );
          }
        }
      }

      // ==========================================
      // CLEAN CACHE
      // ==========================================
      cleanupFiles(cached?.attachments);

      global.resendCache.delete(messageID);

    } catch (err) {
      console.log(
        "[resend] Main error:",
        err?.stack || err?.message || err
      );
    }
  }
};


// ==========================================
// DOWNLOAD ATTACHMENT
// ==========================================
async function downloadAttachment(att) {
  if (!att?.url) return null;

  try {
    const response = await axios.get(att.url, {
      responseType: "arraybuffer",
      timeout: 60000,
      maxRedirects: 10,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "audio/*,video/*,image/*,application/octet-stream,*/*"
      },
      validateStatus: status => status >= 200 && status < 400
    });

    if (!response.data || response.data.length < 50) {
      return null;
    }

    const ext = getExtension(att, response.headers?.["content-type"]);
    const filename =
      `resend_${Date.now()}_${Math.floor(Math.random() * 999999)}${ext}`;
    const filePath = path.join(CACHE_DIR, filename);

    await fs.writeFile(
      filePath,
      Buffer.from(response.data)
    );

    return {
      path: filePath,
      filename,
      mime: response.headers?.["content-type"] || ""
    };

  } catch (err) {
    console.log(
      "[resend] Download failed:",
      err.message
    );

    return null;
  }
}


// ==========================================
// EXTENSION
// ==========================================
function getExtension(att, contentType = "") {
  const type =
    String(att?.type || "").toLowerCase();

  const mime = String(contentType).toLowerCase().split(";")[0];

  const mimeMap = {
    "audio/mpeg": ".mp3",
    "audio/mp3": ".mp3",
    "audio/mp4": ".m4a",
    "audio/x-m4a": ".m4a",
    "audio/aac": ".aac",
    "audio/ogg": ".ogg",
    "audio/wav": ".wav",
    "audio/x-wav": ".wav",
    "audio/webm": ".webm",
    "video/mp4": ".mp4",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif"
  };

  if (mimeMap[mime]) return mimeMap[mime];

  if (att?.filename) {
    const ext =
      path.extname(att.filename);

    if (ext) return ext;
  }

  if (
    type === "photo" ||
    type === "animated_image"
  ) {
    return ".jpg";
  }

  if (type === "video") {
    return ".mp4";
  }

  if (type === "audio" || type === "voice") {
    const url = String(att?.url || "").toLowerCase();
    if (url.includes(".m4a")) return ".m4a";
    if (url.includes(".aac")) return ".aac";
    if (url.includes(".ogg")) return ".ogg";
    if (url.includes(".wav")) return ".wav";
    return ".mp3";
  }

  if (type === "sticker") {
    return ".png";
  }

  if (type === "file") {
    return ".bin";
  }

  if (type === "share") {
    return ".jpg";
  }

  return ".bin";
}


// ==========================================
// ATTACHMENT NAME
// ==========================================
function getAttachmentName(type) {
  type =
    String(type || "file").toLowerCase();

  switch (type) {
    case "photo":
      return "Photo";

    case "animated_image":
      return "GIF";

    case "video":
      return "Video";

    case "audio":
      return "Audio";

    case "voice":
      return "Voice Message";

    case "sticker":
      return "Sticker";

    case "file":
      return "File";

    default:
      return "Attachment";
  }
}


// ==========================================
// SEND MESSAGE PROMISE
// ==========================================
function sendMessage(api, message, threadID) {
  return new Promise((resolve, reject) => {
    api.sendMessage(
      message,
      threadID,
      err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      }
    );
  });
}

async function sendAttachmentToGroup(api, filePath, body, threadID, filename) {
  try {
    if (!fs.existsSync(filePath)) return false;

    const stream = fs.createReadStream(filePath);

    await sendMessage(
      api,
      {
        body,
        attachment: stream
      },
      threadID
    );

    return true;
  } catch (err) {
    console.log(
      `[resend] Attachment send failed (${threadID}) ${filename || "file"}:`,
      err.message
    );
    return false;
  }
}


// ==========================================
// CLEAN FILES
// ==========================================
function cleanupFiles(attachments) {
  if (!Array.isArray(attachments)) return;

  for (const file of attachments) {
    try {
      if (
        file?.path &&
        fs.existsSync(file.path)
      ) {
        fs.unlinkSync(file.path);
      }
    } catch {}
  }
}


// ==========================================
// EXPIRED CACHE CLEANER
// ==========================================
function cleanupExpiredCache() {
  const now = Date.now();

  for (const [key, value] of global.resendCache) {
    if (
      now - value.timestamp >
      CACHE_EXPIRE
    ) {
      cleanupFiles(value.attachments);

      global.resendCache.delete(key);
    }
  }
  }
