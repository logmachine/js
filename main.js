import fs from "fs";
import path from "path";
import os from "os";
import nodeFetch from "node-fetch";
import { io } from "socket.io-client";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);

// --- Helper: Get login username ---
function getLogin() {
  try {
    return process.env.USER || os.userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

// --- Custom Formatter ---
class CustomFormatter {
  constructor() {
    this.COLORS = {
      DEBUG: "\x1b[36m",
      INFO: "\x1b[34m",
      WARNING: "\x1b[33m",
      ERROR: "\x1b[31m",
      SUCCESS: "\x1b[32m",
    };
    this.RESET = "\x1b[0m";
    this.BOLD = "\x1b[1m";
    this.LEVEL_FORMATS = {
      DEBUG: this.BOLD + "[ DEBUG ]" + this.RESET,
      INFO: this.BOLD + "[ INFO ]" + this.RESET,
      WARNING: this.BOLD + "[ WARNING ]" + this.RESET,
      ERROR: this.BOLD + "[ ERROR ]" + this.RESET,
      SUCCESS: this.BOLD + "[ SUCCESS ]" + this.RESET,
    };
  }

  format(level, message, modulePath) {
    const username = process.env.CL_USERNAME || getLogin();
    const timestamp = new Date().toISOString();
    const parentDir =
      modulePath && modulePath !== "<stdin>"
        ? path.basename(path.dirname(modulePath))
        : "stdin";

    const color = this.COLORS[level] || "";
    const levelFmt =
      color +
      (this.LEVEL_FORMATS[level] || `[ ${level} ]`) +
      this.RESET;

    return `${this.COLORS.DEBUG}(${username}${this.RESET} @ ${
      this.COLORS.WARNING + parentDir + this.RESET
    }) 🤌 CL Timing: ${color}[ ${timestamp} ]${this.RESET}
${levelFmt} ${message}
🏁`;
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
      const formatted = new CustomFormatter().format(level, msg, modulePath);
      console.log(formatted);

      if (this.central) {
        if (!this.central.room) {
          throw new Error(
            "Central config must include 'room'. Example: { url, room }"
          );
        }
        const logData = this.parseLog(formatted);
        if (logData) {
          const res = await nodeFetch(
            `${this.central.url}${this.central.endpoint || "/api/logs"}?room=${
              this.central.room
            }`,
            { headers: { "Content-Type": "application/json", ...(this.central.headers || {}) }, method: "POST", body: JSON.stringify(logData) }
          );
          if (res.status !== 200) {
            throw new Error(`Failed to send log: ${res.data}`);
          }
        }
      }
    } catch (err) {
      console.error("Transporter error:", err.message);
    }
  }
}

class SocketIOTransporter {
  constructor({ logParser, central }) {
    this.parseLog = logParser;
    this.central = central;
    this.sio = io(this.central.url, {
      extraHeaders: this.central.headers || {},
      path: this.central.socketio_path || "/api/socket.io/",
    });
  }

  emit(level, msg, modulePath) {
    try {
      const formatted = new CustomFormatter().format(level, msg, modulePath);
      console.log(formatted);
      if (this.central && this.central.room) {
        const logData = this.parseLog(formatted);
        if (logData) {
          this.sio.emit("log", { room: this.central.room, data: logData });
        }
      }
    } catch (err) {
      console.error("SocketIOTransporter error:", err.message);
    }
  }
}

// --- Main Logger ---
class LogMachine {
  constructor(name, options = {}) {
    this.name = name;
    this.logFile = options.log_file || "logs.log";
    this.errorFile = options.error_file || "errors.log";
    this.debugLevel = parseInt(options.debug_level || 0, 10);
    this.verbose = options.verbose || false;
    this.central = options.central || null;
    this.formatter = new CustomFormatter();
    this.allowedMap = {
      1: ["ERROR"],
      2: ["SUCCESS"],
      3: ["WARNING"],
      4: ["INFO"],
      5: ["ERROR", "WARNING"],
      6: ["INFO", "SUCCESS"],
      7: ["ERROR", "WARNING", "INFO"],
    };

    // Choose transporter
    if (this.central) {
      const usernameFile = path.join(os.homedir(), ".cl_username");
      if (!fs.existsSync(usernameFile)) {
        try {
          const login = getLogin();
          axios
          .get(`${this.central.url}/api/get_username?base=${login}`)
          .then((response) => {
            if (response.status === 200) {
            const username = response.data.username || "unknown";
            process.env.CL_USERNAME = username;
            if (username !== "unknown") {
              fs.writeFileSync(usernameFile, username, "utf-8");
            }
            } else {
            process.env.CL_USERNAME = "unknown";
            }
          })
          .catch(() => {
            process.env.CL_USERNAME = "unknown";
          });
        } catch {
          process.env.CL_USERNAME = "unknown";
        }
      } else {
        process.env.CL_USERNAME = fs.readFileSync(usernameFile, "utf-8").trim();
      }

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
      this.transporter = {
      emit: (level, msg, modulePath) =>
        console.log(this.formatter.format(level, msg, modulePath)),
      };
    }
  }

  log(level, msg, modulePath = __filename) {
    // Debug level filtering
    if (this.debugLevel !== 0 && !this.isAllowed(level)) return;

    // Write to files
    const formatted = this.formatter.format(level, msg, modulePath);
    if (["ERROR"].includes(level)) {
      fs.appendFileSync(this.errorFile, formatted + "\n", "utf-8");
    }
    fs.appendFileSync(this.logFile, formatted + "\n", "utf-8");

    // Send to transporter
    this.transporter.emit(level, msg, modulePath);
  }

  debug(msg) { this.log("DEBUG", msg); }
  info(msg) { this.log("INFO", msg); }
  warning(msg) { this.log("WARNING", msg); }
  error(msg) { this.log("ERROR", msg); }
  success(msg) { this.log("SUCCESS", msg); }
  addLevel(level, allow = 0, ansi = null) {
    if (this.formatter.LEVEL_FORMATS[level]) {
      throw new Error(`Level "${level}" already exists.`);
    }
    if (ansi) {
      this.formatter.COLORS[level] = ansi;
    }
    this.formatter.LEVEL_FORMATS[level] = this.formatter.BOLD + `[ ${level} ]` + this.formatter.RESET;
    this.allowedMap[allow].push(level);
  }

  isAllowed(level) {
    const allowed = this.allowedMap[this.debugLevel] || [];
    return allowed.includes(level);
  }

  parseLog(logText) {
    logText = logText.trim();
    const ansiEscape = /\x1b\[[0-9;]*m/g;
    const endEscape = /🏁/g;
    const clean = logText.replace(ansiEscape, "");

    const headerPattern = /\((.*?) @ (.*?)\) 🤌 CL Timing: \[ (.*?) \]/;
    const headerMatch = clean.match(headerPattern);

    if (!headerMatch) return null;
    const [, user, module, timestamp] = headerMatch;
    const lines = clean.split("\n");
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

  jsonifier() {
    const content = fs.readFileSync(this.logFile, "utf-8");
    const logLines = content.split("\n🏁\n");
    const logEntries = [];
    for (const line of logLines) {
      if (line.trim()) {
        const entry = this.parseLog(line);
        if (entry) logEntries.push(JSON.stringify(entry));
      }
    }
    return logEntries;
  }
}

// --- Default logger instance ---
const defaultLogger = new LogMachine("default_logger", {
  debug_level: 0,
  verbose: false,
  central: {
    url: "https://logmachine.bufferpunk.com",
    room: "public",
    headers: {},
  },
});

export { LogMachine, defaultLogger };
