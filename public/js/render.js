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

    // Incremental rendering state
    this.lastRenderedIndex = 0;       // how many actions have been drawn on persistentOffscreen
    this.needsFullRedraw = true;      // e.g. after resize, seek, pan/zoom
    this.persistentOffscreen = null;  // offscreen canvas that accumulates actions
    this.lastTransformKey = "";       // to detect pan/zoom changes
    this.backgroundOffscreen = null;  // cached static background
    this.backgroundCacheKey = "";     // key to detect background cache invalidation
    this._actionAccumulator = 0;      // fractional action counter for smooth playback

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
    this.btnReload = document.getElementById("btn-reload");
    this.btnFlush = document.getElementById("btn-flush");

    this.bindEvents();
    this.resize();
    this.loadData();
  }

  _loadBackground() {
    const img = new Image();
    img.onload = () => {
      this.bgImage = img;
      this.bgImageLoaded = true;
      this.needsFullRedraw = true;
      this._renderCurrentState();
    };
    img.onerror = () => { this.bgImageLoaded = false; };
    img.src = "nu.png";
  }

  _getTransformKey() {
    return `${this.scale.toFixed(4)}|${this.offsetX.toFixed(2)}|${this.offsetY.toFixed(2)}|${this.canvas.width}|${this.canvas.height}`;
  }

  _ensurePersistentOffscreen() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!this.persistentOffscreen || this.persistentOffscreen.width !== w || this.persistentOffscreen.height !== h) {
      this.persistentOffscreen = document.createElement("canvas");
      this.persistentOffscreen.width = w;
      this.persistentOffscreen.height = h;
      this.needsFullRedraw = true;
    }
  }

  _renderOneAction(ctx, action) {
    if (action.type === "stroke" && action.tool === "eraser") {
      ctx.beginPath();
      ctx.lineWidth = action.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "destination-out";
      ctx.strokeStyle = "rgba(0,0,0,1)";
      const pts = action.points;
      if (pts.length > 0) {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
    } else if (action.type === "stroke") {
      ctx.beginPath();
      ctx.strokeStyle = action.color;
      ctx.lineWidth = action.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.globalCompositeOperation = "source-over";
      const pts = action.points;
      if (pts.length > 0) {
        ctx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      }
      ctx.stroke();
    } else if (action.type === "text") {
      const s = action.scale || 1;
      ctx.font = `${action.size * s}px ${action.font || "Arial"}`;
      ctx.fillStyle = action.color;
      ctx.textBaseline = "top";
      ctx.globalCompositeOperation = "source-over";
      const lines = action.text.split("\n");
      const lineHeight = action.size * s * 1.2;
      lines.forEach((line, i) => {
        ctx.fillText(line, action.x, action.y + i * lineHeight);
      });
    } else if (action.type === "image") {
      ctx.globalCompositeOperation = "source-over";
      const img = this.imageCache[action.id];
      if (img) {
        ctx.drawImage(img, action.x, action.y, action.width, action.height);
      } else if (img === null) {
        ctx.fillStyle = "#cccccc";
        ctx.fillRect(action.x, action.y, action.width, action.height);
        ctx.strokeStyle = "#ff0000";
        ctx.lineWidth = 2;
        ctx.strokeRect(action.x, action.y, action.width, action.height);
      } else {
        ctx.fillStyle = "#eeeeee";
        ctx.fillRect(action.x, action.y, action.width, action.height);
        ctx.strokeStyle = "#999";
        ctx.lineWidth = 1;
        ctx.strokeRect(action.x, action.y, action.width, action.height);
      }
    }
  }

  _renderCurrentState() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    this._ensurePersistentOffscreen();
    const offscreen = this.persistentOffscreen;

    const transformKey = this._getTransformKey();
    if (transformKey !== this.lastTransformKey) {
      this.needsFullRedraw = true;
      this.lastTransformKey = transformKey;
    }

    // ---- Step 1: draw cached static background ----
    ctx.fillStyle = "#2d2d44";
    ctx.fillRect(0, 0, w, h);

    const bgKey = `${this.scale.toFixed(4)}|${this.offsetX.toFixed(2)}|${this.offsetY.toFixed(2)}|${w}|${h}|${this.bgImageLoaded}`;
    if (!this.backgroundOffscreen || this.backgroundCacheKey !== bgKey) {
      this.backgroundCacheKey = bgKey;
      if (!this.backgroundOffscreen || this.backgroundOffscreen.width !== w || this.backgroundOffscreen.height !== h) {
        this.backgroundOffscreen = document.createElement("canvas");
        this.backgroundOffscreen.width = w;
        this.backgroundOffscreen.height = h;
      }
      const bgCtx = this.backgroundOffscreen.getContext("2d");
      bgCtx.clearRect(0, 0, w, h);
      bgCtx.save();
      bgCtx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

      // White virtual canvas background
      bgCtx.fillStyle = "#ffffff";
      bgCtx.fillRect(0, 0, this.VIRTUAL_WIDTH, this.VIRTUAL_HEIGHT);

      // Section background images
      if (this.bgImage && this.bgImageLoaded) {
        bgCtx.save();
        bgCtx.globalAlpha = 0.05;
        for (let sec = 0; sec < 4; sec++) {
          const cx = sec * this.CELL_SIZE;
          const scale = Math.min(this.CELL_SIZE / this.bgImage.width, this.CELL_SIZE / this.bgImage.height);
          const drawW = this.bgImage.width * scale;
          const drawH = this.bgImage.height * scale;
          const ox = cx + (this.CELL_SIZE - drawW) / 2;
          const oy = (this.CELL_SIZE - drawH) / 2;
          bgCtx.drawImage(this.bgImage, ox, oy, drawW, drawH);
        }
        bgCtx.restore();
      }

      // Grid
      bgCtx.strokeStyle = "#e0e0e0";
      bgCtx.lineWidth = 0.5 / this.scale;
      const gridStep = 100;
      const startX = Math.max(0, -this.offsetX / this.scale);
      const startY = Math.max(0, -this.offsetY / this.scale);
      const endX = Math.min(this.VIRTUAL_WIDTH, (w - this.offsetX) / this.scale);
      const endY = Math.min(this.VIRTUAL_HEIGHT, (h - this.offsetY) / this.scale);
      bgCtx.beginPath();
      for (let gx = Math.floor(startX / gridStep) * gridStep; gx <= endX; gx += gridStep) {
        bgCtx.moveTo(gx, Math.max(0, startY));
        bgCtx.lineTo(gx, Math.min(this.VIRTUAL_HEIGHT, endY));
      }
      for (let gy = Math.floor(startY / gridStep) * gridStep; gy <= endY; gy += gridStep) {
        bgCtx.moveTo(Math.max(0, startX), gy);
        bgCtx.lineTo(Math.min(this.VIRTUAL_WIDTH, endX), gy);
      }
      bgCtx.stroke();

      // Section dividers
      bgCtx.strokeStyle = "#333333";
      bgCtx.lineWidth = 3 / this.scale;
      bgCtx.setLineDash([10 / this.scale, 6 / this.scale]);
      for (let sec = 1; sec < 4; sec++) {
        const x = sec * this.CELL_SIZE;
        bgCtx.beginPath();
        bgCtx.moveTo(x, 0);
        bgCtx.lineTo(x, this.VIRTUAL_HEIGHT);
        bgCtx.stroke();
      }
      bgCtx.setLineDash([]);

      // Section labels
      bgCtx.font = `${40 / this.scale}px Arial, sans-serif`;
      bgCtx.textAlign = "center";
      bgCtx.textBaseline = "bottom";
      bgCtx.fillStyle = "#555555";
      for (let sec = 0; sec < 4; sec++) {
        bgCtx.fillText(this.SECTION_LABELS[sec], sec * this.CELL_SIZE + this.CELL_SIZE / 2, this.VIRTUAL_HEIGHT - 10 / this.scale);
      }

      // Border
      bgCtx.strokeStyle = "#333";
      bgCtx.lineWidth = 2 / this.scale;
      bgCtx.strokeRect(0, 0, this.VIRTUAL_WIDTH, this.VIRTUAL_HEIGHT);

      bgCtx.restore();
    }
    // Draw cached background onto main canvas
    ctx.drawImage(this.backgroundOffscreen, 0, 0);

    // ---- Step 2: render actions incrementally on offscreen canvas ----
    const offCtx = offscreen.getContext("2d");

    if (this.needsFullRedraw) {
      // Clear offscreen in pixel space (identity transform), then set transform
      offCtx.setTransform(1, 0, 0, 1, 0, 0);
      offCtx.clearRect(0, 0, w, h);
      offCtx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
      this.lastRenderedIndex = 0;
      this.needsFullRedraw = false;
    }

    // Render only new actions since lastRenderedIndex
    if (this.currentIndex > this.lastRenderedIndex) {
      offCtx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
      for (let i = this.lastRenderedIndex; i < this.currentIndex; i++) {
        this._renderOneAction(offCtx, this.allActions[i]);
      }
      this.lastRenderedIndex = this.currentIndex;
    }

    // Handle reverse skipping (currentIndex < lastRenderedIndex)
    if (this.currentIndex < this.lastRenderedIndex) {
      // Must do full redraw for backward seeks — they are user-initiated and rare
      offCtx.setTransform(1, 0, 0, 1, 0, 0);
      offCtx.clearRect(0, 0, w, h);
      offCtx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
      this.lastRenderedIndex = 0;
      for (let i = 0; i < this.currentIndex; i++) {
        this._renderOneAction(offCtx, this.allActions[i]);
      }
      this.lastRenderedIndex = this.currentIndex;
    }

    // ---- Step 3: compose offscreen onto main canvas ----
    ctx.drawImage(offscreen, 0, 0);
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this._fitToScreen();
    // Invalidate persistent offscreen — it will be recreated on next render
    this.persistentOffscreen = null;
    this.lastTransformKey = "";
    this.needsFullRedraw = true;
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

    // Reload from server memory
    this.btnReload.addEventListener("click", () => this.reloadFromMemory());

    // Force flush to disk
    this.btnFlush.addEventListener("click", () => this.flushToDisk());

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

      // Try loading from server memory first (always up-to-date),
      // fall back to static file if the API endpoint is unavailable (e.g., old server)
      let resp = await fetch("/api/actions");
      if (!resp.ok) {
        console.warn("/api/actions unavailable, falling back to canvas-data.json");
        resp = await fetch("/canvas-data.json");
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      }
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
        this.lastRenderedIndex = 0;
        this.needsFullRedraw = true;
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
      this.lastRenderedIndex = 0;
      this.needsFullRedraw = true;
    }
    this._actionAccumulator = 0;
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

    // Action-based advancement: each frame advances by 'speed' actions per frame.
    // This ensures consistent playback speed regardless of action timestamp spread
    // (e.g., actions recorded over days/weeks won't slow down the replay).
    // Use a fractional accumulator so speeds < 1 still work smoothly.
    this._actionAccumulator += this.speed / 20;
    const advance = Math.floor(this._actionAccumulator);
    if (advance > 0) {
      this._actionAccumulator -= advance;
      this.currentIndex = Math.min(this.currentIndex + advance, this.allActions.length);
    }
    // Update elapsed time for progress bar consistency
    this.elapsedPlayMs = this.allActions.length > 0
      ? (this.currentIndex / this.allActions.length) * this.playbackDuration
      : 0;

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
    this._actionAccumulator = 0;
    this.btnPlay.textContent = "▶";
    this.needsFullRedraw = true;
    this.lastRenderedIndex = 0;
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
    this._actionAccumulator = 0;
    this.needsFullRedraw = true;
    this._renderCurrentState();
    this._updateUI();
  }

  // --- Rendering ---

  // _renderCurrentState, _renderOneAction, _getTransformKey, _ensurePersistentOffscreen
  // are defined above (after constructor) for clarity.

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

  // --- Reload from server memory ---

  async reloadFromMemory() {
    // Stop playback if active
    if (this.isPlaying || this.isPaused) {
      this.isPlaying = false;
      this.isPaused = false;
      if (this.animationFrameId) {
        cancelAnimationFrame(this.animationFrameId);
        this.animationFrameId = null;
      }
      this.btnPlay.textContent = "▶";
    }

    const originalCount = this.allActions.length;
    this.renderEmpty.textContent = "Загрузка актуальных данных...";

    try {
      const resp = await fetch("/api/actions");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      if (!Array.isArray(data)) {
        throw new Error("Некорректный формат данных");
      }

      this.allActions = data;

      // Sort by time
      this.allActions.sort((a, b) => {
        if (a.time === undefined && b.time === undefined) return 0;
        if (a.time === undefined) return 1;
        if (b.time === undefined) return -1;
        return a.time - b.time;
      });

      // Determine time range
      this.actionsStartTime = this.allActions[0]?.time || 0;
      let lastTimedIdx = this.allActions.length - 1;
      while (lastTimedIdx >= 0 && this.allActions[lastTimedIdx].time === undefined) {
        lastTimedIdx--;
      }
      this.actionsEndTime = lastTimedIdx >= 0 ? this.allActions[lastTimedIdx].time : this.actionsStartTime;
      this.playbackDuration = Math.max(1, this.actionsEndTime - this.actionsStartTime);

      // Reset playback state
      this.currentIndex = 0;
      this.elapsedPlayMs = 0;
      this.lastRenderedIndex = 0;
      this.needsFullRedraw = true;
      this.imageCache = {};

      // Preload images and re-render
      this._preloadImages(() => {
        this._updateUI();
        this._renderCurrentState();
        this.renderEmpty.textContent = "";
      });

      const newCount = this.allActions.length;
      if (newCount > originalCount) {
        console.log(`Загружено ${newCount - originalCount} новых действий из памяти сервера`);
      }
    } catch (err) {
      console.error("Failed to reload actions from memory:", err);
      this.renderEmpty.textContent = "Ошибка загрузки данных из памяти.";
    }
  }

  // --- Force flush to disk ---

  async flushToDisk() {
    try {
      const resp = await fetch("/api/flush", { method: "POST" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      console.log(`Flushed to disk: ${result.count} actions saved`);
      // Brief visual feedback on the button
      this.btnFlush.style.background = "#4caf50";
      setTimeout(() => { this.btnFlush.style.background = "#f57c00"; }, 1000);
    } catch (err) {
      console.error("Flush failed:", err);
      this.btnFlush.style.background = "#d32f2f";
      setTimeout(() => { this.btnFlush.style.background = "#f57c00"; }, 1000);
    }
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