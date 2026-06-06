/**
 * RenderPlayer - Loads saved canvas actions and plays them back with speed control,
 * progress tracking, and video recording.
 */
class RenderPlayer {
  constructor() {
    // Canvas setup
    this.container = document.getElementById("canvas-container");
    this.canvas = document.getElementById("draw-canvas");
    this.ctx = this.canvas.getContext("2d");

    // Virtual canvas
    this.VIRTUAL_WIDTH = 8000;
    this.VIRTUAL_HEIGHT = 2000;
    this.CELL_SIZE = 2000;
    this.SECTION_LABELS = ["11 А", "11 Б", "11 В", "11 Г"];

    // Background image
    this.bgImage = null;
    this.bgImageLoaded = false;
    this._loadBackground();

    // Viewport
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1;
    this.MIN_SCALE = 0.1;
    this.MAX_SCALE = 10;

    // Pan state
    this.isPanning = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.panOffsetX = 0;
    this.panOffsetY = 0;

    // Actions
    this.allActions = [];
    this.imageCache = {};

    // Playback state
    this.currentIndex = 0;        // how many actions have been rendered
    this.isPlaying = false;
    this.isPaused = false;
    this.speed = 1;
    this.startTime = 0;           // timestamp of playback start (wall clock)
    this.actionsStartTime = 0;    // time of the first action
    this.actionsEndTime = 0;      // time of the last action
    this.playbackDuration = 0;    // total time span of actions (ms)
    this.elapsedPlayMs = 0;       // how much "action time" has been played
    this.lastFrameTimestamp = 0;  // for delta calculation
    this.animationFrameId = null;

    // Recording
    this.mediaRecorder = null;
    this.recordedChunks = [];
    this.isRecording = false;

    // DOM references
    this.btnPlay = document.getElementById("btn-play");
    this.btnReset = document.getElementById("btn-reset");
    this.btnRecord = document.getElementById("btn-record");
    this.speedSelect = document.getElementById("speed-select");
    this.progressFill = document.getElementById("progress-bar-fill");
    this.progressWrapper = document.getElementById("progress-bar-wrapper");
    this.progressInfo = document.getElementById("progress-info");
    this.actionCountLabel = document.getElementById("action-count-label");
    this.timeElapsed = document.getElementById("time-elapsed");
    this.timeTotal = document.getElementById("time-total");
    this.renderEmpty = document.getElementById("render-empty");
    this.btnSkipPrev = document.getElementById("btn-skip-prev");
    this.btnSkipNext = document.getElementById("btn-skip-next");
    this.recordingIndicator = document.getElementById("recording-indicator");

    this.bindEvents();
    this.resize();
    this.loadData();
  }

  _loadBackground() {
    const img = new Image();
    img.onload = () => {
      this.bgImage = img;
      this.bgImageLoaded = true;
      this._renderCurrentState();
    };
    img.onerror = () => { this.bgImageLoaded = false; };
    img.src = "nu.png";
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this._fitToScreen();
    this._renderCurrentState();
  }

  _fitToScreen() {
    const rect = this.container.getBoundingClientRect();
    const padding = 40;
    const availW = rect.width - padding * 2;
    const availH = rect.height - padding * 2;
    if (availW <= 0 || availH <= 0) return;
    const scaleX = availW / this.VIRTUAL_WIDTH;
    const scaleY = availH / this.VIRTUAL_HEIGHT;
    this.scale = Math.min(scaleX, scaleY, 1);
    const scaledW = this.VIRTUAL_WIDTH * this.scale;
    const scaledH = this.VIRTUAL_HEIGHT * this.scale;
    this.offsetX = (rect.width - scaledW) / 2;
    this.offsetY = (rect.height - scaledH) / 2;
  }

