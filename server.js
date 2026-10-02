/**
 * Сервер совместного рисования «Выпуск 2026» (canvas.nayanovaacademy.ru).
 *
 * Безопасность:
 *  - HTTP-API и Socket.IO требуют авторизации по общей куке auth_session
 *    (SSO auth.nayanovaacademy.ru). Проверка — через same-host PHP-эндпоинт
 *    /sandbox/auth_check.php, который валидирует cookie.
 *  - каждое действие помечается user_id автора;
 *  - undo — только своих действий; clear — только администратор;
 *  - /api/flush — только администратор;
 *  - ограничения на размер и количество действий + rate-limit.
 */

const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "public", "canvas-data.json");
const AUTH_CHECK_URL =
  process.env.CANVAS_AUTH_CHECK_URL ||
  "https://canvas.nayanovaacademy.ru/sandbox/auth_check.php";
const AUTH_CHECK_INSECURE =
  (process.env.CANVAS_AUTH_CHECK_INSECURE || "1") === "1";

// ─── Лимиты ───
const MAX_ACTIONS = 5000;                     // всего действий в истории
const MAX_ACTIONS_PER_USER = 1000;            // действий на одного пользователя
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;      // ~2 МБ base64 на изображение
const RATE_WINDOW_MS = 10000;                 // окно rate-limit
const RATE_MAX_EVENTS = 120;                  // событий за окно на соединение

const io = new Server(server, {
  maxHttpBufferSize: 3 * 1024 * 1024,         // 3 МБ на сообщение
});

// Storage for all drawing actions
let canvasActions = [];

// ─── Проверка SSO-сессии через PHP (same host, server-to-server) ───
function checkSession(cookieHeader) {
  return new Promise((resolve) => {
    if (!cookieHeader) return resolve(null);
    const u = new URL(AUTH_CHECK_URL);
    const lib = u.protocol === "https:" ? require("https") : require("http");
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: u.pathname + u.search,
        method: "GET",
        headers: { Cookie: cookieHeader, Host: u.hostname },
        timeout: 4000,
        rejectUnauthorized: u.protocol === "https:" ? !AUTH_CHECK_INSECURE : true,
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(body);
            resolve(data && data.authenticated ? data : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

// ─── Обрезка/лимиты действия ───
function sanitizeIncoming(raw, userId) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type;
  if (type !== "stroke" && type !== "image" && type !== "text") return null;

  if (type === "image") {
    if (typeof raw.data !== "string") return null;
    if (raw.data.length > MAX_IMAGE_BYTES) return null;
  }
  if (type === "stroke") {
    if (!Array.isArray(raw.points)) return null;
    if (raw.points.length > 20000) raw.points = raw.points.slice(0, 20000);
  }
  if (type === "text") {
    if (typeof raw.text !== "string") return null;
    if (raw.text.length > 2000) raw.text = raw.text.slice(0, 2000);
  }

  const received = Date.now();
  return {
    id:
      typeof raw.id === "string" && raw.id
        ? raw.id
        : crypto.randomBytes(8).toString("hex"),
    type,
    tool: raw.tool,
    color: raw.color,
    size: raw.size,
    points: raw.points,
    text: raw.text,
    x: raw.x,
    y: raw.y,
    width: raw.width,
    height: raw.height,
    data: raw.data,
    username: typeof raw.username === "string" ? raw.username.slice(0, 100) : undefined,
    user_id: userId,
    time: received,
  };
}

function authorOf(action) {
  return action && action.user_id != null ? String(action.user_id) : null;
}

// ─── Авторизация HTTP-API ───
function requireAuth(req, res, next) {
  checkSession(req.headers.cookie || "").then((user) => {
    if (!user) {
      res.status(401).json({ ok: false, error: "unauthorized" });
      return;
    }
    req.user = user;
    next();
  });
}

function requireAdmin(req, res, next) {
  checkSession(req.headers.cookie || "").then((user) => {
    if (!user || !user.is_admin) {
      res.status(403).json({ ok: false, error: "forbidden" });
      return;
    }
    req.user = user;
    next();
  });
}

// API endpoint that returns current actions from server memory (not from file cache)
app.get("/api/actions", requireAuth, (req, res) => {
  res.json(canvasActions);
});

// Force immediate flush to disk — только администратор
app.post("/api/flush", requireAdmin, (req, res) => {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(canvasActions), "utf-8");
    console.log(`Manual flush: saved ${canvasActions.length} actions to file`);
    res.json({ ok: true, count: canvasActions.length });
  } catch (err) {
    console.error("Manual flush error:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.use(
  express.static(path.join(__dirname, "public"), {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith("canvas-data.json")) {
        res.setHeader(
          "Cache-Control",
          "no-store, no-cache, must-revalidate, proxy-revalidate",
        );
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
      }
    },
  }),
);

// Load saved data if exists
if (fs.existsSync(DATA_FILE)) {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf-8");
    canvasActions = JSON.parse(raw);
    console.log(`Loaded ${canvasActions.length} actions from save file`);
  } catch (err) {
    console.error("Error loading canvas data:", err.message);
    canvasActions = [];
  }
}

// Save to file (immediate write with small coalescing window to batch rapid actions)
let saveTimeout = null;
function saveCanvasData() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(canvasActions), "utf-8");
      console.log(`Saved ${canvasActions.length} actions to file`);
    } catch (err) {
      console.error("Error saving canvas data:", err.message);
    }
  }, 200);
}

