import type { DuplexStream } from '../types.js';
import { AsyncIterableMap } from '../util/async-iterable-map.js';
import { fromReader } from '../util/async-iterator.js';
import { collectFrames, concat } from '../util/frames.js';

export type BaseHeader = {
  version: number;
  flags: number;
  streamId: number;
};

export type DataHeader = BaseHeader & {
  type: MessageType['Data'];
  length: number;
};

export type WindowUpdateHeader = BaseHeader & {
  type: MessageType['WindowUpdate'];
  windowSize: number;
};

export type PingHeader = BaseHeader & {
  type: MessageType['Ping'];
  value: number;
};

export type GoAwayHeader = BaseHeader & {
  type: MessageType['GoAway'];
  errorCode: MessageErrorCode[keyof MessageErrorCode];
};

export type Header =
  | DataHeader
  | WindowUpdateHeader
  | PingHeader
  | GoAwayHeader;

export type DataMessage = DataHeader & { data: Uint8Array };

export type WindowUpdateMessage = WindowUpdateHeader;

export type PingMessage = PingHeader;

export type GoAwayMessage = GoAwayHeader;

export type Message =
  | DataMessage
  | WindowUpdateMessage
  | PingMessage
  | GoAwayMessage;

// Preferring `const` over `enum` for type trimming purposes
export const MessageType = {
  Data: 0x0,
  WindowUpdate: 0x1,
  Ping: 0x2,
  GoAway: 0x3,
} as const;

// Preferring `const` over `enum` for type trimming purposes
export const MessageFlag = {
  SYN: 0x1,
  ACK: 0x2,
  FIN: 0x4,
  RST: 0x8,
} as const;

// Preferring `const` over `enum` for type trimming purposes
export const MessageErrorCode = {
  NormalTermination: 0x0,
  ProtocolError: 0x1,
  InternalError: 0x2,
} as const;

export type MessageType = typeof MessageType;
export type MessageFlag = typeof MessageFlag;
export type MessageErrorCode = typeof MessageErrorCode;

export const headerLength = 12;

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
   * Whether or not to show debug logs. If a string is passed, logs will
   * be prefixed with its value.
   */
  debug?: boolean | string;
};

export class YamuxMultiplexer {
  private streams = new AsyncIterableMap<number, YamuxStream>();
  // private listener = new BufferedStream<DuplexStream<Uint8Array>>();
  private nextStreamId: number;
  private transportReader: ReadableStreamDefaultReader<Uint8Array>;
  private transportWriter: WritableStreamDefaultWriter<Uint8Array>;
  private streamAcks = new Map<
    number,
    { resolve: (stream: YamuxStream) => void; reject: (err: Error) => void }
  >();

  constructor(
    private transport: DuplexStream<Uint8Array>,
    private options: YamuxMultiplexerOptions
  ) {
    this.transportReader = this.transport.readable.getReader();
    this.transportWriter = this.transport.writable.getWriter();

    this.nextStreamId = options.transportDirection === 'outbound' ? 1 : 2;

    this.init();
  }

  private async init() {
    const messages = parseMessages(fromReader(this.transportReader));

    for await (const message of messages) {
      await new Promise((resolve) => setTimeout(resolve));
      await this.readMessage(message);
    }
  }

  private debug<D>(message: string, data: D) {
    if (this.options.debug) {
      if (typeof this.options.debug === 'string') {
        console.debug(`[${this.options.debug}] ${message}`, data);
      } else {
        console.debug(message, data);
      }
    }
  }

  private async readMessage(message: Message) {
    if (message.version !== 0) {
      throw new Error(`expected yamux version 0, received ${message.version}`);
    }

    this.debug('inbound message', message);

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

      await this.writeMessage({
        version: 0,
        type: MessageType.WindowUpdate,
        flags: MessageFlag.ACK,
        streamId: message.streamId,
        windowSize: 0,
      });

      stream = this.createLogicalStream(message.streamId);
    }
    // ACK from peer, create new stream
    else if (hasFlag(message.flags, MessageFlag.ACK)) {
      const ack = this.streamAcks.get(message.streamId);

      if (!ack) {
        console.warn(`received ACK before SYN for stream ${message.streamId}`);
        return;
      }

      this.streamAcks.delete(message.streamId);

      stream = this.createLogicalStream(message.streamId);
      ack.resolve(stream);
    }
    // RST from peer, reject new stream
    else if (hasFlag(message.flags, MessageFlag.RST)) {
      const ack = this.streamAcks.get(message.streamId);

      if (!ack) {
        console.warn(`received RST before SYN for stream ${message.streamId}`);
        return;
      }

      this.streamAcks.delete(message.streamId);

      ack.reject(new Error('connection rejected by peer'));
      return;
    } else {
      stream = this.streams.get(message.streamId);
    }

