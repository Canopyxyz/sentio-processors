export class EventProcessingLock {
  private currentOperation: Promise<unknown> = Promise.resolve();

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    // Create a new promise that will become the currentOperation
    let releaseLock: () => void;
    const newLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    try {
      // Wait for any previous operation to complete
      await this.currentOperation;

      // Set this operation as the current one
      this.currentOperation = newLock;

      // Execute the operation
      const result = await operation();

      return result;
    } finally {
      // Release the lock after operation completes or fails
      releaseLock!();
    }
  }
}
