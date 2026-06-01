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
const DATA_FILE = path.join(__dirname, "canvas-data.json");

app.use(express.static(path.join(__dirname, "public")));

// Storage for all drawing actions
let canvasActions = [];

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

// Debounced save to file
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
  }, 2000);
}

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
