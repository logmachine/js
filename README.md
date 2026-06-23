# 🧠 LogMachine (JavaScript)

> Collaborative, beautiful logging system for distributed developers

**logmachine** helps teams log smarter. It's a fully pluggable logging system that supports colored output, JSON parsing, structured log forwarding via **HTTP or Socket.IO**, and log centralization — all from a simple JavaScript interface.

Works in **Node.js** and **browsers** with a single codebase!

---

## 🚀 Features

- 🔥 **Color-coded console logs** (DEBUG, INFO, WARNING, ERROR, SUCCESS)
- 📤 **Log forwarding** to a central HTTP or Socket.IO server
- 🪵 **Custom log levels** (add your own with `.addLevel(...)`)
- 👥 **User identity tracking** for team-based logs
- 🧩 **Pluggable backends**: send logs to a central server or local files
- 📦 **Simple JSON output** for web dashboards or collectors
- 🧽 Strips ANSI escape codes from logs for clean parsing
- 🌐 **Dual runtime support**: Node.js and browser environments
- 🧠 Automatically persists usernames and auth tokens for central logging

---

## ⚙️ Installation

### Node.js

```bash
npm install @bufferpunk/logmachine
```

or using ES modules:

```javascript
import { LogMachine, defaultLogger } from '@bufferpunk/logmachine';
```

### Browser

Include the UMD bundle in your HTML:

```html
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script src="browsers.umd.js"></script>
```

The bundle exposes `window.LogMachine` and `window.defaultLogger` globally.

---

## 🧰 Usage

### Basic Setup (Node.js)

```javascript
import { LogMachine } from '@bufferpunk/logmachine';

const logger = new LogMachine('myapp', { debug_level: 0 });

logger.info('Hello, world!');
logger.error('An error occurred!');
logger.success('Operation completed successfully!');
logger.debug('Debugging information here.');
logger.warning('This is a warning message.');
```

### Basic Setup (Browser)

```html
<script>
  // Use the default logger
  defaultLogger.info('Hello from the browser');

  // Or create your own instance
  const lm = new LogMachine('my_logger', {
    debug_level: 0,
    central: {
      url: 'https://logmachine.org',
      room: 'public',
    },
  });

  lm.success('All green!', window.location.pathname);
  lm.error('Something went wrong', window.location.pathname);
</script>
```

### With Central Logging (HTTP or Socket.IO)

You can use the default logger with central logging pointing to the public LogMachine server:

```javascript
import { defaultLogger } from '@bufferpunk/logmachine';

const logger = defaultLogger;
logger.info('This log is sent to the LogMachine central server!');
```

Or configure your own central server:

```javascript
const logger = new LogMachine('with_central', {
  debug_level: 0,
  central: {
    url: 'https://your-server.com',      // Base server URL
    room: 'team_alpha',                   // Your organization or room
    endpoint: '/api/logs',                // Optional, defaults to /api/logs
    headers: { 'Authorization': 'Bearer token' },
    socketio: true,                       // Use Socket.IO instead of HTTP
    socketio_path: '/api/socket.io/',     // Optional
    withCredentials: false,               // Optional CORS
  },
});

logger.success('Central logging is working!');
```

---

## 🎨 Log Format

Every log includes:

* ✅ Username (resolved automatically or via server)
* 📁 Module directory (from file path)
* ⏱️ ISO timestamp
* 📦 Level (INFO, ERROR, etc.)
* 📝 Message

### Console Output (with colors):

```
(username @ myapp) 🤌 CL Timing: [ 2025-08-04T11:23:52.123Z ]
[ INFO ] Server started on port 8000
🏁
```

### Browser Console (with CSS styling):

Same format but styled with color-coded log levels for better visibility.

---

## 🛠️ Advanced

### Add Your Own Log Level

```javascript
logger.addLevel('CRITICAL_HACK', 60, '#ff00ff');
logger.critical_hack('Zero day found!');
```

### Debug Levels

Control which log levels are displayed using `debug_level`:

| Level | Includes |
|-------|----------|
| 0 | All (default) |
| 1 | ERROR only |
| 2 | SUCCESS only |
| 3 | WARNING only |
| 4 | INFO only |
| 5 | ERROR, WARNING |
| 6 | INFO, SUCCESS |
| 7 | ERROR, WARNING, INFO |

```javascript
const logger = new LogMachine('app', { debug_level: 3 });
logger.warning('This will show');
logger.info('This will not show');
```

---

## 📤 Parse & Export

### Convert Logs to JSON (Node.js)

```javascript
const jsonLogs = logger.jsonifier();
jsonLogs.forEach(entry => console.log(entry));
```

### Convert Logs to JSON (Browser)

```javascript
const jsonLogs = logger.jsonifier();
console.log(jsonLogs);
```

Each JSON entry has this structure:

```json
{
  "user": "username",
  "module": "moduleName",
  "level": "INFO",
  "timestamp": "2025-08-04T11:23:52.123Z",
  "message": "Server started on port 8000"
}
```

### Download Logs (Browser only)