    if (!stream) {
      console.warn(`unknown stream with ID ${message.streamId}`);
      return;
    }

    switch (message.type) {
      case MessageType.Data: {
        if (message.data.byteLength > 0) {
          stream.addChunk(message.data);
        }
        break;
      }
      case MessageType.WindowUpdate: {
        stream.windowSize += message.windowSize;
        break;
      }
      default: {
        console.warn(
          `unknown message type ${message.type} with non-zero stream ID`
        );
      }
    }

    if (hasFlag(message.flags, MessageFlag.FIN)) {
      stream.markReadClosed();
    }
  }

  private async writeMessage(message: Message) {
    this.debug('outbound message', message);

    const header = serializeHeader(message);
    const frame =
      message.type === MessageType.Data ? concat(header, message.data) : header;

    await this.transportWriter.write(frame);
  }

  /**
   * Listens for incoming logical streams over the underlying transport.
   *
   * @returns A `ReadableStream` of logical duplex streams (stream of streams).
   * Can be iterated over using the `for await ... of` syntax.
   */
  listen(): AsyncIterable<DuplexStream<Uint8Array>> {
    return this.streams;
  }

  /**
   * Creates an outgoing logical stream over the underlying transport.
   *
   * @returns The logical duplex stream created.
   */
  async connect(): Promise<DuplexStream<Uint8Array>> {
    const streamId = this.getNextStreamId();

    await this.writeMessage({
      version: 0,
      type: MessageType.WindowUpdate,
      flags: MessageFlag.SYN,
      streamId,
      windowSize: 0,
    });

    // Wait for ACK or RST from peer
    const stream = await new Promise<YamuxStream>((resolve, reject) => {
      this.streamAcks.set(streamId, { resolve, reject });
    });

    return stream;
  }

  private getNextStreamId() {
    const nextStreamId = this.nextStreamId;

    // ID is always odd or always even depending on transport direction
    this.nextStreamId += 2;

    return nextStreamId;
  }

  private createLogicalStream(id?: number) {
    const streamId = id ?? this.getNextStreamId();

    const stream = new YamuxStream({
      id: streamId,
      writeMessage: async (chunk) => await this.writeMessage(chunk),
    });

    this.streams.set(streamId, stream);

    return stream;
  }
}

type LogicalStreamOptions = {
  id: number;
  writeMessage(message: Message): Promise<void>;
};

class YamuxStream implements DuplexStream<Uint8Array> {
  public id: number;
  public readable: ReadableStream<Uint8Array>;
  public writable: WritableStream<Uint8Array>;
  public windowSize = 256 * 1024;
  public buffer: Uint8Array[] = [];

  public isReadClosed = false;
  public isWriteClosed = false;

  public get isClosed() {
    return this.isReadClosed && this.isWriteClosed;
  }

  /**
   * Promise resolver that notifies the async iterator that
   * a new value has arrived.
   */
  private notifyReader?: () => void;

  public addChunk(chunk: Uint8Array) {
    this.buffer.push(chunk);
    this.notifyReader?.();
  }

  public markReadClosed() {
    this.isReadClosed = true;
    this.notifyReader?.();
  }

  constructor(private options: LogicalStreamOptions) {
    this.id = options.id;

    this.readable = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        while (this.buffer.length === 0) {
          // Close controller once marked as closed and buffer is empty
          if (this.isReadClosed) {
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            this.notifyReader = resolve;
          });
        }

        // biome-ignore lint/style/noNonNullAssertion: verified via while loop
        const chunk = this.buffer.shift()!;

        if (!this.isReadClosed) {
          // Increase peer's window every time a chunk is read
          await this.options.writeMessage({
            version: 0,
            type: MessageType.WindowUpdate,
            flags: 0,
            streamId: this.id,
            windowSize: chunk.byteLength,
          });
        }

