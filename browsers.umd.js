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
  } else if (typeof exports === 'object') {
    exports.LogMachine = factory().LogMachine;
    exports.defaultLogger = factory().defaultLogger;
  } else {
    root.LogMachine = factory().LogMachine;
    root.defaultLogger = factory().defaultLogger;
  }
}(typeof self !== 'undefined' ? self : (typeof global !== 'undefined' ? global : (typeof globalThis !== 'undefined' ? globalThis : this)), function () {
  'use strict';

  var LM_DEFAULT_FMT = '({username} @ \x1b[33m{module}\x1b[0m) 🤌 CL Timing: {color}[ {timestamp} ]\x1b[0m\n{level} {message}\n🏁';

  function getLogin() {
    try {
      var stored = typeof localStorage !== 'undefined' ? localStorage.getItem("lm_username") : null;
      if (stored) return stored;
    } catch (e) { /* ignore */ }
    if (typeof navigator !== 'undefined') {
      var base = (navigator.userAgentData?.platform || navigator.platform) || "web";
      return (typeof base === "string" ? base.toLowerCase() : "web") || "unknown";
    }
    return "unknown";
  }

  function ls() {
    try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch (e) { return null; }
  }

  function loadLMCreds() {
    try {
      var storage = ls();
      if (!storage) return {};
      var creds = {};
      var raw = storage.getItem('lm_creds');
      if (raw) {
        try { creds = JSON.parse(raw) || {}; } catch (e) { creds = {}; }
      }
      if (!creds.lm_username && storage.getItem('lm_username')) creds.lm_username = storage.getItem('lm_username');
      if (!creds.lm_auth_token && storage.getItem('lm_auth_token')) creds.lm_auth_token = storage.getItem('lm_auth_token');
      if (!creds.lm_expiry && storage.getItem('lm_expiry')) creds.lm_expiry = storage.getItem('lm_expiry');
      return creds;
    } catch (e) {
      return {};
    }
  }

  function persistLMCreds(username, authToken, expiry) {
    var storage = ls();
    var current = loadLMCreds();
    if (username) {
      current.lm_username = username;
      if (storage) storage.setItem('lm_username', username);
      if (typeof window !== 'undefined') window.lm_username = username;
    }
    if (authToken) {
      current.lm_auth_token = authToken;
      if (storage) storage.setItem('lm_auth_token', authToken);
      if (typeof window !== 'undefined') window.lm_auth_token = authToken;
    }
    if (expiry) {
      current.lm_expiry = expiry;
      if (storage) storage.setItem('lm_expiry', expiry);
    }
    if (storage) {
      try { storage.setItem('lm_creds', JSON.stringify(current)); } catch (e) { /* ignore */ }
    }
  }

  function authHeaders(headers) {
    var merged = Object.assign({}, headers || {});
    var hasAuth = Object.keys(merged).some(function(k){ return k.toLowerCase() === 'authorization'; });
    if (!hasAuth) {
      var storage = ls();
      var token = (typeof window !== 'undefined' && window.lm_auth_token) || (storage && storage.getItem('lm_auth_token')) || '';
      if (token) merged['Authorization'] = 'Bearer ' + token;
    }
    return merged;
  }

  async function sdkLoginViaDeviceFlow(centralUrl, timeoutSeconds) {
    timeoutSeconds = timeoutSeconds || 180;
    var startUrl = (centralUrl || '').replace(/\/$/, '') + '/api/auth/device/start';
    var startResponse = await fetch(startUrl, { method: 'POST' });
    if (!startResponse.ok) {
      throw new Error('Failed to start device login flow: ' + (await startResponse.text()));
    }

    var payload = await startResponse.json();
    var deviceCode = payload.device_code;
    var verificationUriComplete = payload.verification_uri_complete;
    var userCode = payload.user_code;
    var interval = Math.max(parseInt(payload.interval || 3, 10), 1);

    if (!deviceCode || !verificationUriComplete) {
      throw new Error('Device flow did not return the required login details');
    }

    var webBase = (centralUrl || '').replace(/\/$/, '');
    if (webBase.endsWith('/api')) {
      webBase = webBase.slice(0, -4);
    }

    var fallbackUrl = verificationUriComplete;
    if (!fallbackUrl.startsWith('http')) {
      fallbackUrl = webBase + '/' + verificationUriComplete.replace(/^\//, '');
    }

    try { window.open(fallbackUrl, '_blank', 'noopener,noreferrer'); } catch (e) { /* ignore */ }

    console.log('To authenticate this device:');
    console.log('  1) Open: ' + verificationUriComplete);
    console.log('  2) Enter code: ' + (userCode || '(if not auto-filled)'));
    console.log('\x1b[1mNOTE: For a better experience, use an API KEY\x1b[0m\n');

    var startedAt = Date.now();
    var pollUrl = (centralUrl || '').replace(/\/$/, '') + '/api/auth/device/poll';

    while (Date.now() - startedAt < timeoutSeconds * 1000) {
      var response = await fetch(pollUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: deviceCode })
      });
      if (!response.ok) {
        throw new Error('Device login polling failed: ' + (await response.text()));
      }

      var result = await response.json();
      if (result.status === 'approved') {
        console.log('Device login approved! Finalizing authentication...');
        return {
          token: result.token,
          username: result.user && result.user.username,
          provider: result.provider,
          expires_in: result.expires_in
        };
      }
      if (result.status === 'expired') {
        throw new Error('Login code expired before authentication completed');
      }

      await new Promise(function(resolve){ setTimeout(resolve, interval * 1000); });
    }

    throw new Error('Timed out waiting for device login to complete');
  }

  function _formatTime(date, datefmt) {
    function pad(n) { return String(n).padStart(2, '0'); }
    var y = date.getFullYear();
    var M = pad(date.getMonth() + 1);
    var d = pad(date.getDate());
    var h = pad(date.getHours());
    var m = pad(date.getMinutes());
    var s = pad(date.getSeconds());

    if (datefmt === '%Y-%m-%dT%H:%M:%S' || !datefmt) {
      return y + '-' + M + '-' + d + 'T' + h + ':' + m + ':' + s;
    }

    var result = datefmt;
    result = result.replace(/%Y/g, String(y));
    result = result.replace(/%m/g, M);
    result = result.replace(/%d/g, d);
    result = result.replace(/%H/g, h);
    result = result.replace(/%M/g, m);
    result = result.replace(/%S/g, s);
    return result;
  }

  function CustomFormatter(fmt, datefmt) {
    this._fmt = fmt || LM_DEFAULT_FMT;
    this.datefmt = datefmt || '%Y-%m-%dT%H:%M:%S';
    this.COLORS = {
      DEBUG: '#06b6d4',
      INFO: '#3b82f6',
      WARNING: '#f59e0b',
      ERROR: '#ef4444',
      SUCCESS: '#22c55e',
      CRITICAL: '#ef4444'
    };
    this.LEVEL_COLORS_CSS = {
      DEBUG: '#06b6d4',
      INFO: '#3b82f6',
      WARNING: '#f59e0b',
      ERROR: '#ef4444',
      SUCCESS: '#22c55e',
      CRITICAL: '#ef4444'
    };
  }

  CustomFormatter.prototype.set_color = function (levelName, colorCode) {
    this.COLORS[levelName] = colorCode;
    this.LEVEL_COLORS_CSS[levelName] = colorCode;
  };

  CustomFormatter.prototype.format = function (level, message, modulePath) {
    var username = (typeof window !== 'undefined' && window.lm_username) || getLogin();
    var timestamp = _formatTime(new Date(), this.datefmt);
    var parentDir = 'stdin';
    if (modulePath && modulePath !== '<stdin>') {
      try {
        var parts = ('' + modulePath).split('/');
        parentDir = parts.length > 1 ? parts[Math.max(0, parts.length - 2)] : parts[0];
      } catch (e) { parentDir = 'stdin'; }
    }

    var color = this.COLORS[level] || '#9ca3af';
    var head = '(' + username + ' @ ' + parentDir + ') 🤌 CL Timing: [ ' + timestamp + ' ]';
    var levelTag = '[ ' + level + ' ]';
    var body = levelTag + ' ' + message;
    var end = '🏁';
    var text = head + '\n' + body + '\n' + end;

    var headStyle = 'color:#9ca3af;font-weight:600';
    var tagStyle = 'color:' + color + ';font-weight:700';
    var msgStyle = 'color:#e5e7eb';
    var dimStyle = 'color:#6b7280';
    var consoleText = '%c' + head + '\n%c' + levelTag + '%c ' + message + '\n%c' + end;
    var consoleArgs = [headStyle, tagStyle, msgStyle, dimStyle];

    return { text: text, consoleText: consoleText, consoleArgs: consoleArgs };
  };

  function SocketIOTransporter(opts) {
    this.central = opts.central || null;
    this.formatter = null;
    this.sio = null;

    if (typeof window !== 'undefined' && typeof window.io === 'function' && this.central && this.central.url) {
      try {
        var ioOpts = {
          path: this.central.endpoint || '/api/socket.io/',
          auth: window.lm_auth_token ? { token: window.lm_auth_token } : undefined,
        };
        this.sio = window.io(this.central.url, ioOpts);
        this.sio.emit('join', { room: this.central.room });
        this.sio.on('log', this._onLog.bind(this));
        this.sio.on('error', function (err) { console.error(err); });
      } catch (e) {
        console.warn('[LogMachine] socket.io client init failed:', e && e.message ? e.message : e);
        this.sio = null;
      }
    }
  }

  SocketIOTransporter.prototype._onLog = function (data) {
    if (!this.formatter) return;
    var level = data.level ? data.level.toUpperCase() : 'INFO';
    var module = (data.module || 'unknown') + ' :external';
    var fmt = this.formatter.format(level, data.message || '', module);
    console.log(fmt.consoleText, ...fmt.consoleArgs);
  };

  SocketIOTransporter.prototype.emit = function (level, msg, modulePath) {
    try {
      var fmt = this.formatter.format(level, msg, modulePath);
      console.log(fmt.consoleText, ...fmt.consoleArgs);

      if (this.central && this.central.room && this.sio && this.sio.connected) {
        this.sio.emit('log', {
          room: this.central.room,
          data: {
            user: getLogin(),
            module: modulePath || 'stdin',
            level: level,
            timestamp: _formatTime(new Date(), this.formatter.datefmt),
            message: msg
          }
        });
      }
    } catch (err) {
      console.error('SocketIOTransporter error:', err && err.message ? err.message : err);
    }
  };

  SocketIOTransporter.prototype.close = function () {
    try {
      if (this.sio && this.sio.connected) {
        this.sio.disconnect();
      }
    } catch (e) { /* ignore */ }
  };

  var LEVEL_MAP = {
    DEBUG: 10,
    INFO: 20,
    SUCCESS: 25,
    WARNING: 30,
    ERROR: 40,
    CRITICAL: 50
  };

  function LogMachine(name, options) {
    options = options || {};
    this.name = name || 'logmachine';
    this.level = LEVEL_MAP[options.level] || LEVEL_MAP.DEBUG;
    this.central = options.central || null;
    this.formatter = new CustomFormatter(options.log_format || options.format, options.datefmt);
    this.buffer = [];
    this.errorBuffer = [];

    if (this.central) {
      this.transporter = new SocketIOTransporter({ central: this.central });
      this.transporter.formatter = this.formatter;
      if (!this.central.room) {
        this.central.room = getLogin();
      }
      this.login(options.timeout_seconds || 180, options.api_key || this.central.API_KEY || this.central.api_key).catch(function () {});
    } else {
      this.transporter = null;
    }
  }

  LogMachine.prototype._syncIdentityFromSession = async function () {
    var storage = ls();
    if (!this.central || !this.central.url || !storage || !storage.getItem('lm_auth_token')) return;
    try {
      var sessionUrl = (this.central.url || '').replace(/\/$/, '') + '/api/auth/session';
      var resp = await fetch(sessionUrl, { method: 'GET', headers: authHeaders(this.central.headers || {}), credentials: this.central.credentials || 'omit' });
      if (!resp.ok) return;
      var payload = await resp.json().catch(function(){ return {}; });
      var username = payload && payload.user && payload.user.username;
      if (username) {
        var token = storage.getItem('lm_auth_token') || '';
        persistLMCreds(username, token, '');
      }
    } catch (e) { /* ignore */ }
  };

  LogMachine.prototype.login = async function (timeoutSeconds, apiKey) {
    timeoutSeconds = timeoutSeconds || 180;
    if (!this.central || !this.central.url) {
      throw new Error("Login requires central logging configuration with a 'url'.");
    }

    var storage = ls();
    var directApiKey = apiKey || this.central.API_KEY || this.central.api_key || (storage && storage.getItem('LM_API_KEY')) || (storage && storage.getItem('lm_api_key'));
    if (directApiKey) {
      persistLMCreds('', directApiKey, '');
      this.central.headers = this.central.headers || {};
      if (!Object.keys(this.central.headers).some(function(k){ return k.toLowerCase() === 'authorization'; })) {
        this.central.headers.Authorization = 'Bearer ' + directApiKey;
      }
      await this._syncIdentityFromSession();
      return this;
    }

    if (this.central.headers && Object.keys(this.central.headers).some(function(k){ return k.toLowerCase() === 'authorization'; })) {
      await this._syncIdentityFromSession();
      return this;
    }

    if (storage && storage.getItem('lm_auth_token') && storage.getItem('lm_expiry')) {
      var expiry = Date.parse(storage.getItem('lm_expiry'));
      if (!Number.isNaN(expiry) && expiry > Date.now()) {
        await this._syncIdentityFromSession();
        return this;
      }
    }

    var result = await sdkLoginViaDeviceFlow(this.central.url, timeoutSeconds);
    if (!result.token) {
      throw new Error('Login completed without an auth token.');
    }

    var expiryText = result.expires_in ? new Date(Date.now() + (Number(result.expires_in) * 1000)).toISOString() : '';
    persistLMCreds(result.username || '', result.token, expiryText);
    this.central.headers = this.central.headers || {};
    if (!Object.keys(this.central.headers).some(function(k){ return k.toLowerCase() === 'authorization'; })) {
      this.central.headers.Authorization = 'Bearer ' + result.token;
    }
    await this._syncIdentityFromSession();
    return this;
  };

  LogMachine.prototype.logout = function () {
    if (this.central) {
      persistLMCreds('', '', '');
      if (this.central.headers) {
        var filtered = {};
        Object.keys(this.central.headers).forEach(function(key) {
          if (key.toLowerCase() !== 'authorization') filtered[key] = this.central.headers[key];
        }, this);
        this.central.headers = filtered;
      }
    }
    console.log('Logged out and cleared credentials.');
  };

  LogMachine.prototype.log = function (level, msg, modulePath) {
    modulePath = modulePath || (typeof window !== 'undefined' ? window.location.pathname || '<stdin>' : '<stdin>');
    var levelNum = LEVEL_MAP[level];
    if (levelNum && levelNum < this.level) return;

    var fmt = this.formatter.format(level, msg, modulePath);
    this.buffer.push(fmt.text);
    if (level === 'ERROR') this.errorBuffer.push(fmt.text);

    if (this.transporter && typeof this.transporter.emit === 'function') {
      try {
        this.transporter.emit(level, msg, modulePath);
      } catch (e) {
        console.error('[LogMachine] transporter emit error:', e && e.message ? e.message : e);
      }
    }
  };

  LogMachine.prototype.debug = function (msg, modulePath) { this.log('DEBUG', msg, modulePath); };
  LogMachine.prototype.info = function (msg, modulePath) { this.log('INFO', msg, modulePath); };
  LogMachine.prototype.warning = function (msg, modulePath) { this.log('WARNING', msg, modulePath); };
  LogMachine.prototype.error = function (msg, modulePath) { this.log('ERROR', msg, modulePath); };
  LogMachine.prototype.success = function (msg, modulePath) { this.log('SUCCESS', msg, modulePath); };

  LogMachine.prototype.new_level = function (levelName, levelNum, ansiColor) {
    ansiColor = ansiColor || '#ffffff';
    if (levelNum) {
      for (var key in LEVEL_MAP) {
        if (LEVEL_MAP[key] === levelNum) {
          throw new Error("The level you're trying to declare already exists");
        }
      }
    }
    LEVEL_MAP[levelName] = levelNum;
    this.formatter.set_color(levelName, ansiColor);
    var self = this;
    this[levelName.toLowerCase()] = function (msg, modulePath) {
      self._log(levelNum, levelName, msg, modulePath);
    };
    this.level = Math.min(this.level, levelNum);
  };

  LogMachine.prototype._log = function (levelNum, levelName, msg, modulePath) {
    modulePath = modulePath || (typeof window !== 'undefined' ? window.location.pathname || '<stdin>' : '<stdin>');
    if (levelNum < this.level) return;

    var fmt = this.formatter.format(levelName, msg, modulePath);
    this.buffer.push(fmt.text);
    if (levelName === 'ERROR') this.errorBuffer.push(fmt.text);

    if (this.transporter && typeof this.transporter.emit === 'function') {
      try {
        this.transporter.emit(levelName, msg, modulePath);
      } catch (e) {
        console.error('[LogMachine] transporter emit error:', e && e.message ? e.message : e);
      }
    }
  };

  LogMachine.prototype.parseLog = function (logText) {
    logText = (logText || '').trim();
    var headerPattern = /\((.*?) @ (.*?)\) 🤌 CL Timing: \[ (.*?) \]/;
    var headerMatch = logText.match(headerPattern);
    if (!headerMatch) return null;
    var user = headerMatch[1], module = headerMatch[2], timestamp = headerMatch[3];
    var lines = logText.split('\n');
    var levelLine = lines.slice(1).join(' ').trim();
    var levelMatch = levelLine.match(/\[\s?(\w+)\s?\]\s?(.*)/);
    var level = levelMatch ? levelMatch[1] : 'UNKNOWN';
    var message = levelMatch ? levelMatch[2] : '';
    return {
      user: user,
      module: module,
      level: (level || '').trim(),
      timestamp: timestamp,
      message: (message || '').replace(/🏁/g, '').trim()
    };
  };

  LogMachine.prototype.jsonifier = function () {
    var joined = this.buffer.join('\n');
    var parts = joined.split('\n🏁\n');
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
    name = name || 'logs.log';
    var content = this.buffer.join('\n') + '\n';
    try {
      var blob = new Blob([content], { type: 'text/plain' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () {
        URL.revokeObjectURL(a.href);
        document.body.removeChild(a);
      }, 1000);
    } catch (e) {
      console.error('[LogMachine] download failed:', e && e.message ? e.message : e);
    }
  };

  var defaultLogger = new LogMachine('default_logger', {
    debug_level: 0,
    verbose: false,
    central: {
      url: 'https://api.logmachine.org',
      headers: {}
    }
  });

  return { LogMachine: LogMachine, defaultLogger: defaultLogger };
}));
