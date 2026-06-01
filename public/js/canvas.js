/**
 * CanvasManager - Handles the drawing canvas, zoom, pan, and rendering
 */
class CanvasManager {
  constructor(containerId, canvasId) {
    this.container = document.getElementById(containerId);
    this.canvas = document.getElementById(canvasId);
    this.ctx = this.canvas.getContext("2d");

    // Virtual canvas size: 8000 x 2000 (4 sections of 2000x2000)
    this.VIRTUAL_WIDTH = 8000;
    this.VIRTUAL_HEIGHT = 2000;

    // Section labels (left to right)
    this.SECTION_LABELS = ["11 А", "11 Б", "11 В", "11 Г"];
    this.CELL_SIZE = 2000;

    // Background cell image (nu.png)
    this.bgImage = null;
    this.bgImageLoaded = false;
    this._loadBackgroundPattern();

    // Viewport state
    this.offsetX = 0;
    this.offsetY = 0;
    this.scale = 1;
    this.MIN_SCALE = 0.1;
    this.MAX_SCALE = 10;

    // Pan state
    this.isPanning = false;
    this.spacePressed = false;
    this.panStartX = 0;
    this.panStartY = 0;
    this.panOffsetX = 0;
    this.panOffsetY = 0;

    // Callbacks
    this.onDrawStart = null;
    this.onDrawMove = null;
    this.onDrawEnd = null;
    this.onCanvasClick = null;
    this.onCursorMove = null;

    // Transform (move/resize) state
    this.selectedActionId = null;
    this.transformMode = null; // null | 'move' | 'resize'
    this.transformStartX = 0;
    this.transformStartY = 0;
    this.transformOrigData = null; // { x, y, width, height } of the action at start
    this.transformResizeHandle = null; // 'tl' | 'tr' | 'bl' | 'br' | 'tm' | 'bm' | 'ml' | 'mr'

    // Text transform state (separate from image)
    this.transformOrigTextScale = 1;

    // Callbacks for transform operations
    this.onTransformEnd = null; // called with (actionId, newX, newY, newW, newH)

    // Reference to actions (for re-rendering after pan/zoom)
    this.actions = [];

    // Image cache: actionId -> HTMLImageElement
    this.imageCache = {};

    // Eraser preview state
    this.eraserPreviewVisible = false;
    this.eraserPreviewX = 0;
    this.eraserPreviewY = 0;
    this.eraserPreviewSize = 20;

    this.resize();
    this.bindEvents();
  }

  _loadBackgroundPattern() {
    const img = new Image();
    img.onload = () => {
      this.bgImage = img;
      this.bgImageLoaded = true;
      this.render();
    };
    img.onerror = () => {
      this.bgImageLoaded = false;
    };
    img.src = "nu.png";
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.canvas.width = rect.width;
    this.canvas.height = rect.height;
    this.render();
  }

  bindEvents() {
    // Resize
    window.addEventListener("resize", () => this.resize());

    // Container mouse events
    this.container.addEventListener("mousedown", (e) =>
      this.handleMouseDown(e),
    );
    this.container.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("mousemove", (e) => this.handleMouseMove(e));
    window.addEventListener("mouseup", (e) => this.handleMouseUp(e));

    // Mouse leave container -> hide eraser preview
    this.container.addEventListener("mouseleave", () => {
      if (this.eraserPreviewVisible) {
        this.eraserPreviewVisible = false;
        this.render();
      }
      if (this.onCursorLeave) {
        this.onCursorLeave();
      }
    });

    // Keyboard for panning
    window.addEventListener("keydown", (e) => {
      if (e.code === "Space") {
        e.preventDefault();
        this.spacePressed = true;
        this.container.classList.add("panning");
      }
      // Escape cancels transform
      if (e.code === "Escape" && this.selectedActionId) {
        this.selectedActionId = null;
        this.transformMode = null;
        this.render();
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") {
        this.spacePressed = false;
        this.container.classList.remove("panning");
        this.isPanning = false;
      }
    });

    // Wheel zoom
    this.container.addEventListener("wheel", (e) => this.handleWheel(e), {
      passive: false,
    });

    // Touch events
    this.container.addEventListener(
      "touchstart",
      (e) => this.handleTouchStart(e),
      { passive: false },
    );
    this.container.addEventListener(
      "touchmove",
      (e) => this.handleTouchMove(e),
      { passive: false },
    );
    this.container.addEventListener("touchend", (e) => this.handleTouchEnd(e), {
      passive: false,
    });
  }

