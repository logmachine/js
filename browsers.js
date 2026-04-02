// browser-logmachine.js
// ES module – works in the browser

// --- Helper: Get "login" username (browser edition) ---
function getLogin() {
  // Prefer stored CL_USERNAME; fallback to something stable-ish
  const stored = localStorage.getItem("CL_USERNAME");
  if (stored) return stored;
  // Try navigator info as a base string
  const base = (navigator?.userAgentData?.platform || navigator?.platform || "web").toLowerCase();
  return base || "unknown";
}

// --- Custom Formatter (no ANSI; console uses CSS styling) ---
class CustomFormatter {
  constructor() {
    this.LEVEL_COLORS = {
      DEBUG: "#06b6d4",   // cyan-ish
      INFO: "#3b82f6",    // blue
      WARNING: "#f59e0b", // amber
      ERROR: "#ef4444",   // red
      SUCCESS: "#22c55e", // green
    };
  }

  // Returns: { text, consoleArgs } so we can do console.log(text, ...consoleArgs)
  format(level, message, modulePath) {
    const username = window.CL_USERNAME || getLogin();
    const timestamp = new Date().toISOString();
    const parentDir = modulePath && modulePath !== "<stdin>"
      ? (modulePath.split("/").slice(-2, -1)[0] || "/")
      : "stdin";

    const levelTag = `[ ${level} ]`;
    const head = `(${username} @ ${parentDir}) 🤌 CL Timing: [ ${timestamp} ]`;
    const body = `${levelTag} ${message}`;
    const end = `🏁`;

    // Build a CSS-styled console line that still keeps the plain text structure
    const color = this.LEVEL_COLORS[level] || "#a3a3a3";
    const headStyle = "color:#9ca3af;font-weight:600";
    const tagStyle = `color:${color};font-weight:700`;
    const msgStyle = "color:#e5e7eb";
    const dimStyle = "color:#6b7280";

    const consoleText =
      `%c${head}\n%c${levelTag}%c ${message}\n%c${end}`;

    const consoleArgs = [
      headStyle,         // %c for head
      tagStyle,          // %c for [ LEVEL ]
      msgStyle,          // %c for message
      dimStyle           // %c for end flag
    ];

    // Text version (no CSS) – this is what we ship to server & parse
    const text = `${head}\n${levelTag} ${message}\n${end}`;

    return { text, consoleText, consoleArgs };
  }
}

// --- Transporters ---
class RequestsTransporter {
  constructor({ logParser, central }) {
    this.parseLog = logParser;
    this.central = central;
  }

  async emit(level, msg, modulePath) {
    try {
      const { text, consoleText, consoleArgs } = new CustomFormatter().format(level, msg, modulePath);
      // Console output
      console.log(consoleText, ...consoleArgs);

      if (this.central) {
        if (!this.central.room) {
          throw new Error("Central config must include 'room'. Example: { url, room }");
        }
        const logData = this.parseLog(text);
        if (logData) {
          const res = await fetch(
            `${this.central.url}${this.central.endpoint || "/api/logs"}?room=${encodeURIComponent(this.central.room)}`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(this.central.headers || {}),
              },
              body: JSON.stringify(logData),
              credentials: this.central.credentials || "omit", // allow passing "include" if needed
            }
          );
          if (!res.ok) {
            const body = await res.text().catch(() => "");
            throw new Error(`Failed to send log: ${res.status} ${body}`);
          }
        }
      }
    } catch (err) {
      console.error("Transporter error:", err?.message || err);
    }
  }
}

class SocketIOTransporter {
  constructor({ logParser, central }) {
    this.parseLog = logParser;
    this.central = central;

    if (typeof window.io !== "function") {
      console.warn("[LogMachine] Socket.IO client not found on window.io – falling back to console only.");
      this.sio = null;
      return;
    }

    // In browser, custom headers are tricky. If your server expects headers,
    // consider passing tokens via `auth` or query params instead.
    this.sio = window.io(this.central.url, {
      path: this.central.socketio_path || "/api/socket.io/",
      auth: this.central.auth || undefined, // e.g. { token: "..." }
      withCredentials: !!this.central.withCredentials, // if your CORS setup needs it
      // query: { ... } // optionally pass room/token here too
    });
  }

  emit(level, msg, modulePath) {
    try {
      const { text, consoleText, consoleArgs } = new CustomFormatter().format(level, msg, modulePath);
      // Console output
      console.log(consoleText, ...consoleArgs);

      if (this.central && this.central.room && this.sio) {
        const data = this.parseLog(text);
        if (data) {
          this.sio.emit("log", { room: this.central.room, data });
        }
      }
    } catch (err) {
      console.error("SocketIOTransporter error:", err?.message || err);
    }
  }
}

