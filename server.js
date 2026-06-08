const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024, // 5MB max message size (for base64 images)
});

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, "public", "canvas-data.json");

// Storage for all drawing actions
let canvasActions = [];

// API endpoint that returns current actions from server memory (not from file cache)
app.get("/api/actions", (req, res) => {
  res.json(canvasActions);
});

// Force immediate flush to disk
app.post("/api/flush", (req, res) => {
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

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith("canvas-data.json")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  },
}));

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
  // Cancel any pending deferred save and write immediately
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    saveTimeout = null;
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(canvasActions), "utf-8");
    console.log(`Flushed ${canvasActions.length} actions to file before shutdown (${signal})`);
  } catch (err) {
    console.error("Error flushing canvas data on shutdown:", err.message);
  }
  process.exit(0);
}

// SIGTERM – sent by pm2 stop / systemctl stop / docker stop
process.on("SIGTERM", () => flushAndExit("SIGTERM"));

// SIGINT – Ctrl+C in terminal
process.on("SIGINT", () => flushAndExit("SIGINT"));

// SIGUSR2 – sent by nodemon / pm2 reload in some configurations
process.on("SIGUSR2", () => flushAndExit("SIGUSR2"));

io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Send full canvas state to the new user
  socket.emit("init", { actions: canvasActions });

  // Handle drawing action
  socket.on("draw", (data) => {
    if (!data.id) {
      data.id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    if (!data.time) {
      data.time = Date.now();
    }
    canvasActions.push(data);
    socket.broadcast.emit("draw", data);
    saveCanvasData();
  });

  // Handle image action
  socket.on("image", (data) => {
    if (!data.id) {
      data.id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    if (!data.time) {
      data.time = Date.now();
    }
    canvasActions.push(data);
    socket.broadcast.emit("image", data);
    saveCanvasData();
  });

  // Handle text action
  socket.on("text", (data) => {
    if (!data.id) {
      data.id =
        Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    }
    if (!data.time) {
      data.time = Date.now();
    }
    canvasActions.push(data);
    socket.broadcast.emit("text", data);
    saveCanvasData();
  });

  // Handle clear canvas
  socket.on("clear", () => {
    canvasActions = [];
    io.emit("clear");
    saveCanvasData();
  });

  // Handle undo - remove action by ID
  socket.on("undo", (data) => {
    const index = canvasActions.findIndex((a) => a.id === data.id);
    if (index !== -1) {
      const removed = canvasActions.splice(index, 1)[0];
      socket.broadcast.emit("undo", { action: removed, id: data.id });
      saveCanvasData();
    }
  });

  // Handle redo - re-add a previously removed action
  socket.on("redo", (data) => {
    if (data.action) {
      canvasActions.push(data.action);
      socket.broadcast.emit("redo", data);
      saveCanvasData();
    }
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});