  // Convert screen coordinates to canvas coordinates
  screenToCanvas(screenX, screenY) {
    const rect = this.container.getBoundingClientRect();
    const x = screenX - rect.left;
    const y = screenY - rect.top;
    return {
      x: (x - this.offsetX) / this.scale,
      y: (y - this.offsetY) / this.scale,
    };
  }

  // Get the resize handle under the canvas point, or null
  _getResizeHandle(action, cx, cy) {
    let x, y, width, height;

    if (action.type === "text") {
      x = action.x;
      y = action.y;
      const s = action.scale || 1;
      if (this.ctx) {
        this.ctx.font = `${action.size * s}px ${action.font || "Arial"}`;
        const lines = action.text.split("\n");
        width = Math.max(
          ...lines.map((line) => this.ctx.measureText(line).width),
        );
        height = action.size * s * 1.2 * lines.length;
      } else {
        ({ x, y, width, height } = action);
        width *= s;
        height *= s;
      }
    } else {
      ({ x, y, width, height } = action);
    }

    const handleSize = 8 / this.scale;
    const half = handleSize / 2;

    const handles = {
      tl: { x: x - half, y: y - half },
      tr: { x: x + width - half, y: y - half },
      bl: { x: x - half, y: y + height - half },
      br: { x: x + width - half, y: y + height - half },
      tm: { x: x + width / 2 - half, y: y - half },
      bm: { x: x + width / 2 - half, y: y + height - half },
      ml: { x: x - half, y: y + height / 2 - half },
      mr: { x: x + width - half, y: y + height / 2 - half },
    };

    for (const [key, pos] of Object.entries(handles)) {
      if (
        cx >= pos.x &&
        cx <= pos.x + handleSize &&
        cy >= pos.y &&
        cy <= pos.y + handleSize
      ) {
        return key;
      }
    }
    return null;
  }

  // Check if a canvas point is inside an action's rect
  _isInsideAction(action, cx, cy) {
    let x, y, width, height;

    if (action.type === "text") {
      x = action.x;
      y = action.y;
      const s = action.scale || 1;
      if (this.ctx) {
        this.ctx.font = `${action.size * s}px ${action.font || "Arial"}`;
        const lines = action.text.split("\n");
        width = Math.max(...lines.map((line) => this.ctx.measureText(line).width));
        height = action.size * s * 1.2 * lines.length;
      } else {
        ({ x, y, width, height } = action);
      }
    } else {
      ({ x, y, width, height } = action);
    }

    return cx >= x && cx <= x + width && cy >= y && cy <= y + height;
  }

  // Call this from external code (see handleMouseDown for internal routing)
  handleTextDown(e, action) {
    return this.handleTextMouseDown(e, action);
  }

  handleMouseDown(e) {
    // Right click or Middle click or Space+Left click: pan
    if (
      e.button === 2 ||
      e.button === 1 ||
      (e.button === 0 && this.spacePressed)
    ) {
      this.isPanning = true;
      this.panStartX = e.clientX;
      this.panStartY = e.clientY;
      this.panOffsetX = this.offsetX;
      this.panOffsetY = this.offsetY;
      return;
    }

    if (e.button === 0 && !this.spacePressed) {
      const coords = this.screenToCanvas(e.clientX, e.clientY);

      // Check if clicking on a selected image transform handle or body
      if (this.selectedActionId) {
        const action = this.actions.find((a) => a.id === this.selectedActionId);
        if (action && action.type === "text") {
          // Use dedicated text transform
          if (this.handleTextMouseDown(e, action)) return;
        } else if (action && action.type === "image") {
          // Check resize handles first
          const handle = this._getResizeHandle(action, coords.x, coords.y);
          if (handle) {
            this.transformMode = "resize";
            this.transformStartX = e.clientX;
            this.transformStartY = e.clientY;
            this.transformOrigData = {
              x: action.x,
              y: action.y,
              width: action.width,
              height: action.height,
            };
            this.transformResizeHandle = handle;
            return;
          }
          // Check if inside the image body -> move
          if (this._isInsideAction(action, coords.x, coords.y)) {
            this.transformMode = "move";
            this.transformStartX = e.clientX;
            this.transformStartY = e.clientY;
            this.transformOrigData = {
              x: action.x,
              y: action.y,
              width: action.width,
              height: action.height,
            };
            return;
          }
        }
        // Clicked outside -> deselect
        this.selectedActionId = null;
        this.transformMode = null;
        this.render();
      }

      // Fire click callbacks (for text, image placement)
      if (this.onCanvasClick) {
        this.onCanvasClick(coords.x, coords.y);
      }
      if (this.onDrawStart) {
        this.onDrawStart(coords.x, coords.y);
      }
    }
  }

