/**
 * UndoRedoManager - Manages undo/redo history for canvas actions
 * Works with the server to provide collaborative undo/redo
 */
class UndoRedoManager {
  constructor() {
    this.redoStack = [];
    this.isProcessing = false; // Prevent loops when receiving from server
  }

  /**
   * Push the last action to redo stack when a new action is created
   * (Clears redo stack because new actions invalidate redo history)
   */
  clearRedoStack() {
    this.redoStack = [];
  }

  /**
   * Store a removed action in the redo stack
   */
  pushToRedo(action) {
    this.redoStack.push(action);
  }

  /**
   * Get and remove the last redo action
   */
  popRedo() {
    return this.redoStack.pop();
  }

  /**
   * Remove an action by ID from the actions array
   */
  removeActionById(actions, actionId) {
    const index = actions.findIndex((a) => a.id === actionId);
    if (index !== -1) {
      const removed = actions.splice(index, 1)[0];
      return removed;
    }
    return null;
  }
}