  bindEvents() {
    window.addEventListener("resize", () => this.resize());

    // Play/Pause
    this.btnPlay.addEventListener("click", () => this.togglePlay());

    // Reset
    this.btnReset.addEventListener("click", () => this.reset());

    // Speed change
    this.speedSelect.addEventListener("change", (e) => {
      this.speed = parseFloat(e.target.value);
    });

    // Skip buttons
    this.btnSkipPrev.addEventListener("click", () => this.skipToAction(this.currentIndex - 1));
    this.btnSkipNext.addEventListener("click", () => this.skipToAction(this.currentIndex + 1));

    // Progress bar click (seek)
    this.progressWrapper.addEventListener("click", (e) => {
      if (this.allActions.length === 0) return;
      const rect = this.progressWrapper.getBoundingClientRect();
      const fraction = (e.clientX - rect.left) / rect.width;
      const targetIndex = Math.round(fraction * this.allActions.length);
      this.skipToAction(targetIndex);
    });

    // Record button
    this.btnRecord.addEventListener("click", () => this.toggleRecording());

    // Pan and zoom — mouse events on canvas container
    this.container.addEventListener("mousedown", (e) => this._handleMouseDown(e));
    this.container.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousemove", (e) => this._handleMouseMove(e));
    window.addEventListener("mouseup", (e) => this._handleMouseUp(e));
    this.container.addEventListener("wheel", (e) => this._handleWheel(e), { passive: false });

    // Keyboard shortcuts
    window.addEventListener("keydown", (e) => {
      if (e.target.tagName === "SELECT" || e.target.tagName === "INPUT") return;
      if (e.code === "Space") {
        e.preventDefault();
        this.togglePlay();
      }
      if (e.code === "ArrowRight") {
        this.skipToAction(this.currentIndex + 1);
      }
      if (e.code === "ArrowLeft") {
        this.skipToAction(this.currentIndex - 1);
      }
      if (e.code === "KeyR") {
        this.reset();
      }
    });

    // Touch events for mobile pan/zoom
    this.container.addEventListener("touchstart", (e) => this._handleTouchStart(e), { passive: false });
    this.container.addEventListener("touchmove", (e) => this._handleTouchMove(e), { passive: false });
    this.container.addEventListener("touchend", (e) => this._handleTouchEnd(e), { passive: false });
  }

  _handleMouseDown(e) {
    // Right click or Middle click: pan
    if (e.button === 2 || e.button === 1) {
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panOffsetX = this.offsetX;
      this.panOffsetY = this.offsetY;
      this.container.classList.add("panning");
      e.preventDefault();
      return;
    }
  }

  _handleMouseMove(e) {
    if (this.isPanning) {
      this.offsetX = this.panOffsetX + (e.clientX - this.panStartX);
      this.offsetY = this.panOffsetY + (e.clientY - this.panStartY);
      this._renderCurrentState();
    }
  }