  handleMouseMove(e) {
    if (this.isPanning) {
      this.offsetX = this.panOffsetX + (e.clientX - this.panStartX);
      this.offsetY = this.panOffsetY + (e.clientY - this.panStartY);
      this.render();
      return;
    }

    // Handle transform (move/resize)
    if (this.transformMode && this.selectedActionId) {
      const action = this.actions.find((a) => a.id === this.selectedActionId);
      if (action && action.type === "text") {
        // Use dedicated text handler
        this.handleTextMouseMove(e, action);
        return;
      }
      if (action && action.type === "image") {
        const dx = (e.clientX - this.transformStartX) / this.scale;
        const dy = (e.clientY - this.transformStartY) / this.scale;
        const orig = this.transformOrigData;

        if (this.transformMode === "move") {
          action.x = orig.x + dx;
          action.y = orig.y + dy;
          this.render();
        } else if (this.transformMode === "resize") {
          const handle = this.transformResizeHandle;
          const aspect = orig.width / orig.height; // original aspect ratio

          let newX = orig.x;
          let newY = orig.y;
          let newW = orig.width;
          let newH = orig.height;

          // Determine primary drag direction
          const isCorner =
            handle === "tl" ||
            handle === "tr" ||
            handle === "bl" ||
            handle === "br";
          const isHorizontal = handle.includes("l") || handle.includes("r");
          const isVertical = handle.includes("t") || handle.includes("b");

          // When Shift is held, lock aspect ratio
          if (e.shiftKey) {
            // Use the longer of the two deltas to determine the scale factor
            const absDx = Math.abs(dx);
            const absDy = Math.abs(dy);

            if (isCorner) {
              // For corners, pick the dominant axis
              if (absDx >= absDy) {
                newW = orig.width + (handle.includes("r") ? dx : -dx);
                newH = newW / aspect;
              } else {
                newH = orig.height + (handle.includes("b") ? dy : -dy);
                newW = newH * aspect;
              }
            } else if (isHorizontal && !isVertical) {
              // Middle-left or middle-right handle
              newW = orig.width + (handle.includes("r") ? dx : -dx);
              newH = newW / aspect;
            } else if (isVertical && !isHorizontal) {
              // Middle-top or middle-bottom handle
              newH = orig.height + (handle.includes("b") ? dy : -dy);
              newW = newH * aspect;
            }

            // Adjust position for left/top handles
            if (handle.includes("l")) newX = orig.x + orig.width - newW;
            if (handle.includes("t")) newY = orig.y + orig.height - newH;
          } else {
            // Free resize (original behavior)
            if (handle.includes("l")) {
              newX = orig.x + dx;
              newW = orig.width - dx;
            } else if (handle.includes("r")) {
              newW = orig.width + dx;
            }

            if (handle.includes("t")) {
              newY = orig.y + dy;
              newH = orig.height - dy;
            } else if (handle.includes("b")) {
              newH = orig.height + dy;
            }
          }

          // Prevent flipping too small
          if (newW < 20) newW = 20;
          if (newH < 20) newH = 20;
          if (handle.includes("l") && newX + newW > orig.x + orig.width)
            newX = orig.x + orig.width - newW;
          if (handle.includes("t") && newY + newH > orig.y + orig.height)
            newY = orig.y + orig.height - newH;

          action.x = newX;
          action.y = newY;
          action.width = newW;
          action.height = newH;
          this.render();
        }
      }
      return;
    }

    // Fire cursor move callback for eraser preview and other hover effects
    const coords = this.screenToCanvas(e.clientX, e.clientY);
    if (this.onCursorMove) {
      this.onCursorMove(coords.x, coords.y);
    }

    if (this.onDrawMove) {
      this.onDrawMove(coords.x, coords.y);
    }
  }

