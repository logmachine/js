import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import nodeFetch from "node-fetch";
import { io } from "socket.io-client";

const LM_CREDS_PATH = path.join(os.homedir(), ".logmachine");
let LM_LOADED = false;

const __LM_DEFAULT_FMT = `({username} @ \x1b[33m{module}{reset}) 🤌 CL Timing: {color}[ {timestamp} ]{reset}\n{level} {message}\n🏁`;

function credsFileToDict() {
  const creds = {};
  try {
    if (fs.existsSync(LM_CREDS_PATH)) {
      const content = fs.readFileSync(LM_CREDS_PATH, "utf-8").trim();
      for (const line of content.split(/\r?\n/)) {
        if (!line.includes("=")) continue;
        const [rawKey, ...rest] = line.split("=");
        const key = rawKey.trim();
        const value = rest.join("=").trim();
        if (!key) continue;
        creds[key] = value;
        process.env[key] = value;
      }
    }
    LM_LOADED = true;
  } catch {
    LM_LOADED = false;
  }
  return creds;
}

function loadLMCreds() {
  if (!LM_LOADED) return credsFileToDict();
  const creds = {};
  for (const key of ["lm_username", "lm_auth_token", "lm_expiry"]) {
    if (process.env[key]) creds[key] = process.env[key];
  }
  return creds;
}

function persistLMCreds(username, authToken, expiry) {
  const current = {};
  try {
    if (fs.existsSync(LM_CREDS_PATH)) {
      const content = fs.readFileSync(LM_CREDS_PATH, "utf-8").trim();
      for (const line of content.split(/\r?\n/)) {
        if (!line.includes("=")) continue;
        const [rawKey, ...rest] = line.split("=");
        current[rawKey.trim()] = rest.join("=").trim();
      }
    }
  } catch {
    // ignore
  }

  if (username) {
    current.lm_username = username;
    process.env.lm_username = username;
  }
  if (authToken) {
    current.lm_auth_token = authToken;
    process.env.lm_auth_token = authToken;
  }
  if (expiry) {
    current.lm_expiry = expiry;
    process.env.lm_expiry = expiry;
  }

  try {
    const lines = [];
    for (const [key, value] of Object.entries(current)) {
      lines.push(`${key}=${value}`);
    }
    fs.writeFileSync(LM_CREDS_PATH, lines.join("\n") + "\n", { mode: 0o600 });
  } catch {
    // ignore
  }
}

function tokenExpiryIsValid() {
  const expiry = process.env.lm_expiry;
  if (!expiry) return false;
  const parsed = Date.parse(expiry);
  return !Number.isNaN(parsed) && parsed > Date.now();
}

