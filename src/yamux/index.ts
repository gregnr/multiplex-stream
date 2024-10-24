import type { DuplexStream } from '../types.js';
import { AsyncIterableMap } from '../util/async-iterable-map.js';
import { fromReader } from '../util/async-iterator.js';
import { concat } from '../util/frames.js';
import { type Message, MessageFlag, MessageType } from './types.js';
import { hasFlag, parseMessages, serializeHeader } from './util.js';

export * from './types.js';
export * from './util.js';

export const headerLength = 12;
export const defaultWindowSize = 256 * 1024;

export type YamuxMultiplexerOptions = {
  /**
   * The direction of communication for the underlying transport
   * where `outbound` represents a client-to-server connection and
   * `inbound` represents a server-to-client connection.
   *
   * This is required by the Yamux protocol to prevent stream ID
   * collisions. Streams that are initiated from the client side of the
   * underlying transport will have odd IDs while streams initiated from
   * the server side of the underlying transport will have even IDs.
   */
  transportDirection: 'outbound' | 'inbound';

  /**
   * Default max buffer size for each new stream (in bytes). Must be
   * a minimum of 256KB. Defaults to 256KB as per the Yamux spec.
   *
   * **Background:** Since readable streams are pull-based, incoming
   * messages need to be buffered in memory until they are read.
   * This defines the maximum number of bytes that can be buffered per stream.
   * Note that flow control (backpressure) is built in to the Yamux protocol,
   * so the other side of the stream will respect this limit.
   */
  defaultMaxBufferSize?: number;

  /**
   * Whether or not to show debug logs. If a string is passed, logs will
   * be prefixed with its value.
   */
  debug?: boolean | string;
};

export class YamuxMultiplexer {
  #options: YamuxMultiplexerOptions;
  #transport: DuplexStream<Uint8Array>;
  #transportReader: ReadableStreamDefaultReader<Uint8Array>;
  #transportWriter: WritableStreamDefaultWriter<Uint8Array>;
  #nextStreamId: number;
  #streams = new AsyncIterableMap<number, YamuxStream>();
  #pendingStreams = new Map<
    number,
    {
      resolve: (stream: YamuxStream) => void;
      reject: (err: Error) => void;
      options: YamuxStreamOptions;
    }
  >();

  constructor(
    transport: DuplexStream<Uint8Array>,
    options: YamuxMultiplexerOptions
  ) {
    if (
      options.defaultMaxBufferSize &&
      options.defaultMaxBufferSize < defaultWindowSize
    ) {
      throw new Error('defaultMaxBufferSize must be a minimum of 256KB');
    }

    this.#options = options;
    this.#transport = transport;
    this.#transportReader = this.#transport.readable.getReader();
    this.#transportWriter = this.#transport.writable.getWriter();
    this.#nextStreamId = options.transportDirection === 'outbound' ? 1 : 2;

    this.#init();
  }

  async #init() {
    const messages = parseMessages(fromReader(this.#transportReader));

    for await (const message of messages) {
      await this.#readMessage(message);
    }
  }

  #debug<D>(message: string, data: D) {
    if (this.#options.debug) {
      if (typeof this.#options.debug === 'string') {
        console.debug(`[${this.#options.debug}] ${message}`, data);
      } else {
        console.debug(message, data);
      }
    }
  }

  async #readMessage(message: Message) {
    if (message.version !== 0) {
      throw new Error(`expected yamux version 0, received ${message.version}`);
    }

    this.#debug('inbound message', message);

    if (message.streamId === 0) {
      switch (message.type) {
        case MessageType.Ping: {
          // TODO: pong
          break;
        }
        case MessageType.GoAway: {
          // TODO: terminate transport session
          break;
        }
        default: {
          console.warn(
            `unknown message type ${message.type} when stream ID is 0`
          );
        }
      }
      return;
    }

    let stream: YamuxStream | undefined;