  handleMouseUp(e) {
    if (this.isPanning) {
      this.isPanning = false;
      return;
    }

    // Finalize transform
    if (this.transformMode && this.selectedActionId) {
      const action = this.actions.find((a) => a.id === this.selectedActionId);
      if (action && action.type === "text") {
        this.handleTextMouseUp(e, action);
      } else if (action && action.type === "image") {
        this.transformMode = null;
        this.transformResizeHandle = null;
        if (this.onTransformEnd) {
          this.onTransformEnd(
            action.id,
            action.x,
            action.y,
            action.width,
            action.height,
          );
        }
      } else {
        this.transformMode = null;
        this.transformResizeHandle = null;
      }
      return;
    }

    if (this.onDrawEnd) {
      const coords = this.screenToCanvas(e.clientX, e.clientY);
      this.onDrawEnd(coords.x, coords.y);
    }
  }

  // --- Dedicated text handler -- mousedown
  handleTextMouseDown(e, action) {
    if (!action) return false;
    const coords = this.screenToCanvas(e.clientX, e.clientY);
    const handle = this._getResizeHandle(action, coords.x, coords.y);
    if (handle) {
      // Resize text via scale — сохраняем исходные размеры для центрированного масштабирования
      const s = action.scale || 1;
      const ctx = this.ctx;
      ctx.font = `${action.size * s}px ${action.font || "Arial"}`;
      const lines = action.text.split("\n");
      const origWidth = Math.max(...lines.map((line) => ctx.measureText(line).width));
      const origHeight = action.size * s * 1.2 * lines.length;

      this.transformMode = "resize";
      this.transformStartX = e.clientX;
      this.transformStartY = e.clientY;
      this.transformOrigData = {
        x: action.x,
        y: action.y,
        width: origWidth,
        height: origHeight,
        scale: s,
      };
      this.transformOrigTextScale = s;
      this.transformResizeHandle = handle;
      return true;
    }
    if (this._isInsideAction(action, coords.x, coords.y)) {
      // Move text
      this.transformMode = "move";
      this.transformStartX = e.clientX;
      this.transformStartY = e.clientY;
      this.transformOrigData = {
        x: action.x,
        y: action.y,
        scale: action.scale || 1,
      };
      return true;
    }
    return false;
  }

  // --- Dedicated text handler -- mousemove
  handleTextMouseMove(e, action) {
    if (!action || !this.transformMode) return;
    const dx = (e.clientX - this.transformStartX) / this.scale;
    const dy = (e.clientY - this.transformStartY) / this.scale;
    const orig = this.transformOrigData;

    if (this.transformMode === "move") {
      action.x = orig.x + dx;
      action.y = orig.y + dy;
      this.render();
    } else if (this.transformMode === "resize") {
      // Scale text based on handle drag — проекция на наружное направление
      const handle = this.transformResizeHandle;
      // Проекция (dx, dy) на вектор "наружу от центра" для каждого хендла
      const outwardProjections = {
        tl: -dx - dy,
        tr: dx - dy,
        bl: -dx + dy,
        br: dx + dy,
        tm: -dy,
        bm: dy,
        ml: -dx,
        mr: dx,
      };
      const proj = outwardProjections[handle] || 0;
      const scaleFactor = 1 + proj / 100;
      const newScale = Math.max(0.1, this.transformOrigTextScale * scaleFactor);
      action.scale = newScale;

      // Сохраняем центр текста при масштабировании
      const ratio = newScale / this.transformOrigTextScale;
      action.x = orig.x + (orig.width - orig.width * ratio) / 2;
      action.y = orig.y + (orig.height - orig.height * ratio) / 2;

      this.render();
    }
  }

  // --- Dedicated text handler -- mouseup
  handleTextMouseUp(e, action) {
    if (!action) return;
    this.transformMode = null;
    this.transformResizeHandle = null;
  }

  // Select an image action for transform
  selectImageAction(actionId) {
    this.selectedActionId = actionId;
    this.transformMode = null;
    this.render();
  }

  handleWheel(e) {
    e.preventDefault();
    const rect = this.container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const zoomFactor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.min(
      this.MAX_SCALE,
      Math.max(this.MIN_SCALE, this.scale * zoomFactor),
    );

    // Zoom towards mouse position
    this.offsetX = mouseX - (mouseX - this.offsetX) * (newScale / this.scale);
    this.offsetY = mouseY - (mouseY - this.offsetY) * (newScale / this.scale);
    this.scale = newScale;

    this.updateZoomLabel();
    this.render();
  }

