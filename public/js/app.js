/**
 * App - Main application entry point that ties all modules together
 */
class App {
  constructor() {
    this.canvasManager = new CanvasManager("canvas-container", "draw-canvas");
    this.toolsManager = new ToolsManager();
    this.wsManager = new WebSocketManager();
    this.undoRedoManager = new UndoRedoManager();

    // UI buttons
    this.undoBtn = document.getElementById("btn-undo");
    this.redoBtn = document.getElementById("btn-redo");

    // Image placement state
    this.pendingImageData = null;

    this.setupCallbacks();
    this.setupWebSocketCallbacks();
    this.setupUndoRedoButtons();
  }

  setupUndoRedoButtons() {
    this.undoBtn.addEventListener("click", () => this.handleUndo());
    this.redoBtn.addEventListener("click", () => this.handleRedo());
  }

  handleUndo() {
    const actions = this.toolsManager.getActions();
    if (actions.length === 0) return;

    // Get the last action and remove it locally
    const lastAction = actions.pop();
    this.undoRedoManager.pushToRedo(lastAction);

    // Re-render canvas
    this.canvasManager.renderAllActions(actions);

    // Notify server to remove this action from all clients
    this.wsManager.sendUndo({ id: lastAction.id });

    this.updateUndoRedoButtons();
  }

  handleRedo() {
    const action = this.undoRedoManager.popRedo();
    if (!action) return;

    const actions = this.toolsManager.getActions();
    actions.push(action);

    // Full re-render to ensure canvas state is correct
    this.canvasManager.renderAllActions(actions);

    // Notify server to re-add this action
    this.wsManager.sendRedo({ action });

    this.updateUndoRedoButtons();
  }

  updateUndoRedoButtons() {
    const actions = this.toolsManager.getActions();
    const redoLen = this.undoRedoManager.redoStack.length;
    this.undoBtn.disabled = actions.length === 0;
    this.redoBtn.disabled = redoLen === 0;
  }

  setupCallbacks() {
    // Drawing callbacks
    this.canvasManager.onDrawStart = (x, y) => {
      if (this.toolsManager.currentTool === "text") {
        this.handleTextInput(x, y);
        return;
      }
      this.toolsManager.startDrawing(x, y);
    };

    this.canvasManager.onDrawMove = (x, y) => {
      if (this.toolsManager.currentTool === "text") return;

      const tool = this.toolsManager;
      if (tool.isDrawing && tool.currentStroke) {
        // Render all existing actions + the in-progress stroke
        const actions = tool.getActions();
        const tempActions = [...actions];

        // Add the current stroke with the new point added
        const updatedStroke = JSON.parse(JSON.stringify(tool.currentStroke));
        updatedStroke.points.push({ x, y });
        tempActions.push(updatedStroke);

        this.canvasManager.renderAllActions(tempActions);

        // Now record the point in the actual stroke
        tool.continueDrawing(x, y);
      }
    };

    this.canvasManager.onDrawEnd = (x, y) => {
      if (this.toolsManager.currentTool === "text") return;
      const wasDrawing = this.toolsManager.isDrawing;
      this.toolsManager.endDrawing(x, y);

      // Only clear redo stack if a new action was actually created
      if (wasDrawing) {
        this.undoRedoManager.clearRedoStack();
      }

      // Re-render all actions to get a clean canvas with all finalized strokes
      const actions = this.toolsManager.getActions();
      this.canvasManager.renderAllActions(actions);

      this.updateUndoRedoButtons();
    };

    // Image selected callback - store data for placement on canvas click
    this.toolsManager.onImageSelected = (imageData) => {
      this.pendingImageData = imageData;
      // Switch to image tool to show it's active
      this.toolsManager.selectTool("image");
    };

    // Canvas click callback - used for placing images
    this.canvasManager.onCanvasClick = (x, y) => {
      if (this.pendingImageData && this.toolsManager.currentTool === "image") {
        this.placeImage(x, y);
      }
    };

    // Transform end callback - sends image transform to other users
    this.canvasManager.onTransformEnd = (actionId, newX, newY, newW, newH) => {
      this.wsManager.sendTransform({
        id: actionId,
        x: newX,
        y: newY,
        width: newW,
        height: newH,
      });
    };

    // Tool action callback - sends actions to other users via WebSocket
    this.toolsManager.onActionCreated = (action) => {
      if (action.type === "stroke") {
        this.wsManager.sendDraw({
          type: "stroke",
          tool: action.tool,
          color: action.color,
          size: action.size,
          points: action.points,
          username: action.username,
          id: action.id,
        });
      } else if (action.type === "text") {
        this.wsManager.sendText({
          type: "text",
          text: action.text,
          x: action.x,
          y: action.y,
          color: action.color,
          size: action.size,
          font: action.font,
          username: action.username,
          id: action.id,
        });
      } else if (action.type === "image") {
        this.wsManager.sendImage({
          type: "image",
          x: action.x,
          y: action.y,
          width: action.width,
          height: action.height,
          data: action.data,
          username: action.username,
          id: action.id,
        });
      }
    };

    // Clear callback
    this.toolsManager.onClearRequest = () => {
      this.undoRedoManager.clearRedoStack();
      this.wsManager.sendClear();
    };
  }