        controller.enqueue(chunk);
      },
    });

    this.writable = new WritableStream<Uint8Array>({
      write: async (chunk) => {
        const length = chunk.byteLength;

        while (length > this.windowSize) {
          // Yield to the event loop
          await new Promise<void>((resolve) => setTimeout(resolve));
        }

        this.windowSize -= length;

        await options.writeMessage({
          version: 0,
          type: MessageType.Data,
          flags: 0,
          streamId: this.id,
          length,
          data: chunk,
        });
      },
      close: async () => {
        await options.writeMessage({
          version: 0,
          type: MessageType.Data,
          flags: MessageFlag.FIN,
          streamId: this.id,
          length: 0,
          data: new Uint8Array(),
        });
        this.isWriteClosed = true;
      },
    });
  }
}

/**
 * Buffers partial byte chunks and yields parsed Yamux messages
 * as they become available.
 */
export async function* parseMessages(
  chunks: AsyncIterable<Uint8Array>
): AsyncIterable<Message> {
  const frames = collectFrames(chunks, {
    // Yamux headers are always 12 bytes
    headerLength,

    // Yamux frame lengths depends on the contents of the header
    frameLength(headerBytes) {
      const header = parseHeader(headerBytes);

      // Frame length is header + data for data messages, otherwise just header
      return (
        headerBytes.byteLength +
        (header.type === MessageType.Data ? header.length : 0)
      );
    },
  });

  // Parse and yield each frame
  for await (const frame of frames) {
    yield parseMessage(frame);
  }
}

export function parseMessage(message: Uint8Array): Message {
  const header = parseHeader(message);

  if (header.type === MessageType.Data) {
    const data = message.subarray(headerLength, headerLength + header.length);
    return { ...header, data };
  }

  return header;
}

/**
 * Parses the header from a Yamux message frame.
 */
export function parseHeader(message: Uint8Array): Header {
  if (message.length < headerLength) {
    throw new Error('not enough bytes to parse header');
  }

  const dataView = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength
  );

  const version = dataView.getUint8(0);
  const type = dataView.getUint8(1);
  const flags = dataView.getUint16(2);
  const streamId = dataView.getUint32(4);

  switch (type) {
    case MessageType.Data: {
      const length = dataView.getUint32(8);

      return {
        version,
        type,
        flags,
        streamId,
        length,
      };
    }
    case MessageType.WindowUpdate: {
      const windowSize = dataView.getUint32(8);

      return {
        version,
        type,
        flags,
        streamId,
        windowSize,
      };
    }
    case MessageType.Ping: {
      const value = dataView.getUint32(8);

      return {
        version,
        type,
        flags,
        streamId,
        value,
      };
    }
    case MessageType.GoAway: {
      const errorCode = dataView.getUint32(8);

      if (
        errorCode !== MessageErrorCode.NormalTermination &&
        errorCode !== MessageErrorCode.ProtocolError &&
        errorCode !== MessageErrorCode.InternalError
      ) {
        throw new Error(`unknown error code ${errorCode}`);
      }

      return {
        version,
        type,
        flags,
        streamId,
        errorCode,
      };
    }
  }

  throw new Error(`unknown message type: ${type}`);
}

export function hasFlag(flags: number, flag: number) {
  return (flags & flag) === flag;
}

/**
 * Serializes a header into bytes.
 */
export function serializeHeader(header: Header) {
  const headerBytes = new Uint8Array(12);
  const dataView = new DataView(
    headerBytes.buffer,
    headerBytes.byteOffset,
    headerBytes.byteLength
  );

  dataView.setUint8(0, header.version);
  dataView.setUint8(1, header.type);
  dataView.setUint16(2, header.flags);
  dataView.setUint32(4, header.streamId);

  switch (header.type) {
    case MessageType.Data: {
      dataView.setUint32(8, header.length);
      break;
    }
    case MessageType.WindowUpdate: {
      dataView.setUint32(8, header.windowSize);
      break;
    }
    case MessageType.Ping: {
      dataView.setUint32(8, header.value);
      break;
    }
    case MessageType.GoAway: {
      dataView.setUint32(8, header.errorCode);
      break;
    }
    default: {
      const { type } = header;
      throw new Error(`unknown header type '${type}'`);
    }
  }

  return headerBytes;
}