function authHeaders(headers) {
  const merged = Object.assign({}, headers || {});
  const hasAuthorization = Object.keys(merged).some((key) => key.toLowerCase() === "authorization");
  if (!hasAuthorization) {
    const token = process.env.lm_auth_token || "";
    if (token) merged.Authorization = `Bearer ${token}`;
  }
  return merged;
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawnSync("open", [url], { stdio: "ignore" });
      return true;
    }
    if (process.platform === "win32") {
      spawnSync("cmd", ["/c", "start", "", url], { stdio: "ignore", shell: true });
      return true;
    }
    const result = spawnSync("xdg-open", [url], { stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

async function sdkLoginViaDeviceFlow(centralUrl, timeoutSeconds) {
  timeoutSeconds = timeoutSeconds || 180;
  const startUrl = `${(centralUrl || "").replace(/\/$/, "")}/api/auth/device/start`;
  const startResponse = await nodeFetch(startUrl, { method: "POST" });
  if (!startResponse.ok) {
    throw new Error(`Failed to start device login flow: ${await startResponse.text()}`);
  }

  const payload = await startResponse.json();
  const deviceCode = payload.device_code;
  const verificationUriComplete = payload.verification_uri_complete;
  const userCode = payload.user_code;
  const interval = Math.max(parseInt(payload.interval || 3, 10), 1);

  if (!deviceCode || !verificationUriComplete) {
    throw new Error("Device flow did not return the required login details");
  }

  let webBase = (centralUrl || "").replace(/\/$/, "");
  if (webBase.endsWith("/api")) {
    webBase = webBase.slice(0, -4);
  }

  let fallbackUrl = verificationUriComplete;
  if (!fallbackUrl.startsWith("http")) {
    fallbackUrl = `${webBase}/${verificationUriComplete.replace(/^\//, "")}`;
  }

  const opened = openBrowser(fallbackUrl);
  if (!opened) {
    console.log("Open this URL on any device to log in:");
    console.log(`  ${fallbackUrl}`);
  }

  if (verificationUriComplete) {
    console.log("To authenticate this device:");
    console.log(`  1) Open: ${verificationUriComplete}`);
    console.log(`  2) Enter code: ${userCode || "(if not auto-filled)"}`);
    console.log("\x1b[1mNOTE: For a better experience, use an API KEY\x1b[0m\n");
  }

  const startedAt = Date.now();
  const pollUrl = `${(centralUrl || "").replace(/\/$/, "")}/api/auth/device/poll`;

  while (Date.now() - startedAt < timeoutSeconds * 1000) {
    const response = await nodeFetch(pollUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
    });

    if (!response.ok) {
      throw new Error(`Device login polling failed: ${await response.text()}`);
    }

    const result = await response.json();
    if (result.status === "approved") {
      console.log("Device login approved! Finalizing authentication...");
      return {
        token: result.token,
        username: result.user && result.user.username,
        provider: result.provider,
        expires_in: result.expires_in,
      };
    }

    if (result.status === "expired") {
      throw new Error("Login code expired before authentication completed");
    }

    await new Promise((resolve) => setTimeout(resolve, interval * 1000));
  }

  throw new Error("Timed out waiting for device login to complete");
}

function _formatTime(date, datefmt) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const M = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const m = pad(date.getMinutes());
  const s = pad(date.getSeconds());

  if (datefmt === "%Y-%m-%dT%H:%M:%S" || !datefmt) {
    return `${y}-${M}-${d}T${h}:${m}:${s}`;
  }

  let result = datefmt;
  result = result.replace(/%Y/g, String(y));
  result = result.replace(/%m/g, M);
  result = result.replace(/%d/g, d);
  result = result.replace(/%H/g, h);
  result = result.replace(/%M/g, m);
  result = result.replace(/%S/g, s);
  return result;
}

class CustomFormatter {
  constructor(fmt, datefmt) {
    this._fmt = fmt || __LM_DEFAULT_FMT;
    this.datefmt = datefmt || "%Y-%m-%dT%H:%M:%S";
    this.COLORS = {
      DEBUG: "\x1b[36m",
      INFO: "\x1b[34m",
      WARNING: "\x1b[33m",
      ERROR: "\x1b[31m",
      SUCCESS: "\x1b[32m",
      CRITICAL: "\x1b[41m",
      "*": "\x1b[37m",
    };
    this.RESET = "\x1b[0m";
    this.BOLD = "\x1b[1m";
    this.LEVEL_FORMATS = {
      DEBUG: `${this.BOLD}[ DEBUG ]${this.RESET}`,
      INFO: `${this.BOLD}[ INFO ]${this.RESET}`,
      WARNING: `${this.BOLD}[ WARNING ]${this.RESET}`,
      ERROR: `${this.BOLD}[ ERROR ]${this.RESET}`,
      SUCCESS: `${this.BOLD}[ SUCCESS ]${this.RESET}`,
      CRITICAL: `${this.BOLD} CRITICAL ${this.RESET}`,
      "*": `${this.BOLD}[ UNKNOWN ]${this.RESET}`,
    };
  }

  set_color(levelName, colorCode) {
    this.COLORS[levelName] = colorCode;
    this.LEVEL_FORMATS[levelName] = `${this.BOLD}[ ${levelName} ]${this.RESET}`;
  }

  format(level, message, modulePath) {
    const username = getLogin();
    const timestamp = _formatTime(new Date(), this.datefmt);
    const module =
      modulePath && modulePath !== "<stdin>"
        ? path.basename(path.dirname(modulePath))
        : "terminal";
    const color = this.COLORS[level] || this.COLORS["*"];
    const levelFmt = `${color}${this.LEVEL_FORMATS[level] || this.LEVEL_FORMATS["*"]}${this.RESET}`;

    return this._fmt
      .replace(/\{username\}/g, `${this.COLORS["DEBUG"]}${username}${this.RESET}`)
      .replace(/\{module\}/g, module)
      .replace(/\{timestamp\}/g, `${color}${timestamp}${this.RESET}`)
      .replace(/\{color\}/g, color)
      .replace(/\{reset\}/g, this.RESET)
      .replace(/\{level\}/g, levelFmt)
      .replace(/\{message\}/g, message);
  }
}