// --- Graceful shutdown: flush in-memory data to disk immediately ---
function flushAndExit(signal) {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(canvasActions), "utf-8");
    console.log(
      `Flushed ${canvasActions.length} actions to file before shutdown (${signal})`,
    );
  } catch (err) {
    console.error("Error flushing canvas data on shutdown:", err.message);
  }
  process.exit(0);
}

process.on("SIGTERM", () => flushAndExit("SIGTERM"));
process.on("SIGINT", () => flushAndExit("SIGINT"));
process.on("SIGUSR2", () => flushAndExit("SIGUSR2"));

// ─── Socket.IO: авторизация на handshake ───
io.use((socket, next) => {
  checkSession(socket.request.headers.cookie || "").then((user) => {
    if (!user) {
      next(new Error("unauthorized"));
      return;
    }
    socket.data.user = user;
    socket.data.rate = { windowStart: Date.now(), count: 0 };
    next();
  });
});

io.on("connection", (socket) => {
  const user = socket.data.user || {};
  const userId = user.user_id != null ? String(user.user_id) : null;
  const isAdmin = !!user.is_admin;
  console.log(`User connected: ${socket.id} (user_id=${userId}, admin=${isAdmin})`);

  socket.emit("init", { actions: canvasActions });

  function rateOk() {
    const now = Date.now();
    const r = socket.data.rate;
    if (now - r.windowStart > RATE_WINDOW_MS) {
      r.windowStart = now;
      r.count = 0;
    }
    r.count += 1;
    return r.count <= RATE_MAX_EVENTS;
  }

  function userActionCount() {
    if (userId == null) return 0;
    let n = 0;
    for (const a of canvasActions) if (authorOf(a) === userId) n += 1;
    return n;
  }

  function addAction(raw, eventName) {
    if (!rateOk()) return;
    if (canvasActions.length >= MAX_ACTIONS) return;
    if (userActionCount() >= MAX_ACTIONS_PER_USER) return;
    const action = sanitizeIncoming(raw, userId);
    if (!action) return;
    canvasActions.push(action);
    socket.broadcast.emit(eventName, action);
    saveCanvasData();
  }

  socket.on("draw", (data) => addAction(data, "draw"));
  socket.on("image", (data) => addAction(data, "image"));
  socket.on("text", (data) => addAction(data, "text"));

  // Перемещение/масштаб: применяем к своему действию (или админом/любому image/text).
  socket.on("transform", (data) => {
    if (!rateOk() || !data || typeof data.id !== "string") return;
    const action = canvasActions.find((a) => a.id === data.id);
    if (!action) return;
    if (!isAdmin && authorOf(action) !== userId) return;
    if (action.type !== "image" && action.type !== "text") return;
    action.x = data.x;
    action.y = data.y;
    action.width = data.width;
    action.height = data.height;
    socket.broadcast.emit("transform", {
      id: action.id,
      x: action.x,
      y: action.y,
      width: action.width,
      height: action.height,
    });
    saveCanvasData();
  });

  // Очистка холста — только администратор.
  socket.on("clear", () => {
    if (!isAdmin) return;
    canvasActions = [];
    io.emit("clear");
    saveCanvasData();
  });

  // Отмена — только своих действий.
  socket.on("undo", (data) => {
    if (!rateOk() || !data || typeof data.id !== "string") return;
    const index = canvasActions.findIndex((a) => a.id === data.id);
    if (index === -1) return;
    const action = canvasActions[index];
    if (!isAdmin && authorOf(action) !== userId) return;
    const removed = canvasActions.splice(index, 1)[0];
    socket.broadcast.emit("undo", { action: removed, id: data.id });
    saveCanvasData();
  });

  // Возврат (redo) — только своего действия.
  socket.on("redo", (data) => {
    if (!rateOk() || !data || typeof data !== "object") return;
    const raw = data.action;
    if (!raw || typeof raw !== "object") return;
    if (!isAdmin && authorOf(raw) !== userId) return;
    if (canvasActions.length >= MAX_ACTIONS) return;
    if (userActionCount() >= MAX_ACTIONS_PER_USER) return;
    const action = sanitizeIncoming(raw, userId);
    if (!action) return;
    canvasActions.push(action);
    socket.broadcast.emit("redo", { action });
    saveCanvasData();
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