    // New stream from peer, send ACK to confirm or RST to reject
    if (hasFlag(message.flags, MessageFlag.SYN)) {
      // TODO: support max # streams and reject via RST

      const maxBufferSize =
        this.#options.defaultMaxBufferSize ?? defaultWindowSize;

      await this.#writeMessage({
        version: 0,
        type: MessageType.WindowUpdate,
        flags: MessageFlag.ACK,
        streamId: message.streamId,
        windowSize: maxBufferSize - defaultWindowSize,
      });

      stream = this.#createLogicalStream(message.streamId, {
        maxBufferSize,
      });
    }
    // ACK from peer, create new stream
    else if (hasFlag(message.flags, MessageFlag.ACK)) {
      const pendingStream = this.#pendingStreams.get(message.streamId);

      if (!pendingStream) {
        console.warn(`received ACK before SYN for stream ${message.streamId}`);
        return;
      }

      this.#pendingStreams.delete(message.streamId);

      stream = this.#createLogicalStream(
        message.streamId,
        pendingStream.options
      );
      pendingStream.resolve(stream);
    }
    // RST from peer, reject new stream
    else if (hasFlag(message.flags, MessageFlag.RST)) {
      const pendingStream = this.#pendingStreams.get(message.streamId);

      if (!pendingStream) {
        console.warn(`received RST before SYN for stream ${message.streamId}`);
        return;
      }

      this.#pendingStreams.delete(message.streamId);

      pendingStream.reject(new Error('connection rejected by peer'));
      return;
    } else {
      stream = this.#streams.get(message.streamId);
    }

    if (!stream) {
      console.warn(`unknown stream with ID ${message.streamId}`);
      return;
    }

    switch (message.type) {
      case MessageType.Data: {
        if (message.data.byteLength > 0) {
          getInternals(stream).addChunk(message.data);
        }
        break;
      }
      case MessageType.WindowUpdate: {
        getInternals(stream).increaseWindow(message.windowSize);
        break;
      }
      default: {
        console.warn(
          `unknown message type ${message.type} with non-zero stream ID`
        );
      }
    }

    if (hasFlag(message.flags, MessageFlag.FIN)) {
      getInternals(stream).closeRead();
    }
  }

  async #writeMessage(message: Message) {
    this.#debug('outbound message', message);

    const header = serializeHeader(message);
    const frame =
      message.type === MessageType.Data ? concat(header, message.data) : header;

    await this.#transportWriter.write(frame);
  }

  #getNextStreamId() {
    const nextStreamId = this.#nextStreamId;

    // ID is always odd or always even depending on transport direction
    this.#nextStreamId += 2;

    return nextStreamId;
  }

  #createLogicalStream(id: number, options: YamuxStreamOptions) {
    const stream = new YamuxStream(id, options, {
      writeMessage: async (message) => await this.#writeMessage(message),
    });

    this.#streams.set(id, stream);

    return stream;
  }

  /**
   * Listens for incoming logical streams over the underlying transport.
   *
   * @returns An `AsyncIterator` of logical duplex streams.
   * Can be iterated over using the `for await ... of` syntax.
   */
  async *listen(): AsyncIterableIterator<DuplexStream<Uint8Array>> {
    for await (const stream of this.#streams) {
      // Only yield incoming logical streams
      if (stream.transportDirection !== this.#options.transportDirection) {
        yield stream;
      }
    }
  }

  /**
   * Creates an outgoing logical stream over the underlying transport.
   *
   * @returns The logical duplex stream created.
   */
  async connect(options: YamuxStreamOptions = {}) {
    if (options.maxBufferSize && options.maxBufferSize < defaultWindowSize) {
      throw new Error('maxBufferSize must be a minimum of 256KB');
    }

    const streamId = this.#getNextStreamId();
    const maxBufferSize =
      options.maxBufferSize ??
      this.#options.defaultMaxBufferSize ??
      defaultWindowSize;

    // Wait for ACK or RST from peer
    const streamPromise = new Promise<YamuxStream>((resolve, reject) => {
      this.#pendingStreams.set(streamId, {
        resolve,
        reject,
        options: {
          maxBufferSize,
        },
      });
    });

    await this.#writeMessage({
      version: 0,
      type: MessageType.WindowUpdate,
      flags: MessageFlag.SYN,
      streamId,
      windowSize: maxBufferSize - defaultWindowSize,
    });

    const stream = await streamPromise;

    return stream;
  }
}

export type YamuxStreamOptions = {
  /**
   * Max buffer size for the stream stream (in bytes). Must be
   * a minimum of 256KB. Defaults to 256KB as per the Yamux spec.
   *
   * **Background:** Since readable streams are pull-based, incoming
   * messages need to be buffered in memory until they are read.
   * This defines the maximum number of bytes that can be buffered per stream.
   * Note that flow control (backpressure) is built in to the Yamux protocol,
   * so the other side of the stream will respect this limit.
   */
  maxBufferSize?: number;
};