  setupWebSocketCallbacks() {
    this.wsManager.onInit = (actions) => {
      this.toolsManager.setActions(actions);
      this.canvasManager.renderAllActions(actions);
      this.updateUndoRedoButtons();
    };

    this.wsManager.onDraw = (data) => {
      const actions = this.toolsManager.getActions();
      actions.push(data);
      this.canvasManager.drawStroke(data);
      // New action from another user clears redo stack
      this.undoRedoManager.clearRedoStack();
      this.updateUndoRedoButtons();
    };

    this.wsManager.onImage = (data) => {
      const actions = this.toolsManager.getActions();
      actions.push(data);
      this.canvasManager.renderAllActions(actions);
      // New action from another user clears redo stack
      this.undoRedoManager.clearRedoStack();
      this.updateUndoRedoButtons();
    };

    this.wsManager.onText = (data) => {
      const actions = this.toolsManager.getActions();
      actions.push(data);
      this.canvasManager.drawText(data);
      // New action from another user clears redo stack
      this.undoRedoManager.clearRedoStack();
      this.updateUndoRedoButtons();
    };

    this.wsManager.onClear = () => {
      this.toolsManager.setActions([]);
      this.undoRedoManager.clearRedoStack();
      this.canvasManager.renderAllActions([]);
      this.updateUndoRedoButtons();
    };

    this.wsManager.onUndo = (data) => {
      const actions = this.toolsManager.getActions();
      const removed = this.undoRedoManager.removeActionById(actions, data.id);
      if (removed) {
        this.canvasManager.renderAllActions(actions);
        this.updateUndoRedoButtons();
      }
    };

    this.wsManager.onRedo = (data) => {
      if (data.action) {
        const actions = this.toolsManager.getActions();
        actions.push(data.action);
        this.canvasManager.renderAllActions(actions);
        this.updateUndoRedoButtons();
      }
    };

    this.wsManager.onTransform = (data) => {
      const actions = this.toolsManager.getActions();
      const action = actions.find((a) => a.id === data.id);
      if (action && (action.type === "image" || action.type === "text")) {
        action.x = data.x;
        action.y = data.y;
        action.width = data.width;
        action.height = data.height;
        this.canvasManager.renderAllActions(actions);
      }
    };
  }