class SocketIOTransporter {
  constructor(central) {
    this.central = central;
    this.formatter = null;
    this.sio = null;

    if (this.central && this.central.url) {
      try {
        this.sio = io(this.central.url, {
          path: this.central.endpoint || "/api/socket.io/",
          retry: true,
          auth: process.env.lm_auth_token ? { token: process.env.lm_auth_token } : undefined,
        });

        this.sio.emit("join", { room: this.central.room });
        this.sio.on("log", (data) => this._onLog(data));
        this.sio.on("error", (err) => console.error(err));
      } catch (error) {
        throw new Error(`Failed to connect to central server: ${error.message}`);
      }
    }
  }

  _onLog(data) {
    if (!this.formatter) return;
    const level = data.level ? data.level.toUpperCase() : "INFO";
    const module = (data.module || "unknown") + " :external";
    const formatted = this.formatter.format(level, data.message || "", module);
    console.log(formatted);
  }

  emit(level, msg, modulePath) {
    try {
      const formatted = this.formatter.format(level, msg, modulePath);
      console.log(formatted);

      if (this.sio && this.sio.connected && this.central && this.central.room) {
        this.sio.emit("log", {
          room: this.central.room,
          data: {
            user: getLogin(),
            module: modulePath && modulePath !== "<stdin>" ? path.basename(path.dirname(modulePath)) : "terminal",
            level: level,
            timestamp: _formatTime(new Date(), this.formatter.datefmt),
            message: msg,
          },
        });
      }
    } catch (error) {
      console.error("SocketIOTransporter error:", error.message || error);
    }
  }

  close() {
    try {
      if (this.sio && this.sio.connected) {
        this.sio.disconnect();
      }
    } catch {
      // ignore
    }
  }
}

function getLogin() {
  try {
    if (!LM_LOADED) credsFileToDict();
    return process.env.lm_username || os.userInfo().username || process.env.USER || "unknown";
  } catch {
    return process.env.USER || "unknown";
  }
}

const LEVEL_MAP = {
  DEBUG: 10,
  INFO: 20,
  SUCCESS: 25,
  WARNING: 30,
  ERROR: 40,
  CRITICAL: 50,
};

class LogMachine {
  constructor(name, options) {
    options = options || {};
    this.name = name || "logmachine";
    this.level = LEVEL_MAP[options.level] || LEVEL_MAP.DEBUG;
    this.central = options.central || null;

    const logFileName =
      options.log_file ||
      (this.level === 0 ? "logs.log" : `${(Object.keys(LEVEL_MAP).find((k) => LEVEL_MAP[k] === this.level) || "logs").toLowerCase()}.log`);
    this.logFile = logFileName;

    this.formatter = new CustomFormatter(options.log_format || options.format, options.datefmt);

    if (!LM_LOADED) credsFileToDict();

    if (this.central) {
      this.login(options.timeout_seconds || 180, options.api_key || this.central.API_KEY || this.central.api_key).catch(() => {});
      if (!this.central.room) {
        this.central.room = getLogin();
      }
      this.transporter = new SocketIOTransporter(this.central);
      this.transporter.formatter = this.formatter;
    } else {
      this.transporter = null;
    }
  }

