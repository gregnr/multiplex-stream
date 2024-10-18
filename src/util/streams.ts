import type { DuplexStream } from '../types';

/**
 * A passthrough `DuplexStream` that buffers data to support
 * asynchronous reads and writes.
 */
export class BufferedStream<T> implements DuplexStream<T> {
  public readable: ReadableStream<T>;
  public writable: WritableStream<T>;

  constructor() {
    const buffer: T[] = [];

    this.readable = new ReadableStream<T>({
      async pull(controller) {
        while (buffer.length === 0) {
          // Yield to the event loop
          await new Promise<void>((resolve) => setTimeout(resolve));
        }
        // biome-ignore lint/style/noNonNullAssertion: <explanation>
        const chunk = buffer.shift()!;
        controller.enqueue(chunk);
      },
    });

    this.writable = new WritableStream<T>({
      async write(chunk) {
        buffer.push(chunk);

        // Yield to the event loop
        await new Promise<void>((resolve) => setTimeout(resolve));
      },
    });
  }
}

/**
 * Creates a pair of linked duplex streams.
 *
 * The returned duplex streams are interconnected such that writing to the
 * writable stream of one duplex will result in the data appearing on the
 * readable stream of the other duplex, and vice versa. This can be useful
 * for simulating a bidirectional communication channel or virtual socket.
 */
export function createDuplexPair<T>(): [DuplexStream<T>, DuplexStream<T>] {
  // Intermediate streams that forward writable to readable
  const aToB = new BufferedStream<T>();
  const bToA = new BufferedStream<T>();

  // Swap readable and writable to link duplex connections
  const duplexA: DuplexStream<T> = {
    readable: bToA.readable,
    writable: aToB.writable,
  };
  const duplexB: DuplexStream<T> = {
    readable: aToB.readable,
    writable: bToA.writable,
  };

  return [duplexA, duplexB];
}
