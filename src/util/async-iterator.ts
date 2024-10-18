/**
 * Converts a `AsyncIterator` into an `ReadableStream`.
 */
export function toReadable<T>(iterator: AsyncIterator<T>) {
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next();
        if (done) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/**
 * Converts a `ReadableStreamDefaultReader` into an `AsyncIterableIterator`.
 *
 * Allows you to use Readers in a `for await ... of` loop.
 */
export async function* fromReader<R>(
  reader: ReadableStreamDefaultReader<R>,
  options?: { preventCancel?: boolean }
): AsyncIterableIterator<R> {
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return value;
      }
      yield value;
    }
  } finally {
    if (!options?.preventCancel) {
      await reader.cancel();
    }
    reader.releaseLock();
  }
}

/**
 * Converts a `ReadableStream` into an `AsyncIterableIterator`.
 *
 * Allows you to use ReadableStreams in a `for await ... of` loop.
 */
export async function* fromReadable<R>(
  readable: ReadableStream<R>,
  options?: { preventCancel?: boolean }
): AsyncIterableIterator<R> {
  const reader = readable.getReader();
  yield* fromReader(reader, options);
}
