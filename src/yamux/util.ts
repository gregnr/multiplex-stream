import { headerLength } from './index.js';
import { collectFrames } from '../util/index.js';
import {
  type Header,
  type Message,
  MessageErrorCode,
  MessageType,
} from './types.js';

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

  assertUintBitSize(header.version, 8, 'header version');
  dataView.setUint8(0, header.version);

  assertUintBitSize(header.type, 8, 'header type');
  dataView.setUint8(1, header.type);

  assertUintBitSize(header.flags, 16, 'header flags');
  dataView.setUint16(2, header.flags);

  assertUintBitSize(header.streamId, 32, 'header stream id');
  dataView.setUint32(4, header.streamId);

  switch (header.type) {
    case MessageType.Data: {
      assertUintBitSize(header.length, 32, 'header length');
      dataView.setUint32(8, header.length);
      break;
    }
    case MessageType.WindowUpdate: {
      assertUintBitSize(header.windowSize, 32, 'header window size');
      dataView.setUint32(8, header.windowSize);
      break;
    }
    case MessageType.Ping: {
      assertUintBitSize(header.value, 32, 'header ping value');
      dataView.setUint32(8, header.value);
      break;
    }
    case MessageType.GoAway: {
      assertUintBitSize(header.errorCode, 32, 'header error code');
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

/**
 * Asserts value is within the specified unsigned integer bit size range.
 *
 * @returns `true` if the value is within the specified range.
 * @throws an error if the value is not a non-negative integer or exceeds the specified bit size range.
 */
export function assertUintBitSize(
  value: number,
  bitSize: 8 | 16 | 32,
  fieldName = 'value'
): true {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }

  console.log(value);

  if (value >= 2 ** bitSize) {
    throw new Error(
      `${fieldName} exceeds ${bitSize}-bit unsigned integer range`
    );
  }
  return true;
}
