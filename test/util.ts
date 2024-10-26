import type { DuplexStream } from '../src/types';
import { fromReadable } from '../src/util/async-iterator';

export async function getFirstStream(
  streams: AsyncIterable<DuplexStream<Uint8Array>>
) {
  for await (const stream of streams) {
    return stream;
  }
  throw new Error('transport closed before stream arrived');
}

export async function collectStream<T>(stream: ReadableStream<T>) {
  const chunks: T[] = [];

  for await (const chunk of fromReadable(stream)) {
    chunks.push(chunk);
  }

  return chunks;
}

/**
 * Delays the readable side of a duplex stream by the specified
 * amount in milliseconds.
 */
export function delayStream<T>(
  duplex: DuplexStream<T>,
  delay: number
): DuplexStream<T> {
  return {
    readable: duplex.readable.pipeThrough(
      new TransformStream({
        async transform(chunk, controller) {
          await new Promise((r) => setTimeout(r, delay));
          controller.enqueue(chunk);
        },
      })
    ),
    writable: duplex.writable,
  };
}