  _handleMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      this.container.classList.remove("panning");
      e.preventDefault();
    }
  _handleWheel(e) {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(this.MAX_SCALE, Math.max(this.MIN_SCALE, this.scale * zoomFactor));

    // Zoom towards mouse position
    const rect = this.container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    this.offsetX = mouseX - (mouseX - this.offsetX) * (newScale / this.scale);
    this.offsetY = mouseY - (mouseY - this.offsetY) * (newScale / this.scale);
    this.scale = newScale;

    this._renderCurrentState();
  }

  _handleTouchStart(e) {
    if (e.touches.length === 1) {
      // Single touch — pan
      this.isPanning = true;
      this.panStartX = e.touches[0].clientX;
      this.panStartY = e.touches[0].clientY;
      this.panOffsetX = this.offsetX;
      this.panOffsetY = this.offsetY;
    } else if (e.touches.length === 2) {
      // Two touches — pinch zoom
      this.touchPinchDist = this._getTouchDist(e.touches);
      this.touchPinchScale = this.scale;
      this.touchPinchOffsetX = this.offsetX;
      this.touchPinchOffsetY = this.offsetY;
      this.isPanning = false;

      // Calculate pinch center
      const t1 = e.touches[0], t2 = e.touches[1];
      const rect = this.container.getBoundingClientRect();
      this.touchPinchCenterX = ((t1.clientX + t2.clientX) / 2) - rect.left;
      this.touchPinchCenterY = ((t1.clientY + t2.clientY) / 2) - rect.top;
    }
  }

  _handleTouchMove(e) {
    e.preventDefault();
    if (e.touches.length === 1 && this.isPanning) {
      const touch = e.touches[0];
      this.offsetX = this.panOffsetX + (touch.clientX - this.panStartX);
      this.offsetY = this.panOffsetY + (touch.clientY - this.panStartY);
      this._renderCurrentState();
    } else if (e.touches.length === 2) {
      const dist = this._getTouchDist(e.touches);
      const scaleFactor = dist / this.touchPinchDist;
      const newScale = Math.min(this.MAX_SCALE, Math.max(this.MIN_SCALE, this.touchPinchScale * scaleFactor));
      const cx = this.touchPinchCenterX;
      const cy = this.touchPinchCenterY;
      const oldS = this.touchPinchScale;
      this.offsetX = cx - (cx - this.touchPinchOffsetX) * (newScale / oldS);
      this.offsetY = cy - (cy - this.touchPinchOffsetY) * (newScale / oldS);
      this.scale = newScale;
      this._renderCurrentState();
    }
  }

  _handleTouchEnd(e) {
    if (e.touches.length === 0) {
      this.isPanning = false;
    }
  }

  _getTouchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  async loadData() {
    try {
      this.renderEmpty.textContent = "Загрузка данных...";
      const resp = await fetch("/canvas-data.json");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      if (!Array.isArray(data) || data.length === 0) {
        this.renderEmpty.textContent = "Нет сохранённых данных для воспроизведения.";
        return;
      }

      this.allActions = data;

      // Sort by time just in case (untimed actions go to the end)
      this.allActions.sort((a, b) => {
        if (a.time === undefined && b.time === undefined) return 0;
        if (a.time === undefined) return 1;  // no time → end
        if (b.time === undefined) return -1; // no time → end
        return a.time - b.time;
      });

      // Determine time range — find last action with a valid timestamp
      this.actionsStartTime = this.allActions[0].time || 0;
      let lastTimedIdx = this.allActions.length - 1;
      while (lastTimedIdx >= 0 && this.allActions[lastTimedIdx].time === undefined) {
        lastTimedIdx--;
      }
      this.actionsEndTime = lastTimedIdx >= 0 ? this.allActions[lastTimedIdx].time : this.actionsStartTime;
      this.playbackDuration = Math.max(1, this.actionsEndTime - this.actionsStartTime);

      // Hide empty message
      this.renderEmpty.textContent = "";

      // Preload images
      this._preloadImages(() => {
        this.currentIndex = 0;
        this._updateUI();
        this._renderCurrentState();
      });

    } catch (err) {
      console.error("Failed to load canvas data:", err);
      this.renderEmpty.textContent = "Ошибка загрузки данных.";
    }
  }

  _preloadImages(callback) {
    const imageActions = this.allActions.filter((a) => a.type === "image");
    if (imageActions.length === 0) { if (callback) callback(); return; }

    let loaded = 0;
    const total = imageActions.length;

    for (const action of imageActions) {
      if (this.imageCache[action.id]) {
        loaded++;
        if (loaded >= total && callback) callback();
        continue;
      }
      const img = new Image();
      img.onload = () => {
        this.imageCache[action.id] = img;
        loaded++;
        if (loaded >= total && callback) callback();
      };
      img.onerror = () => {
        this.imageCache[action.id] = null;
        loaded++;
        if (loaded >= total && callback) callback();
      };
      img.src = action.data;
    }
  }

  // --- Playback Control ---

  togglePlay() {
    if (this.allActions.length === 0) return;

    if (!this.isPlaying && !this.isPaused) {
      // Start from current position
      this._startPlayback();
    } else if (this.isPlaying && !this.isPaused) {
      // Pause
      this.isPaused = true;
      this.isPlaying = false;
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.btnPlay.textContent = "▶";
    } else if (this.isPaused) {
      // Resume
      this.isPaused = false;
      this.isPlaying = true;
      this.lastFrameTimestamp = performance.now();
      this._playbackLoop();
      this.btnPlay.textContent = "⏸";
    }
  }

  _startPlayback() {
    if (this.currentIndex >= this.allActions.length) {
      this.currentIndex = 0;
      this.elapsedPlayMs = 0;
    }
    this.isPlaying = true;
    this.isPaused = false;
    this.lastFrameTimestamp = performance.now();
    this.btnPlay.textContent = "⏸";
    this._playbackLoop();
  }

  _playbackLoop() {
    if (!this.isPlaying) return;

    const now = performance.now();
    const delta = now - this.lastFrameTimestamp;
    this.lastFrameTimestamp = now;

    // Advance elapsed time in action time scale
    const deltaMs = delta * this.speed;

    // Determine target index based on elapsed time
    if (this.playbackDuration > 0) {
      this.elapsedPlayMs += deltaMs;
    }

    // Calculate how many actions we should have rendered based on elapsed time
    const fraction = Math.min(1, Math.max(0, this.elapsedPlayMs / this.playbackDuration));
    const targetIndex = Math.floor(fraction * this.allActions.length);

    if (targetIndex > this.currentIndex) {
      this.currentIndex = Math.min(targetIndex, this.allActions.length);
    }

    // Render and update UI
    this._renderCurrentState();
    this._updateUI();

    // Check if finished
    if (this.currentIndex >= this.allActions.length) {
      this.isPlaying = false;
      this.btnPlay.textContent = "▶";
      this.isPaused = false;
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      return;
    }

    this.animationFrameId = requestAnimationFrame(() => this._playbackLoop());
  }

  reset() {
    if (this.isPlaying || this.isPaused) {
      this.isPlaying = false;
      this.isPaused = false;
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
    }
    this.currentIndex = 0;
    this.elapsedPlayMs = 0;
    this.btnPlay.textContent = "▶";
    this._renderCurrentState();
    this._updateUI();
  }

  skipToAction(index) {
    if (this.allActions.length === 0) return;

    // If playing, pause
    if (this.isPlaying) {
      this.isPlaying = false;
      this.isPaused = false;
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.btnPlay.textContent = "▶";
    }

    this.currentIndex = Math.max(0, Math.min(index, this.allActions.length));
    const fraction = this.allActions.length > 0 ? this.currentIndex / this.allActions.length : 0;
    this.elapsedPlayMs = fraction * this.playbackDuration;
    this._renderCurrentState();
    this._updateUI();
  }

  // --- Rendering ---

  _renderCurrentState() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    const actionsToRender = this.allActions.slice(0, this.currentIndex);

    // Clear
    ctx.fillStyle = "#2d2d44";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

    // White virtual canvas background
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.VIRTUAL_WIDTH, this.VIRTUAL_HEIGHT);

    // Section background images
    if (this.bgImage && this.bgImageLoaded) {
      ctx.save();
      ctx.globalAlpha = 0.05;
      for (let sec = 0; sec < 4; sec++) {
        const cx = sec * this.CELL_SIZE;
        const scale = Math.min(this.CELL_SIZE / this.bgImage.width, this.CELL_SIZE / this.bgImage.height);
        const drawW = this.bgImage.width * scale;
        const drawH = this.bgImage.height * scale;
        const ox = cx + (this.CELL_SIZE - drawW) / 2;
        const oy = (this.CELL_SIZE - drawH) / 2;
        ctx.drawImage(this.bgImage, ox, oy, drawW, drawH);
      }
      ctx.restore();
    }

    // Grid
    ctx.strokeStyle = "#e0e0e0";
    ctx.lineWidth = 0.5 / this.scale;
    const gridStep = 100;
    const startX = Math.max(0, -this.offsetX / this.scale);
    const startY = Math.max(0, -this.offsetY / this.scale);
    const endX = Math.min(this.VIRTUAL_WIDTH, (w - this.offsetX) / this.scale);
    const endY = Math.min(this.VIRTUAL_HEIGHT, (h - this.offsetY) / this.scale);
    ctx.beginPath();
    for (let gx = Math.floor(startX / gridStep) * gridStep; gx <= endX; gx += gridStep) {
      ctx.moveTo(gx, Math.max(0, startY));
      ctx.lineTo(gx, Math.min(this.VIRTUAL_HEIGHT, endY));
    }
    for (let gy = Math.floor(startY / gridStep) * gridStep; gy <= endY; gy += gridStep) {
      ctx.moveTo(Math.max(0, startX), gy);
      ctx.lineTo(Math.min(this.VIRTUAL_WIDTH, endX), gy);
    }
    ctx.stroke();

    // Section dividers
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 3 / this.scale;
    ctx.setLineDash([10 / this.scale, 6 / this.scale]);
    for (let sec = 1; sec < 4; sec++) {
      const x = sec * this.CELL_SIZE;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.VIRTUAL_HEIGHT);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Section labels
    ctx.font = `${40 / this.scale}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#555555";
    for (let sec = 0; sec < 4; sec++) {
      ctx.fillText(this.SECTION_LABELS[sec], sec * this.CELL_SIZE + this.CELL_SIZE / 2, this.VIRTUAL_HEIGHT - 10 / this.scale);
    }

    // Border
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 2 / this.scale;
    ctx.strokeRect(0, 0, this.VIRTUAL_WIDTH, this.VIRTUAL_HEIGHT);

    ctx.restore();

    // Offscreen canvas for action rendering (same as CanvasManager)
    const offscreen = document.createElement("canvas");
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext("2d");
    offCtx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

    for (const action of actionsToRender) {
      if (action.type === "stroke" && action.tool === "eraser") {
        offCtx.beginPath();
        offCtx.lineWidth = action.size;
        offCtx.lineCap = "round";
        offCtx.lineJoin = "round";
        offCtx.globalCompositeOperation = "destination-out";
        offCtx.strokeStyle = "rgba(0,0,0,1)";
        const pts = action.points;
        if (pts.length > 0) {
          offCtx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) offCtx.lineTo(pts[i].x, pts[i].y);
        }
        offCtx.stroke();
      } else if (action.type === "stroke") {
        offCtx.beginPath();
        offCtx.strokeStyle = action.color;
        offCtx.lineWidth = action.size;
        offCtx.lineCap = "round";
        offCtx.lineJoin = "round";
        offCtx.globalCompositeOperation = "source-over";
        const pts = action.points;
        if (pts.length > 0) {
          offCtx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) offCtx.lineTo(pts[i].x, pts[i].y);
        }
        offCtx.stroke();
      } else if (action.type === "text") {
        const s = action.scale || 1;
        offCtx.font = `${action.size * s}px ${action.font || "Arial"}`;
        offCtx.fillStyle = action.color;
        offCtx.textBaseline = "top";
        offCtx.globalCompositeOperation = "source-over";
        const lines = action.text.split("\n");
        const lineHeight = action.size * s * 1.2;
        lines.forEach((line, i) => {
          offCtx.fillText(line, action.x, action.y + i * lineHeight);
        });
      } else if (action.type === "image") {
        offCtx.globalCompositeOperation = "source-over";
        const img = this.imageCache[action.id];
        if (img) {
          offCtx.drawImage(img, action.x, action.y, action.width, action.height);
        } else if (img === null) {
          offCtx.fillStyle = "#cccccc";
          offCtx.fillRect(action.x, action.y, action.width, action.height);
          offCtx.strokeStyle = "#ff0000";
          offCtx.lineWidth = 2;
          offCtx.strokeRect(action.x, action.y, action.width, action.height);
        } else {
          offCtx.fillStyle = "#eeeeee";
          offCtx.fillRect(action.x, action.y, action.width, action.height);
          offCtx.strokeStyle = "#999";
          offCtx.lineWidth = 1;
          offCtx.strokeRect(action.x, action.y, action.width, action.height);
        }
      }
    }

    ctx.drawImage(offscreen, 0, 0);
  }

  // --- UI Updates ---

  _updateUI() {
    const total = this.allActions.length;
    const current = this.currentIndex;

    // Action count
    this.progressInfo.textContent = `${current} / ${total} действий`;
    this.actionCountLabel.textContent = `${current} / ${total}`;

    // Progress bar
    const pct = total > 0 ? (current / total) * 100 : 0;
    this.progressFill.style.width = pct + "%";

    // Time
    if (this.playbackDuration > 0) {
      const elapsedMs = (current / total) * this.playbackDuration;
      this.timeElapsed.textContent = this._formatTime(elapsedMs);
      this.timeTotal.textContent = this._formatTime(this.playbackDuration);
    } else {
      this.timeElapsed.textContent = "00:00";
      this.timeTotal.textContent = "00:00";
    }
  }

  _formatTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  // --- Video Recording ---

  toggleRecording() {
    if (!this.isRecording) {
      this._startRecording();
    } else {
      this._stopRecording();
    }
  }

  async _startRecording() {
    if (this.allActions.length === 0) {
      alert("Нет данных для записи.");
      return;
    }

    try {
      const stream = this.canvas.captureStream(30);
      this.mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
          ? "video/webm;codecs=vp9"
          : "video/webm",
      });

      this.recordedChunks = [];

      this.mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          this.recordedChunks.push(e.data);
        }
      };

      this.mediaRecorder.onstop = () => {
        this._finishRecording();
      };

      this.mediaRecorder.start();
      this.isRecording = true;
      this.recordingIndicator.classList.add("active");
      this.btnRecord.textContent = "⏹ Стоп";

      // Auto-start playback if not playing
      if (!this.isPlaying && !this.isPaused) {
        this.togglePlay();
      }
    } catch (err) {
      console.error("Recording failed:", err);
      alert("Не удалось начать запись. Попробуйте другой браузер.");
    }
  }

  _stopRecording() {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      this.mediaRecorder.stop();
    }
    this.isRecording = false;
    this.recordingIndicator.classList.remove("active");
    this.btnRecord.innerHTML = '<span id="recording-indicator"></span>Запись';
  }

  _finishRecording() {
    const blob = new Blob(this.recordedChunks, { type: "video/webm" });
    const url = URL.createObjectURL(blob);

    // Generate filename with date
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}`;
    const filename = `canvas-render_${dateStr}.webm`;

    // Trigger download
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Cleanup
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    this.recordedChunks = [];
  }
}

// Initialize on DOM ready
document.addEventListener("DOMContentLoaded", () => {
  new RenderPlayer();
});