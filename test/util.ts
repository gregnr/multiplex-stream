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
