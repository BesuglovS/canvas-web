/**
 * WebSocketManager - Handles Socket.IO communication with the server
 */
class WebSocketManager {
  constructor() {
    this.socket = io();
    this.setupListeners();
  }

  setupListeners() {
    // Initial data
    this.socket.on("init", (data) => {
      if (this.onInit) this.onInit(data.actions || []);
    });

    // Drawing events
    this.socket.on("draw", (data) => {
      if (this.onDraw) this.onDraw(data);
    });

    // Image events
    this.socket.on("image", (data) => {
      if (this.onImage) this.onImage(data);
    });

    // Transform events (move/resize image)
    this.socket.on("transform", (data) => {
      if (this.onTransform) this.onTransform(data);
    });

    // Text events
    this.socket.on("text", (data) => {
      if (this.onText) this.onText(data);
    });

    // Clear canvas event
    this.socket.on("clear", () => {
      if (this.onClear) this.onClear();
    });

    // Undo / Redo
    this.socket.on("undo", (data) => {
      if (this.onUndo) this.onUndo(data);
    });

    this.socket.on("redo", (data) => {
      if (this.onRedo) this.onRedo(data);
    });
  }

  sendDraw(data) {
    this.socket.emit("draw", data);
  }

  sendText(data) {
    this.socket.emit("text", data);
  }

  sendImage(data) {
    this.socket.emit("image", data);
  }

  sendTransform(data) {
    this.socket.emit("transform", data);
  }

  sendClear() {
    this.socket.emit("clear");
  }

  sendUndo(data) {
    this.socket.emit("undo", data);
  }

  sendRedo(data) {
    this.socket.emit("redo", data);
  }
}
