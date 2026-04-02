/*!
 * LogMachine UMD/IIFE browser bundle
 * Exposes: window.LogMachine, window.defaultLogger
 * Works with or without Socket.IO client on window.io
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LogMachine = factory().LogMachine;
    root.defaultLogger = factory().defaultLogger;
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --- Helper: Get "login" username (browser edition) ---
  function getLogin() {
    const stored = localStorage.getItem("CL_USERNAME");
    if (stored) return stored;
    const base = (navigator && (navigator.userAgentData?.platform || navigator.platform)) || "web";
    return (typeof base === "string" ? base.toLowerCase() : "web") || "unknown";
  }

  // --- Custom Formatter (console-css + plain-text) ---
  function CustomFormatter() {
    this.LEVEL_COLORS = {
      DEBUG: "#06b6d4",
      INFO: "#3b82f6",
      WARNING: "#f59e0b",
      ERROR: "#ef4444",
      SUCCESS: "#22c55e"
    };
  }

  CustomFormatter.prototype.format = function (level, message, modulePath) {
    var username = window.CL_USERNAME || getLogin();
    var timestamp = new Date().toISOString();
    var parentDir = "stdin";
    if (modulePath && modulePath !== "<stdin>") {
      try {
        var parts = ("" + modulePath).split('/');
        parentDir = parts.length > 1 ? parts[Math.max(0, parts.length - 2)] : parts[0];
      } catch (e) { parentDir = "stdin"; }
    }
    var levelTag = "[ " + level + " ]";
    var head = "(" + username + " @ " + parentDir + ") 🤌 CL Timing: [ " + timestamp + " ]";
    var body = levelTag + " " + message;
    var end = "🏁";

    var color = this.LEVEL_COLORS[level] || "#9ca3af";
    var headStyle = "color:#9ca3af;font-weight:600";
    var tagStyle = "color:" + color + ";font-weight:700";
    var msgStyle = "color:#e5e7eb";
    var dimStyle = "color:#6b7280";

    var consoleText = "%c" + head + "\n%c" + levelTag + "%c " + message + "\n%c" + end;
    var consoleArgs = [headStyle, tagStyle, msgStyle, dimStyle];

    var text = head + "\n" + levelTag + " " + message + "\n" + end;

    return { text: text, consoleText: consoleText, consoleArgs: consoleArgs };
  };

  // --- RequestsTransporter (fetch) ---
  function RequestsTransporter(opts) {
    this.parseLog = opts.logParser;
    this.central = opts.central || null;
  }
  RequestsTransporter.prototype.emit = async function (level, msg, modulePath) {
    try {
      var fmt = new CustomFormatter().format(level, msg, modulePath);
      console.log(fmt.consoleText, ...fmt.consoleArgs);

      if (this.central) {
        if (!this.central.room) {
          throw new Error("Central config must include 'room'. Example: { url, room }");
        }
        var logData = this.parseLog(fmt.text);
        if (logData) {
          var endpoint = (this.central.endpoint || "/api/logs");
          var url = (this.central.url || "") + endpoint + "?room=" + encodeURIComponent(this.central.room);
          var headers = Object.assign({ "Content-Type": "application/json" }, this.central.headers || {});
          var res = await fetch(url, {
            method: "POST",
            headers: headers,
            body: JSON.stringify(logData),
            credentials: this.central.credentials || "omit"
          });
          if (!res.ok) {
            var body = "";
            try { body = await res.text(); } catch (e) { /* ignore */ }
            throw new Error("Failed to send log: " + res.status + " " + body);
          }
        }
      }
    } catch (err) {
      console.error("Transporter error:", err && err.message ? err.message : err);
    }
  };

  // --- SocketIOTransporter (browser: uses window.io) ---
  function SocketIOTransporter(opts) {
    this.parseLog = opts.logParser;
    this.central = opts.central || null;
    this.sio = null;

    if (typeof window !== "undefined" && typeof window.io === "function" && this.central && this.central.url) {
      try {
        var ioOpts = {
          path: this.central.socketio_path || "/api/socket.io/",
          auth: this.central.auth || undefined,
          withCredentials: !!this.central.withCredentials
        };
        this.sio = window.io(this.central.url, ioOpts);
      } catch (e) {
        console.warn("[LogMachine] socket.io client init failed:", e && e.message ? e.message : e);
        this.sio = null;
      }
    } else {
      if (this.central && this.central.socketio) {
        console.warn("[LogMachine] socket.io requested but window.io not found – please include Socket.IO client.");
      }
    }
  }
  SocketIOTransporter.prototype.emit = function (level, msg, modulePath) {
    try {
      var fmt = new CustomFormatter().format(level, msg, modulePath);
      console.log(fmt.consoleText, ...fmt.consoleArgs);
      if (this.central && this.central.room && this.sio) {
        var data = this.parseLog(fmt.text);
        if (data) this.sio.emit("log", { room: this.central.room, data: data });
      }
    } catch (err) {
      console.error("SocketIOTransporter error:", err && err.message ? err.message : err);
    }
  };

  // --- Main LogMachine (browser) ---
  function LogMachine(name, options) {
    options = options || {};
    this.name = name || "logmachine";
    this.debugLevel = parseInt(options.debug_level || 0, 10) || 0;
    this.verbose = !!options.verbose;
    this.central = options.central || null;
    this.formatter = new CustomFormatter();
    this.buffer = [];
    this.errorBuffer = [];
    this.allowedMap = {
      1: ["ERROR"],
      2: ["SUCCESS"],
      3: ["WARNING"],
      4: ["INFO"],
      5: ["ERROR", "WARNING"],
      6: ["INFO", "SUCCESS"],
      7: ["ERROR", "WARNING", "INFO"]
    };

    if (this.central) {
      this._ensureUsername(this.central).finally(function () { /* noop */ });
      if (!options.attached && !this.central.socketio) {
        this.transporter = new RequestsTransporter({ logParser: this.parseLog.bind(this), central: this.central });
      } else {
        this.transporter = new SocketIOTransporter({ logParser: this.parseLog.bind(this), central: this.central });
      }
    } else {
      this.transporter = {
        emit: function (level, msg, modulePath) {
          var fmt = (new CustomFormatter()).format(level, msg, modulePath);
          console.log(fmt.consoleText, ...fmt.consoleArgs);
        }
      };
    }
  }

  LogMachine.prototype._ensureUsername = async function (central) {
    var key = "CL_USERNAME";
    if (!localStorage.getItem(key)) {
      try {
        var base = getLogin();
        var url = (central.url || "") + "/api/get_username?base=" + encodeURIComponent(base);
        var res = await fetch(url, { method: "GET", headers: central.headers || {}, credentials: central.credentials || "omit" });
        if (res && res.ok) {
          var data = {};
          try { data = await res.json(); } catch (e) {}
          var username = data && data.username ? data.username : "unknown";
          window.CL_USERNAME = username;
          localStorage.setItem(key, username);
        } else {
          window.CL_USERNAME = "unknown";
        }
      } catch (e) {
        window.CL_USERNAME = "unknown";
      }
    } else {
      window.CL_USERNAME = localStorage.getItem(key);
      window.CL_USERNAME = window.CL_USERNAME || "unknown";
    }
  };

  LogMachine.prototype.log = function (level, msg, modulePath) {
    modulePath = modulePath || (typeof window !== "undefined" ? window.location.pathname || "<stdin>" : "<stdin>");
    if (this.debugLevel !== 0 && !this.isAllowed(level)) return;

    var fmt = this.formatter.format(level, msg, modulePath);
    this.buffer.push(fmt.text);
    if (level === "ERROR") this.errorBuffer.push(fmt.text);

    if (this.transporter && typeof this.transporter.emit === "function") {
      try {
        this.transporter.emit(level, msg, modulePath);
      } catch (e) {
        console.error("[LogMachine] transporter emit error:", e && e.message ? e.message : e);
      }
    }
  };

  LogMachine.prototype.debug = function (msg, modulePath) { this.log("DEBUG", msg, modulePath); };
  LogMachine.prototype.info = function (msg, modulePath) { this.log("INFO", msg, modulePath); };
  LogMachine.prototype.warning = function (msg, modulePath) { this.log("WARNING", msg, modulePath); };
  LogMachine.prototype.error = function (msg, modulePath) { this.log("ERROR", msg, modulePath); };
  LogMachine.prototype.success = function (msg, modulePath) { this.log("SUCCESS", msg, modulePath); };

  LogMachine.prototype.addLevel = function (level, allow, color) {
    if (!level) throw new Error("level required");
    if (!this.formatter.LEVEL_COLORS) this.formatter.LEVEL_COLORS = {};
    if (this.formatter.LEVEL_COLORS[level]) throw new Error("Level exists");
    if (color) this.formatter.LEVEL_COLORS[level] = color;
    allow = allow || 0;
    if (!this.allowedMap[allow]) this.allowedMap[allow] = [];
    this.allowedMap[allow].push(level);
    var self = this;
    this[level.toLowerCase()] = function (msg, modulePath) { self.log(level, msg, modulePath); };
  };

  LogMachine.prototype.isAllowed = function (level) {
    var allowed = this.allowedMap[this.debugLevel] || [];
    return allowed.indexOf(level) !== -1;
  };

  LogMachine.prototype.parseLog = function (logText) {
    logText = (logText || "").trim();
    var headerPattern = /\((.*?) @ (.*?)\) 🤌 CL Timing: \[ (.*?) \]/;
    var headerMatch = logText.match(headerPattern);
    if (!headerMatch) return null;
    var user = headerMatch[1], module = headerMatch[2], timestamp = headerMatch[3];
    var lines = logText.split("\n");
    var levelLine = lines[1] || "";
    var levelMatch = levelLine.match(/\[\s?(\w+)\s?\]\s?(.*)/);
    var level = levelMatch ? levelMatch[1] : "UNKNOWN";
    var message = levelMatch ? levelMatch[2] : "";
    return {
      user: user,
      module: module,
      level: (level || "").trim(),
      timestamp: timestamp,
      message: (message || "").replace(/🏁/g, "").trim()
    };
  };

  LogMachine.prototype.jsonifier = function () {
    var joined = this.buffer.join("\n");
    var parts = joined.split("\n🏁\n");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var line = parts[i];
      if (line && line.trim()) {
        var e = this.parseLog(line);
        if (e) out.push(JSON.stringify(e));
      }
    }
    return out;
  };

  LogMachine.prototype.download = function (name) {
    name = name || "logs.log";
    var content = this.buffer.join("\n") + "\n";
    try {
      var blob = new Blob([content], { type: "text/plain" });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        document.body.removeChild(a);
      }, 1000);
    } catch (e) {
      console.error("[LogMachine] download failed:", e && e.message ? e.message : e);
    }
  };

  // --- defaultLogger ---
  var defaultLogger = new LogMachine("default_logger", {
    debug_level: 0,
    verbose: false,
    central: {
      url: "https://logmachine.bufferpunk.com",
      room: "public",
      headers: {}
    }
  });

  // Return exports
  return { LogMachine: LogMachine, defaultLogger: defaultLogger };
}));