// --- Main Logger (Browser) ---
class LogMachineBrowser {
  constructor(name, options = {}) {
    this.name = name;
    this.debugLevel = parseInt(options.debug_level || 0, 10);
    this.verbose = !!options.verbose;
    this.central = options.central || null;
    this.formatter = new CustomFormatter();

    // In-memory buffer (since we don't have files in browser)
    this.buffer = [];
    this.errorBuffer = [];

    // Same semantics as server version
    this.allowedMap = {
      1: ["ERROR"],
      2: ["SUCCESS"],
      3: ["WARNING"],
      4: ["INFO"],
      5: ["ERROR", "WARNING"],
      6: ["INFO", "SUCCESS"],
      7: ["ERROR", "WARNING", "INFO"],
    };

    // Try to resolve username once per page load (store to localStorage)
    if (this.central) {
      this._ensureUsername(this.central).finally(() => {
        // no-op
      });

      if (!options.attached && !this.central.socketio) {
        this.transporter = new RequestsTransporter({
          logParser: this.parseLog.bind(this),
          central: this.central,
        });
      } else {
        this.transporter = new SocketIOTransporter({
          logParser: this.parseLog.bind(this),
          central: this.central,
        });
      }
    } else {
      // Console-only transport
      this.transporter = {
        emit: (level, msg, modulePath) => {
          const { consoleText, consoleArgs } = this.formatter.format(level, msg, modulePath);
          console.log(consoleText, ...consoleArgs);
        },
      };
    }
  }

  async _ensureUsername(central) {
    const key = "CL_USERNAME";
    if (!localStorage.getItem(key)) {
      try {
        const base = getLogin(); // “web” style base
        const res = await fetch(`${central.url}/api/get_username?base=${encodeURIComponent(base)}`, {
          method: "GET",
          headers: central.headers || {},
          credentials: central.credentials || "omit",
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({}));
          const username = data?.username || "unknown";
          window.CL_USERNAME = username;
          localStorage.setItem(key, username);
        } else {
          window.CL_USERNAME = "unknown";
        }
      } catch {
        window.CL_USERNAME = "unknown";
      }
    } else {
      window.CL_USERNAME = localStorage.getItem(key);
    }
  }

  // Default modulePath = current page (so parentDir displays nicely)
  log(level, msg, modulePath = window.location.pathname || "<stdin>") {
    if (this.debugLevel !== 0 && !this.isAllowed(level)) return;

    const { text } = this.formatter.format(level, msg, modulePath);

    // Store to buffers (simulate files)
    this.buffer.push(text);
    if (level === "ERROR") {
      this.errorBuffer.push(text);
    }

    // Ship out
    this.transporter.emit(level, msg, modulePath);
  }

  debug(msg, modulePath) { this.log("DEBUG", msg, modulePath); }
  info(msg, modulePath) { this.log("INFO", msg, modulePath); }
  warning(msg, modulePath) { this.log("WARNING", msg, modulePath); }
  error(msg, modulePath) { this.log("ERROR", msg, modulePath); }
  success(msg, modulePath) { this.log("SUCCESS", msg, modulePath); }

  addLevel(level, allow = 0, color = null) {
    if (this.formatter.LEVEL_COLORS[level]) {
      throw new Error(`Level "${level}" already exists.`);
    }
    if (color) this.formatter.LEVEL_COLORS[level] = color;
    if (!this.allowedMap[allow]) this.allowedMap[allow] = [];
    this.allowedMap[allow].push(level);

    // Also add convenience method
    this[level.toLowerCase()] = (msg, modulePath) => this.log(level, msg, modulePath);
  }

  isAllowed(level) {
    const allowed = this.allowedMap[this.debugLevel] || [];
    return allowed.includes(level);
  }

  // Same parse as server version (no ANSI needed)
  parseLog(logText) {
    logText = (logText || "").trim();
    const endEscape = /🏁/g;
    const headerPattern = /\((.*?) @ (.*?)\) 🤌 CL Timing: \[ (.*?) \]/;
    const headerMatch = logText.match(headerPattern);
    if (!headerMatch) return null;

    const [, user, module, timestamp] = headerMatch;
    const lines = logText.split("\n");
    const levelLine = lines[1] || "";
    const levelMatch = levelLine.match(/\[\s?(\w+)\s?\]\s?(.*)/);
    const level = levelMatch ? levelMatch[1] : "UNKNOWN";
    const message = levelMatch ? levelMatch[2] : "";

    return {
      user,
      module,
      level: level.trim(),
      timestamp,
      message: message.replace(endEscape, "").trim(),
    };
  }

  // Return JSON strings of buffered logs (like jsonifier in Python)
  jsonifier() {
    const joined = this.buffer.join("\n");
    const logLines = joined.split("\n🏁\n");
    const out = [];
    for (const line of logLines) {
      if (line.trim()) {
        const entry = this.parseLog(line);
        if (entry) out.push(JSON.stringify(entry));
      }
    }
    return out;
  }

  // Optional: allow download of current buffer as a text file
  download(name = "logs.log") {
    const blob = new Blob([this.buffer.join("\n") + "\n"], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
}

// --- Default logger instance for browser ---
const defaultLogger = new LogMachineBrowser("default_logger", {
  debug_level: 0,
  verbose: false,
  central: {
    url: "https://logmachine.bufferpunk.com",
    room: "public",
    headers: {},
    // socketio: true, // uncomment to use Socket.IO if window.io is loaded
    // auth: { token: "..." }, // optional, if your server expects an auth token
    // withCredentials: true,   // optional CORS cookies
  },
});

export { LogMachineBrowser as LogMachine, defaultLogger };
