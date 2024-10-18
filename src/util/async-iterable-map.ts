/**
 * `Map` that implements `AsyncIterable` by asynchronously
 * yielding new values as they are set.
 */
export class AsyncIterableMap<K, V> extends Map<K, V> {
  /**
   * Queue of new values as they are arrive so that they can
   * be yielded via async iterator.
   */
  private newValues: V[] = [];

  /**
   * Promise resolver that notifies the async iterator that
   * a new value has arrived.
   */
  private notifyNewEntry?: () => void;

  override set(key: K, value: V): this {
    super.set(key, value);

    // This is relatively inexpensive since we just store the pointer
    this.newValues.push(value);
    this.notifyNewEntry?.();

    return this;
  }

  async *[Symbol.asyncIterator](): AsyncIterableIterator<V> {
    // First, yield existing values
    yield* this.newValues;

    // Continuously wait for new values to be added
    while (true) {
      await new Promise<void>((resolve) => {
        this.notifyNewEntry = resolve;
      });

      const value = this.newValues.shift();

      if (value) {
        yield value;
      }
    }
  }
}