```javascript
logger.download('my-logs.txt');
```

---

## 🔌 Transport Backends

### HTTP Transport (default)

Sends logs via HTTP POST to your central server:

```javascript
const logger = new LogMachine('app', {
  central: {
    url: 'https://logmachine.org',
    room: 'public',
    endpoint: '/api/logs',
  },
});
```

### Socket.IO Transport

For real-time log streaming via WebSocket:

```javascript
const logger = new LogMachine('app', {
  central: {
    url: 'https://logmachine.org',
    room: 'public',
    socketio: true,
    socketio_path: '/api/socket.io/',
  },
});
```

---

## 📡 Central Server Compatibility

To use Socket.IO, your central server must support these events:

* `log`: Receives log payloads: `{ room: string, data: object }`

For HTTP, implement:

* `POST /api/logs?room=<room>`: Accepts JSON log payload
* `POST /api/auth/device/start`: Starts device-flow login and returns `device_code`, `user_code`, `verification_uri_complete`, and `interval`
* `POST /api/auth/device/poll`: Polls device-flow status and returns `approved`, `expired`, or a token payload
* `GET /api/auth/session`: Returns the logged-in session user so the SDK can sync `lm_username`

---

## 🤖 Environment Variables

* `lm_username`: Persisted username used by formatters and central logging
* `lm_auth_token`: Bearer token used for central requests when `Authorization` is not already set
* `lm_expiry`: RFC3339 token expiry used to decide whether a cached login is still valid
* `LM_API_KEY` / `lm_api_key`: Optional API key used by `logger.login(...)`
* Browser fallback: `localStorage.lm_username`, `localStorage.lm_auth_token`, and `localStorage.lm_expiry`
* Node.js stores these values in `~/.logmachine`

The JS SDK now follows the same auth flow as the Python SDK:

* `login(timeoutSeconds, apiKey)` uses a direct API key when available, otherwise falls back to device-flow login.
* `logout()` clears the persisted credentials.
* Central requests merge `lm_auth_token` into headers only when `Authorization` is not already set.
* After login, the SDK attempts to sync `lm_username` from `/api/auth/session`.

---

## 🔐 Security

* HTTP headers (e.g. `Authorization`) can be injected; if omitted, `lm_auth_token` is used automatically
* Central log transmission is fully customizable
* Browser credentials can be controlled via `credentials` and `withCredentials` options

---

## 🔧 Configuration Reference

| Param | Type | Description |
|-------|------|-------------|
| `url` | `string` | Central server base URL |
| `room` | `string` | Logical group or org name |
| `endpoint` | `string` | HTTP endpoint for POST logs (default: `/api/logs`) |
| `headers` | `object` | Extra headers (e.g. auth token) |
| `socketio` | `boolean` | Use Socket.IO instead of HTTP |
| `socketio_path` | `string` | Path to socket.io on server |
| `credentials` | `string` | Fetch credentials mode (default: `omit`) |
| `withCredentials` | `boolean` | CORS credentials (browser) |
| `auth` | `object` | Socket.IO authentication |
| `debug_level` | `number` | Filter log levels (0-7) |
| `verbose` | `boolean` | Enable verbose output |

---

## 🔄 LogMachine Instance Options

```javascript
new LogMachine(name, {
  debug_level: 0,           // 0-7, controls which levels to display
  verbose: false,           // Extra output
  central: { ... },         // Central server config
  log_file: 'logs.log',     // Node.js: log file path
  error_file: 'errors.log', // Node.js: error-only log file
})
```

---

## 📚 Examples

### Example 1: Simple Local Logging

```javascript
import { LogMachine } from '@bufferpunk/logmachine';

const logger = new LogMachine('myapp');
logger.info('Application started');
logger.debug('Debug info');
logger.warning('Be careful!');
```

### Example 2: Centralized Team Logging

```javascript
import { LogMachine } from '@bufferpunk/logmachine';

const logger = new LogMachine('production', {
  central: {
    url: 'https://logs.example.com',
    room: 'team_alpha',
    headers: {
      'Authorization': 'Bearer secret-token-123',
    },
  },
});

logger.info('Deployment started');
logger.success('All checks passed');
```

### Example 3: Browser + Socket.IO

```html
<script src="https://cdn.socket.io/4.7.5/socket.io.min.js"></script>
<script src="browsers.umd.js"></script>
<script>
  const lm = new LogMachine('web_app', {
    central: {
      url: 'https://logs.example.com',
      room: 'frontend',
      socketio: true,
    },
  });

  document.addEventListener('error', (event) => {
    lm.error(`JavaScript error: ${event.message}`);
  });

  lm.info('Page loaded');
</script>
```

---

## 📄 License

MIT License

---

## 🙋‍♂️ Author

Mugabo Gusenga
[logmachine.org](https://logmachine.org)
[GitHub](https://github.com/logmachine)

---

## ❤️ Contribute

PRs and issues are welcome!
This tool is built for devs who want **beautiful logs with distributed brains**.
Let's make debugging fun again.