  async _syncIdentityFromSession() {
    if (!this.central) return;
    const token = process.env.lm_auth_token;
    if (!token) return;
    try {
      const sessionUrl = `${(this.central.url || "").replace(/\/$/, "")}/api/auth/session`;
      const response = await nodeFetch(sessionUrl, {
        method: "GET",
        headers: authHeaders(this.central.headers || {}),
      });
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        const username = payload && payload.user && payload.user.username;
        if (username) persistLMCreds(username, token, "");
      }
    } catch {
      // ignore
    }
  }

  async login(timeoutSeconds, apiKey) {
    timeoutSeconds = timeoutSeconds || 180;
    if (!this.central || !this.central.url) {
      throw new Error("Login requires central logging configuration with a 'url'.");
    }

    const directApiKey =
      apiKey || this.central.API_KEY || this.central.api_key || process.env.LM_API_KEY || process.env.lm_api_key;
    if (directApiKey) {
      persistLMCreds("", directApiKey, "");
      this.central.headers = this.central.headers || {};
      if (!Object.keys(this.central.headers).some((k) => k.toLowerCase() === "authorization")) {
        this.central.headers.Authorization = `Bearer ${directApiKey}`;
      }
      await this._syncIdentityFromSession();
      return this;
    }

    if (
      this.central.headers &&
      Object.keys(this.central.headers).some((k) => k.toLowerCase() === "authorization")
    ) {
      await this._syncIdentityFromSession();
      return this;
    }

    if (process.env.lm_auth_token && process.env.lm_expiry && tokenExpiryIsValid()) {
      await this._syncIdentityFromSession();
      return this;
    }

    const result = await sdkLoginViaDeviceFlow(this.central.url, timeoutSeconds);
    if (!result.token) {
      throw new Error("Login completed without an auth token.");
    }

    const expiry = result.expires_in
      ? new Date(Date.now() + Number(result.expires_in) * 1000).toISOString()
      : "";
    persistLMCreds(result.username || "", result.token, expiry);
    this.central.headers = this.central.headers || {};
    if (!Object.keys(this.central.headers).some((k) => k.toLowerCase() === "authorization")) {
      this.central.headers.Authorization = `Bearer ${result.token}`;
    }

    await this._syncIdentityFromSession();
    return this;
  }

  logout() {
    if (this.central) {
      persistLMCreds("", "", "");
      if (this.central.headers) {
        this.central.headers = Object.fromEntries(
          Object.entries(this.central.headers).filter(([k]) => k.toLowerCase() !== "authorization")
        );
      }
    }
    console.log("Logged out and cleared credentials.");
  }

  log(level, msg, modulePath) {
    modulePath = modulePath || "<stdin>";
    const levelNum = LEVEL_MAP[level];
    if (levelNum && levelNum < this.level) return;

    const formatted = this.formatter.format(level, msg, modulePath);
    try {
      fs.appendFileSync(this.logFile, formatted + "\n", "utf-8");
    } catch {
      // ignore
    }

    if (this.transporter) {
      try {
        this.transporter.emit(level, msg, modulePath);
      } catch (error) {
        console.error("[LogMachine] transporter emit error:", error.message || error);
      }
    }
  }

  debug(msg, modulePath) {
    this.log("DEBUG", msg, modulePath);
  }
  info(msg, modulePath) {
    this.log("INFO", msg, modulePath);
  }
  warning(msg, modulePath) {
    this.log("WARNING", msg, modulePath);
  }
  error(msg, modulePath) {
    this.log("ERROR", msg, modulePath);
  }
  success(msg, modulePath) {
    this.log("SUCCESS", msg, modulePath);
  }

  new_level(levelName, levelNum, ansiColor) {
    ansiColor = ansiColor || "\x1b[37m";
    if (levelNum && Object.values(LEVEL_MAP).includes(levelNum)) {
      throw new Error("The level you're trying to declare already exists");
    }

    LEVEL_MAP[levelName] = levelNum;
    this.formatter.set_color(levelName, ansiColor);
    const self = this;
    this[levelName.toLowerCase()] = function (msg, modulePath) {
      self._log(levelNum, levelName, msg, modulePath);
    };
    this.level = Math.min(this.level, levelNum);
  }

  _log(levelNum, levelName, msg, modulePath) {
    if (levelNum < this.level) return;
    const formatted = this.formatter.format(levelName, msg, modulePath);
    try {
      fs.appendFileSync(this.logFile, formatted + "\n", "utf-8");
    } catch {
      // ignore
    }
    if (this.transporter) {
      try {
        this.transporter.emit(levelName, msg, modulePath);
      } catch (error) {
        console.error("[LogMachine] transporter emit error:", error.message || error);
      }
    }
  }

  parseLog(logText) {
    const ansiEscape = /\x1b\[[0-9;]*m/g;
    const endEscape = /🏁/g;
    const clean = (logText || "").trim().replace(ansiEscape, "");

    const headerPattern = /\((.*?) @ (.*?)\) 🤌 CL Timing: \[ (.*?) \]/;
    const headerMatch = clean.match(headerPattern);
    if (!headerMatch) return null;

    const [, user, module, timestamp] = headerMatch;
    const lines = clean.split("\n");
    const levelLine = lines.slice(1).join(" ").trim();
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
    try {
      const content = fs.readFileSync(this.logFile, "utf-8");
      const logLines = content.split("\n🏁\n");
      const entries = [];
      for (const line of logLines) {
        if (!line.trim()) continue;
        const entry = this.parseLog(line);
        if (entry) entries.push(JSON.stringify(entry));
      }
      return entries;
    } catch {
      return [];
    }
  }
}

const defaultLogger = new LogMachine("default_logger", {
  debug_level: 0,
  verbose: false,
  central: { url: "https://api.logmachine.org" },
});

export { LogMachine, defaultLogger };