  // Touch handling with pinch-zoom
  handleTouchStart(e) {
    if (e.touches.length === 1) {
      e.preventDefault();
      const touch = e.touches[0];
      const coords = this.screenToCanvas(touch.clientX, touch.clientY);

      // If we have a selected image, check for transform on touch
      if (this.selectedActionId) {
        const action = this.actions.find((a) => a.id === this.selectedActionId);
        if (action && action.type === "image") {
          const handle = this._getResizeHandle(action, coords.x, coords.y);
          if (handle) {
            this.transformMode = "resize";
            this.transformStartX = touch.clientX;
            this.transformStartY = touch.clientY;
            this.transformOrigData = {
              x: action.x,
              y: action.y,
              width: action.width,
              height: action.height,
            };
            this.transformResizeHandle = handle;
            return;
          }
          if (this._isInsideAction(action, coords.x, coords.y)) {
            this.transformMode = "move";
            this.transformStartX = touch.clientX;
            this.transformStartY = touch.clientY;
            this.transformOrigData = {
              x: action.x,
              y: action.y,
              width: action.width,
              height: action.height,
            };
            return;
          }
          this.selectedActionId = null;
          this.transformMode = null;
        }
      }

      if (this.onDrawStart) {
        this.onDrawStart(coords.x, coords.y);
      }
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const center = this.getTouchCenter(e.touches);
      this.touchPinchDist = this.getTouchDist(e.touches);
      this.touchPinchScale = this.scale;
      this.touchPanOffsetX = this.offsetX;
      this.touchPanOffsetY = this.offsetY;
      this.touchPanCenterX = center.x;
      this.touchPanCenterY = center.y;
      this.isPanning = true;
    }
  }

  handleTouchMove(e) {
    if (e.touches.length === 1 && !this.isPanning) {
      e.preventDefault();
      const touch = e.touches[0];

      // Handle transform on touch
      if (this.selectedActionId && this.transformMode) {
        const action = this.actions.find((a) => a.id === this.selectedActionId);
        if (action && action.type === "image") {
          // We approximate with clientX/Y since no previous touch point stored
          const dx = (touch.clientX - this.transformStartX) / this.scale;
          const dy = (touch.clientY - this.transformStartY) / this.scale;
          const orig = this.transformOrigData;

          if (this.transformMode === "move") {
            action.x = orig.x + dx;
            action.y = orig.y + dy;
            this.render();
          } else if (this.transformMode === "resize") {
            const handle = this.transformResizeHandle;

            let newX = orig.x,
              newY = orig.y,
              newW = orig.width,
              newH = orig.height;

            if (handle.includes("l")) {
              newX = orig.x + dx;
              newW = orig.width - dx;
            } else if (handle.includes("r")) {
              newW = orig.width + dx;
            }

            if (handle.includes("t")) {
              newY = orig.y + dy;
              newH = orig.height - dy;
            } else if (handle.includes("b")) {
              newH = orig.height + dy;
            }

            if (newW < 20) newW = 20;
            if (newH < 20) newH = 20;
            if (handle.includes("l") && newX + newW > orig.x + orig.width)
              newX = orig.x + orig.width - newW;
            if (handle.includes("t") && newY + newH > orig.y + orig.height)
              newY = orig.y + orig.height - newH;

            action.x = newX;
            action.y = newY;
            action.width = newW;
            action.height = newH;
            this.render();
          }
        }
        return;
      }

      // Fire cursor move callback for eraser preview (touch)
      const coords = this.screenToCanvas(touch.clientX, touch.clientY);
      if (this.onCursorMove) {
        this.onCursorMove(coords.x, coords.y);
      }

      if (this.onDrawMove) {
        this.onDrawMove(coords.x, coords.y);
      }
    } else if (e.touches.length === 2) {
      e.preventDefault();
      const center = this.getTouchCenter(e.touches);
      const dist = this.getTouchDist(e.touches);

      const deltaX = center.x - this.touchPanCenterX;
      const deltaY = center.y - this.touchPanCenterY;

      const scaleFactor = dist / this.touchPinchDist;
      const newScale = Math.min(
        this.MAX_SCALE,
        Math.max(this.MIN_SCALE, this.touchPinchScale * scaleFactor),
      );

      let newOffsetX = this.touchPanOffsetX + deltaX;
      let newOffsetY = this.touchPanOffsetY + deltaY;

      const rect = this.container.getBoundingClientRect();
      const snapX = this.touchPanCenterX - rect.left;
      const snapY = this.touchPanCenterY - rect.top;

      newOffsetX =
        snapX -
        (snapX - this.touchPanOffsetX) * (newScale / this.touchPinchScale);
      newOffsetY =
        snapY -
        (snapY - this.touchPanOffsetY) * (newScale / this.touchPinchScale);

      this.offsetX = newOffsetX + deltaX;
      this.offsetY = newOffsetY + deltaY;
      this.scale = newScale;

      this.updateZoomLabel();
      this.render();
    }
  }

