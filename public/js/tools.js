/**
 * ToolsManager - Manages drawing tools (pen, eraser, text, image) and UI state
 */
class ToolsManager {
  constructor() {
    this.currentTool = "pen";
    this.color = "#ff0000";
    this.size = 5;
    this.eraserSize = 20;

    // UI elements
    this.penBtn = document.getElementById("tool-pen");
    this.eraserBtn = document.getElementById("tool-eraser");
    this.textBtn = document.getElementById("tool-text");
    this.imageBtn = document.getElementById("tool-image");
    this.imageInput = document.getElementById("image-input");
    this.colorPicker = document.getElementById("color-picker");
    this.sizeSlider = document.getElementById("size-slider");
    this.sizeLabel = document.getElementById("size-label");

    // Current drawing state
    this.isDrawing = false;
    this.currentStroke = null;
    this.actions = [];

    // Pending image data (base64) after file selection
    this.pendingImageData = null;

    // Callbacks
    this.onActionCreated = null;
    this.onClearRequest = null;
    this.onImageSelected = null;
    this.onToolChange = null;
    this.onSizeChange = null;

    this.bindEvents();
  }

  bindEvents() {
    // Tool selection
    this.penBtn.addEventListener("click", () => this.selectTool("pen"));
    this.eraserBtn.addEventListener("click", () => this.selectTool("eraser"));
    this.textBtn.addEventListener("click", () => this.selectTool("text"));
    this.imageBtn.addEventListener("click", () => {
      this.selectTool("image");
      // Open file picker when image tool is clicked
      this.imageInput.click();
    });

    // File input for images
    this.imageInput.addEventListener("change", (e) => {
      const file = e.target.files[0];
      if (!file) return;

      // Validate file type
      if (!file.type.startsWith("image/")) {
        alert("Пожалуйста, выберите файл изображения (JPG, PNG, GIF, WebP)");
        this.imageInput.value = "";
        return;
      }

      // Validate file size (max 2MB raw - base64 encoding adds ~33% overhead,
      // fitting within the 5MB Socket.IO buffer limit)
      if (file.size > 2 * 1024 * 1024) {
        alert("Изображение слишком большое. Максимальный размер — 2 МБ.");
        this.imageInput.value = "";
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        this.pendingImageData = event.target.result;
        // Notify App that an image is ready to be placed
        if (this.onImageSelected) {
          this.onImageSelected(this.pendingImageData);
        }
      };
      reader.onerror = () => {
        alert("Не удалось прочитать файл изображения.");
        this.imageInput.value = "";
      };
      reader.readAsDataURL(file);
    });

    // Color change
    this.colorPicker.addEventListener("input", (e) => {
      this.color = e.target.value;
    });

    // Size change
    this.sizeSlider.addEventListener("input", (e) => {
      this.size = parseInt(e.target.value);
      // Keep eraserSize in sync when eraser is active
      if (this.currentTool === "eraser") {
        this.eraserSize = this.size;
      }
      this.sizeLabel.textContent = "Толщина: " + this.size;

      // Notify size change callback (for live preview updates)
      if (this.onSizeChange) {
        this.onSizeChange(this.currentTool === "eraser" ? this.eraserSize : this.size);
      }
    });

  }

  selectTool(tool) {
    this.currentTool = tool;

    // Update button active states
    [this.penBtn, this.eraserBtn, this.textBtn, this.imageBtn].forEach(
      (btn) => {
        btn.classList.toggle("active", btn.dataset.tool === tool);
      },
    );

    // Update size slider range based on tool
    if (tool === "eraser") {
      this.sizeSlider.max = 200;
      this.eraserSize = this.size;
      this.sizeLabel.textContent = "Толщина: " + this.eraserSize;
    } else {
      this.sizeSlider.max = 100;
      if (this.size > 100) {
        this.size = Math.min(this.size, 100);
        this.sizeSlider.value = this.size;
        this.sizeLabel.textContent = "Толщина: " + this.size;
      }
    }

    // Notify on tool change callback
    if (this.onToolChange) {
      this.onToolChange(tool);
    }
  }

  _generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  startDrawing(x, y) {
    if (this.currentTool === "text" || this.currentTool === "image") {
      return; // Text and Image are handled separately
    }

    this.isDrawing = true;
    const toolSize =
      this.currentTool === "eraser" ? this.eraserSize : this.size;

    this.currentStroke = {
      type: "stroke",
      tool: this.currentTool,
      color: this.color,
      size: toolSize,
      points: [{ x, y }],
      username: "Anonymous",
      id: this._generateId(),
    };
  }

  continueDrawing(x, y) {
    if (!this.isDrawing || !this.currentStroke) return;

    const lastPoint =
      this.currentStroke.points[this.currentStroke.points.length - 1];
    // Skip if too close to reduce data
    const dx = x - lastPoint.x;
    const dy = y - lastPoint.y;
    if (dx * dx + dy * dy < 4) return;

    this.currentStroke.points.push({ x, y });
  }

  endDrawing(x, y) {
    if (!this.isDrawing || !this.currentStroke) return;

    if (x !== null && y !== null) {
      const lastPoint =
        this.currentStroke.points[this.currentStroke.points.length - 1];
      const dx = x - lastPoint.x;
      const dy = y - lastPoint.y;
      if (dx * dx + dy * dy >= 4) {
        this.currentStroke.points.push({ x, y });
      }
    }

    // Only save if we have more than 1 point
    if (this.currentStroke.points.length >= 2) {
      this.actions.push(this.currentStroke);
      if (this.onActionCreated) {
        this.onActionCreated(this.currentStroke);
      }
    }

    this.isDrawing = false;
    this.currentStroke = null;
  }

  addTextAction(x, y, text, color, size, font) {
    if (!text || text.trim() === "") return;

    // Compute text bounding box
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    ctx.font = `${size}px ${font || "Arial"}`;
    const lines = text.split("\n");
    let maxW = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > maxW) maxW = w;
    }
    const lineH = size * 1.2;
    const totalH = lines.length * lineH;
    const padding = size * 0.3;

    const textAction = {
      type: "text",
      text: text,
      x: x,
      y: y,
      width: maxW + padding * 2,
      height: totalH + padding * 2,
      color: color,
      size: size,
      font: font || "Arial",
      username: "Anonymous",
      id: this._generateId(),
    };

    this.actions.push(textAction);
    if (this.onActionCreated) {
      this.onActionCreated(textAction);
    }
    return textAction;
  }

  addImageAction(x, y, data, width, height) {
    const imageAction = {
      type: "image",
      x: x,
      y: y,
      width: width,
      height: height,
      data: data,
      username: "Anonymous",
      id: this._generateId(),
    };

    this.actions.push(imageAction);
    if (this.onActionCreated) {
      this.onActionCreated(imageAction);
    }
    return imageAction;
  }

  setActions(actions) {
    this.actions = actions;
  }

  getActions() {
    return this.actions;
  }
}