  handleTextInput(x, y) {
    // For desktop: use prompt
    // For mobile/touch: show a custom popup
    const isTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;

    if (isTouch) {
      this.showTouchTextPopup(x, y);
    } else {
      const text = prompt("Enter text:", "");
      if (text && text.trim()) {
        const tool = this.toolsManager;
        const size = Math.max(12, tool.size * 3);
        const newText = tool.addTextAction(
          x,
          y,
          text,
          tool.color,
          size,
          "Arial",
        );
        // Выделить текст для трансформации сразу после создания
        if (newText) {
          this.canvasManager.selectImageAction(newText.id);
        }
        // Re-render all actions including the new text
        this.canvasManager.renderAllActions(tool.getActions());
        this.undoRedoManager.clearRedoStack();
        this.updateUndoRedoButtons();
      }
    }
  }

  placeImage(x, y) {
    if (!this.pendingImageData) return;

    // Default image size on canvas
    const defaultWidth = 300;
    const defaultHeight = 200;

    // Use the pending image data
    const data = this.pendingImageData;

    // Create a temporary Image to get natural dimensions
    const img = new Image();
    img.onload = () => {
      // Calculate proportional size, max 500px wide
      let w = img.naturalWidth;
      let h = img.naturalHeight;
      const maxW = 500;
      const maxH = 400;
      if (w > maxW) {
        h = h * (maxW / w);
        w = maxW;
      }
      if (h > maxH) {
        w = w * (maxH / h);
        h = maxH;
      }

      const tool = this.toolsManager;
      const action = tool.addImageAction(x, y, data, w, h);
      this.canvasManager.renderAllActions(tool.getActions());
      this.undoRedoManager.clearRedoStack();
      this.updateUndoRedoButtons();

      // Auto-select the image so it can be moved/resized immediately
      if (action) {
        this.canvasManager.selectImageAction(action.id);
      }

      // Clear pending image
      this.pendingImageData = null;
    };
    img.onerror = () => {
      // If image fails to load, still place with default size
      const tool = this.toolsManager;
      const action = tool.addImageAction(
        x,
        y,
        data,
        defaultWidth,
        defaultHeight,
      );
      this.canvasManager.renderAllActions(tool.getActions());
      this.undoRedoManager.clearRedoStack();
      this.updateUndoRedoButtons();

      // Auto-select the image
      if (action) {
        this.canvasManager.selectImageAction(action.id);
      }

      this.pendingImageData = null;
    };
    img.src = data;
  }

  showTouchTextPopup(x, y) {
    // Remove existing popup if any
    const existing = document.querySelector(".text-input-popup");
    if (existing) existing.remove();

    const popup = document.createElement("div");
    popup.className = "text-input-popup";
    popup.style.left = "50%";
    popup.style.top = "50%";
    popup.style.transform = "translate(-50%, -50%)";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Enter text...";
    input.autofocus = true;

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "popup-actions";

    const cancelBtn = document.createElement("button");
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", () => popup.remove());

    const okBtn = document.createElement("button");
    okBtn.className = "primary";
    okBtn.textContent = "OK";
    okBtn.addEventListener("click", () => {
      const text = input.value;
      if (text.trim()) {
        const tool = this.toolsManager;
        const size = Math.max(12, tool.size * 3);
        const newText = tool.addTextAction(
          x,
          y,
          text,
          tool.color,
          size,
          "Arial",
        );
        // Выделить текст для трансформации сразу после создания
        if (newText) {
          this.canvasManager.selectImageAction(newText.id);
        }
        // Re-render all actions including the new text
        this.canvasManager.renderAllActions(tool.getActions());
        this.undoRedoManager.clearRedoStack();
        this.updateUndoRedoButtons();
      }
      popup.remove();
    });

    // Handle Enter key
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        okBtn.click();
      }
    });

    actionsDiv.appendChild(cancelBtn);
    actionsDiv.appendChild(okBtn);
    popup.appendChild(input);
    popup.appendChild(actionsDiv);
    document.body.appendChild(popup);

    // Focus input after a short delay
    setTimeout(() => input.focus(), 100);
  }
}

// Initialize the app when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  new App();
});