export type YamuxStreamAdapters = {
  writeMessage(message: Message): Promise<void>;
};

export class YamuxStream implements DuplexStream<Uint8Array> {
  id: number;
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;

  #windowSize = defaultWindowSize;
  #maxBufferSize: number;
  #buffer: Uint8Array[] = [];
  #isReadClosed = false;
  #isWriteClosed = false;

  get #bufferSize() {
    return this.#buffer.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  }

  get isReadClosed() {
    return this.#isReadClosed;
  }

  get isWriteClosed() {
    return this.#isWriteClosed;
  }

  get isClosed() {
    return this.#isReadClosed && this.#isWriteClosed;
  }

  get transportDirection() {
    return this.id % 2 === 1 ? 'outbound' : 'inbound';
  }

  /**
   * Promise resolver that notifies the async iterator that
   * a new value has arrived.
   */
  #notifyReader?: () => void;

  /**
   * Promise resolver that notifies the writer that the
   * window size has changed.
   */
  #notifyWriter?: () => void;

  /**
   * Writes a message to the underlying transport.
   */
  #writeMessage: (message: Message) => Promise<void>;

  constructor(
    id: number,
    options: YamuxStreamOptions,
    adapters: YamuxStreamAdapters
  ) {
    if (options.maxBufferSize && options.maxBufferSize < defaultWindowSize) {
      throw new Error('maxBufferSize must be a minimum of 256KB');
    }

    this.id = id;
    this.#maxBufferSize = options.maxBufferSize ?? defaultWindowSize;
    this.#writeMessage = adapters.writeMessage;

    yamuxStreamInternals.set(this, {
      addChunk: (chunk: Uint8Array) => {
        this.#buffer.push(chunk);
        this.#notifyReader?.();
      },
      closeRead: () => {
        this.#isReadClosed = true;
        this.#notifyReader?.();
      },
      increaseWindow: (size: number) => {
        this.#windowSize += size;
        this.#notifyWriter?.();
      },
    });

    this.readable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (this.#buffer.length === 0) {
          // Close controller once marked as closed and buffer is empty
          if (this.#isReadClosed) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            this.#notifyReader = resolve;
          });
        }

        // biome-ignore lint/style/noNonNullAssertion: verified via while loop
        const chunk = this.#buffer.shift()!;

        if (!this.#isReadClosed) {
          // Increase peer's window every time a chunk is read
          await this.#writeMessage({
            version: 0,
            type: MessageType.WindowUpdate,
            flags: 0,
            streamId: this.id,
            windowSize: this.#maxBufferSize - this.#bufferSize,
          });
        }

        controller.enqueue(chunk);
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        let i = 0;

        while (i < chunk.byteLength) {
          while (this.#windowSize <= 0) {
            await new Promise<void>((resolve) => {
              this.#notifyWriter = resolve;
            });
          }

          const segment = chunk.subarray(i, i + this.#windowSize);
          i += this.#windowSize;
          this.#windowSize -= segment.byteLength;

          await this.#writeMessage({
            version: 0,
            type: MessageType.Data,
            flags: 0,
            streamId: this.id,
            length: segment.byteLength,
            data: segment,
          });
        }
      },
      close: async () => {
        await this.#writeMessage({
          version: 0,
          type: MessageType.Data,
          flags: MessageFlag.FIN,
          streamId: this.id,
          length: 0,
          data: new Uint8Array(),
        });
        this.#isWriteClosed = true;
      },
    });
  }
}

type YamuxStreamInternals = {
  /**
   * Adds a chunk to the stream's internal read buffer.
   */
  addChunk(chunk: Uint8Array): void;

  /**
   * Marks the stream as closed. The stream will continue
   * to yield chunks from its internal read buffer until empty,
   * then will close its readable stream.
   */
  closeRead(): void;

  /**
   * Increases the stream's window size by the specified amount.
   */
  increaseWindow(size: number): void;
};

const yamuxStreamInternals = new WeakMap<YamuxStream, YamuxStreamInternals>();

/**
 * Provides access to internal `YamuxStream` methods from outside its class.
 *
 * These internal methods need to be available to `YamuxMultiplexer`, but
 * shouldn't be accessible outside of this module.
 */
function getInternals(stream: YamuxStream) {
  const internals = yamuxStreamInternals.get(stream);

  if (!internals) {
    throw new Error(`internals do not exist for stream ${stream.id}`);
  }

  return internals;
}