  handleTouchEnd(e) {
    if (e.touches.length === 0) {
      this.isPanning = false;

      // Finalize transform on touch end
      if (this.selectedActionId && this.transformMode) {
        this.transformMode = null;
        this.transformResizeHandle = null;
        const action = this.actions.find((a) => a.id === this.selectedActionId);
        if (action && action.type === "image" && this.onTransformEnd) {
          this.onTransformEnd(
            action.id,
            action.x,
            action.y,
            action.width,
            action.height,
          );
        }
        this.render();
        return;
      }

      if (this.onCanvasClick) {
        this.onCanvasClick(null, null);
      }
      if (this.onDrawEnd) {
        this.onDrawEnd(null, null);
      }
    }
  }

  getTouchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  getTouchCenter(touches) {
    return {
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    };
  }

  updateZoomLabel() {
    const el = document.getElementById("zoom-level");
    if (el) {
      el.textContent = Math.round(this.scale * 100) + "%";
    }
  }

  // Update eraser preview position and size
  updateEraserPreview(x, y, size, visible) {
    this.eraserPreviewVisible = visible;
    this.eraserPreviewX = x;
    this.eraserPreviewY = y;
    this.eraserPreviewSize = size;
    this.render();
  }

  // Preload image and cache it, then call callback when ready
  loadImage(action, callback) {
    if (this.imageCache[action.id]) {
      callback();
      return;
    }
    const img = new Image();
    img.onload = () => {
      this.imageCache[action.id] = img;
      callback();
    };
    img.onerror = () => {
      this.imageCache[action.id] = null;
      callback();
    };
    img.src = action.data;
  }

  // Preload all images in the actions array
  preloadImages(actions, callback) {
    const imageActions = actions.filter((a) => a.type === "image");
    if (imageActions.length === 0) {
      if (callback) callback();
      return;
    }
    let loaded = 0;
    const total = imageActions.length;
    for (const action of imageActions) {
      if (this.imageCache[action.id]) {
        loaded++;
        if (loaded >= total) {
          if (callback) callback();
        }
        continue;
      }
      this.loadImage(action, () => {
        loaded++;
        if (loaded >= total && callback) callback();
      });
    }
  }

  render() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Clear
    ctx.fillStyle = "#2d2d44";
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

