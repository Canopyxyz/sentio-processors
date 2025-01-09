// Global sequential lock for event processing
export class EventProcessingLock {
  private currentOperation: Promise<void> = Promise.resolve();

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        console.error("Event processing error:", error);
        throw error; // Re-throw to ensure proper error handling
      }
    };

    // Queue this operation behind any existing ones
    const result = this.currentOperation.then(execute);

    // Update the current operation, ensuring cleanup happens
    this.currentOperation = result.then(
      () => {}, // Success case
      () => {}, // Error case - ensure chain continues even after error
    );

    return result;
  }
}
