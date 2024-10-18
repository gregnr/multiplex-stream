import type { DuplexStream } from './types.js';
import {
  YamuxMultiplexer,
  type YamuxMultiplexerOptions,
} from './yamux/index.js';

export {
  type YamuxMultiplexer,
  type YamuxMultiplexerOptions,
} from './yamux/index.js';

export * from './types.js';

/**
 * Multiplexes bi-directional streams on top of an underlying transport stream.
 * The underlying transport must be a reliable link, such as a TCP connection
 * or higher level protocol like Web Socket.
 *
 * Returns a `YamuxMultiplexer` with a `listen()` method to accept new streams from
 * the other end of the connection and a `connect()` method to create new streams
 * to the other end of the connection.
 *
 * Both sides of the underlying connection must be wrapped with `multiplexStream()`
 * _(or with any other Yamux-compatible library - see below)_.
 * Once wrapped, either side can call `listen()` or `connect()` to listen for or
 * create new logical streams in either direction. This can be useful to create
 * reverse tunnels from a server to a client, or simply to create multiple streams
 * over a single underlying connection.
 *
 * Streams are multiplexed using the [Yamux](https://github.com/hashicorp/yamux/blob/master/spec.md)
 * protocol which supports flow control (back-pressure) and keep alives with little overhead.
 * Because Yamux is widely adopted, you can use this library with any other language or library
 * that implements the protocol.
 */
export async function multiplexStream(
  transport: DuplexStream<Uint8Array>,
  options: YamuxMultiplexerOptions
) {
  return new YamuxMultiplexer(transport, options);
}