    // Draw virtual canvas background (white)
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, this.VIRTUAL_WIDTH, this.VIRTUAL_HEIGHT);

    // Draw background image (nu.png) in each cell at 95% opacity
    if (this.bgImage) {
      ctx.save();
      ctx.globalAlpha = 0.05; // 95% transparent (5% visible)
      for (let sec = 0; sec < 4; sec++) {
        const cx = sec * this.CELL_SIZE;
        // Fit image into the cell maintaining aspect ratio
        const imgW = this.bgImage.width;
        const imgH = this.bgImage.height;
        const scale = Math.min(
          this.CELL_SIZE / imgW,
          this.CELL_SIZE / imgH
        );
        const drawW = imgW * scale;
        const drawH = imgH * scale;
        const offsetX = cx + (this.CELL_SIZE - drawW) / 2;
        const offsetY = (this.CELL_SIZE - drawH) / 2;
        ctx.drawImage(this.bgImage, offsetX, offsetY, drawW, drawH);
      }
      ctx.restore();
    }

    // Draw grid lines (subtle)
    ctx.strokeStyle = "#e0e0e0";
    ctx.lineWidth = 0.5 / this.scale;
    const gridStep = 100;
    const startX = Math.max(0, -this.offsetX / this.scale);
    const startY = Math.max(0, -this.offsetY / this.scale);
    const endX = Math.min(this.VIRTUAL_WIDTH, (w - this.offsetX) / this.scale);
    const endY = Math.min(this.VIRTUAL_HEIGHT, (h - this.offsetY) / this.scale);

    ctx.beginPath();
    for (
      let gx = Math.floor(startX / gridStep) * gridStep;
      gx <= endX;
      gx += gridStep
    ) {
      ctx.moveTo(gx, Math.max(0, startY));
      ctx.lineTo(gx, Math.min(this.VIRTUAL_HEIGHT, endY));
    }
    for (
      let gy = Math.floor(startY / gridStep) * gridStep;
      gy <= endY;
      gy += gridStep
    ) {
      ctx.moveTo(Math.max(0, startX), gy);
      ctx.lineTo(Math.min(this.VIRTUAL_WIDTH, endX), gy);
    }
    ctx.stroke();

    // --- Draw 4 section divider lines (vertical dashes between 2000px cells) ---
    ctx.strokeStyle = "#333333";
    ctx.lineWidth = 3 / this.scale;
    ctx.setLineDash([10 / this.scale, 6 / this.scale]);

    // Vertical lines between sections (at x = 2000, 4000, 6000)
    for (let sec = 1; sec < 4; sec++) {
      const x = sec * this.CELL_SIZE;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.VIRTUAL_HEIGHT);
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // --- Draw section labels ---
    ctx.font = `${40 / this.scale}px Arial, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "#555555";

    for (let sec = 0; sec < 4; sec++) {
      const cx = sec * this.CELL_SIZE + this.CELL_SIZE / 2;
      const cy = this.VIRTUAL_HEIGHT - 10 / this.scale;
      ctx.fillText(this.SECTION_LABELS[sec], cx, cy);
    }

    // Border around virtual canvas
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 2 / this.scale;
    ctx.strokeRect(0, 0, this.VIRTUAL_WIDTH, this.VIRTUAL_HEIGHT);

    ctx.restore();

    // --- Draw all actions on an offscreen canvas in chronological order ---
    // Each action is processed in sequence: normal content is drawn, erasers remove
    // content that was drawn BEFORE them (not after).
    const offscreen = document.createElement('canvas');
    offscreen.width = w;
    offscreen.height = h;
    const offCtx = offscreen.getContext('2d');

    // Apply the same transform to offscreen canvas
    offCtx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

    // Process actions in chronological order: for each action, if it's content
    // draw it on top; if it's an eraser, remove only what was drawn before it.
    for (const action of this.actions) {
      if (action.type === "stroke" && action.tool === "eraser") {
        // Eraser removes content that was drawn before this action
        offCtx.beginPath();
        offCtx.lineWidth = action.size;
        offCtx.lineCap = "round";
        offCtx.lineJoin = "round";
        offCtx.globalCompositeOperation = "destination-out";
        offCtx.strokeStyle = "rgba(0,0,0,1)";

        const pts = action.points;
        if (pts.length > 0) {
          offCtx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            offCtx.lineTo(pts[i].x, pts[i].y);
          }
        }
        offCtx.stroke();
      } else if (action.type === "stroke" && action.tool !== "eraser") {
        // Normal stroke drawn on top of everything before it
        offCtx.beginPath();
        offCtx.strokeStyle = action.color;
        offCtx.lineWidth = action.size;
        offCtx.lineCap = "round";
        offCtx.lineJoin = "round";
        offCtx.globalCompositeOperation = "source-over";

        const pts = action.points;
        if (pts.length > 0) {
          offCtx.moveTo(pts[0].x, pts[0].y);
          for (let i = 1; i < pts.length; i++) {
            offCtx.lineTo(pts[i].x, pts[i].y);
          }
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
        }
        if (img === undefined) {
          offCtx.fillStyle = "#eeeeee";
          offCtx.fillRect(action.x, action.y, action.width, action.height);
          offCtx.strokeStyle = "#999";
          offCtx.lineWidth = 1;
          offCtx.strokeRect(action.x, action.y, action.width, action.height);
        }
      }
    }

    // Composite the offscreen canvas over the clean background
    // Where content was erased (transparent on offscreen), the white+grid shows through
    // Where content remains, it covers the white+grid
    ctx.drawImage(offscreen, 0, 0);

    // Draw eraser preview circle (size indicator)
    if (this.eraserPreviewVisible) {
      ctx.save();
      ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
      
      const previewRadius = this.eraserPreviewSize / 2;
      
      // Outer circle - semi-transparent blue outline
      ctx.beginPath();
      ctx.arc(this.eraserPreviewX, this.eraserPreviewY, previewRadius, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(33, 150, 243, 0.8)";
      ctx.lineWidth = 2 / this.scale;
      ctx.stroke();
      
      // Crosshair in the center
      const crossSize = 6 / this.scale;
      ctx.strokeStyle = "rgba(33, 150, 243, 0.5)";
      ctx.lineWidth = 1 / this.scale;
      ctx.beginPath();
      ctx.moveTo(this.eraserPreviewX - crossSize, this.eraserPreviewY);
      ctx.lineTo(this.eraserPreviewX + crossSize, this.eraserPreviewY);
      ctx.moveTo(this.eraserPreviewX, this.eraserPreviewY - crossSize);
      ctx.lineTo(this.eraserPreviewX, this.eraserPreviewY + crossSize);
      ctx.stroke();
      
      ctx.restore();
    }

    // Draw selection transform handles on the selected image (in transformed space)
    if (this.selectedActionId) {
      const selAction = this.actions.find(
        (a) => a.id === this.selectedActionId,
      );
      if (
        selAction &&
        (selAction.type === "image" || selAction.type === "text")
      ) {
        ctx.save();
        ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);
        this._drawTransformHandles(ctx, selAction);
        ctx.restore();
      }
    }
  }

  _drawTransformHandles(ctx, action) {
    // Для текста вычисляем размеры динамически
    let x, y, width, height;

    if (action.type === "text") {
      x = action.x;
      y = action.y;
      const s = action.scale || 1;
      // Измеряем ширину самой длинной строки с учётом scale
      ctx.font = `${action.size * s}px ${action.font || "Arial"}`;
      const lines = action.text.split("\n");
      width = Math.max(...lines.map((line) => ctx.measureText(line).width));
      height = action.size * s * 1.2 * lines.length; // lineHeight × кол-во строк × scale
    } else {
      // Для изображения используем сохранённые размеры
      ({ x, y, width, height } = action);
    }

    const handleSize = 8 / this.scale;
    const halfHandle = handleSize / 2;

    // Selection border (dashed)
    ctx.strokeStyle = "#2196F3";
    ctx.lineWidth = 2 / this.scale;
    ctx.setLineDash([4 / this.scale, 4 / this.scale]);
    ctx.strokeRect(x, y, width, height);
    ctx.setLineDash([]);

    // Draw 8 resize handles
    const positions = [
      { cx: x, cy: y }, // tl
      { cx: x + width / 2, cy: y }, // tm
      { cx: x + width, cy: y }, // tr
      { cx: x + width, cy: y + height / 2 }, // mr
      { cx: x + width, cy: y + height }, // br
      { cx: x + width / 2, cy: y + height }, // bm
      { cx: x, cy: y + height }, // bl
      { cx: x, cy: y + height / 2 }, // ml
    ];

    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#2196F3";
    ctx.lineWidth = 1.5 / this.scale;

    for (const pos of positions) {
      ctx.fillRect(
        pos.cx - halfHandle,
        pos.cy - halfHandle,
        handleSize,
        handleSize,
      );
      ctx.strokeRect(
        pos.cx - halfHandle,
        pos.cy - halfHandle,
        handleSize,
        handleSize,
      );
    }
  }

  // Draw a stroke (line segments) from saved data
  drawStroke(stroke) {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;

    // For eraser, just do a full re-render since this.actions already includes the new stroke
    if (stroke.tool === "eraser") {
      this.render();
      return;
    }

    // Normal stroke: draw directly
    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.globalCompositeOperation = "source-over";

    const points = stroke.points;
    if (points.length > 0) {
      ctx.moveTo(points[0].x, points[0].y);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  // Draw text from saved data
  drawText(textData) {
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(this.scale, 0, 0, this.scale, this.offsetX, this.offsetY);

    ctx.font = `${textData.size}px ${textData.font || "Arial"}`;
    ctx.fillStyle = textData.color;
    ctx.textBaseline = "top";

    // Wrap text if needed
    const lines = textData.text.split("\n");
    const lineHeight = textData.size * 1.2;
    lines.forEach((line, i) => {
      ctx.fillText(line, textData.x, textData.y + i * lineHeight);
    });

    ctx.restore();
  }

  // Re-render all actions from the actions array
  renderAllActions(actions) {
    this.actions = actions;
    // Preload any new images, then render
    this.preloadImages(actions, () => {
      this.render();
    });
  }
}