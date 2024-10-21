import { describe, expect, test } from 'vitest';
import { multiplexStream, type YamuxMultiplexer } from '.';
import { frameStream } from './frame/length-prefixed-frames';
import type { DuplexStream } from './types';
import { fromReadable } from './util/async-iterator';
import { createDuplexPair } from './util/streams';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('multiplexStream', () => {
  test('single stream single direction', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    const serverMuxer = await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
    });

    async function handleStreams(
      streams: AsyncIterable<DuplexStream<Uint8Array>>
    ) {
      async function handleMessages(stream: DuplexStream<Uint8Array>) {
        const writer = stream.writable.getWriter();

        for await (const chunk of fromReadable(stream.readable)) {
          expect(decoder.decode(chunk)).toBe('Hello');
          await writer.write(encoder.encode('world!'));
          await writer.close();
        }
      }

      for await (const stream of streams) {
        const framedStream = frameStream(stream);

        // Process incoming messages without blocking
        handleMessages(framedStream);
      }
    }

    const streams = serverMuxer.listen();

    // Process incoming streams without blocking
    handleStreams(streams);

    // Send and receive messages from client-to-server
    const stream = await clientMuxer.connect();
    const framedStream = frameStream(stream);
    const writer = framedStream.writable.getWriter();

    await writer.write(encoder.encode('Hello'));
    await writer.close();

    for await (const message of fromReadable(framedStream.readable)) {
      expect(decoder.decode(message)).toBe('world!');
    }
  });

  test('multiple streams single direction', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    const serverMuxer = await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
    });

    async function handleStreams(
      streams: AsyncIterable<DuplexStream<Uint8Array>>
    ) {
      async function handleMessages(stream: DuplexStream<Uint8Array>) {
        const writer = stream.writable.getWriter();

        for await (const chunk of fromReadable(stream.readable)) {
          const testId = decoder.decode(chunk);
          await writer.write(encoder.encode(`Hello ${testId}`));
          await writer.close();
        }
      }

      for await (const stream of streams) {
        const framedStream = frameStream(stream);

        // Process incoming messages without blocking
        handleMessages(framedStream);
      }
    }

    const streams = serverMuxer.listen();

    // Process incoming streams without blocking
    handleStreams(streams);

    async function testConnection(testId: string) {
      // Send and receive messages from client-to-server
      const stream = await clientMuxer.connect();
      const framedStream = frameStream(stream);
      const writer = framedStream.writable.getWriter();

      await writer.write(encoder.encode(testId));
      await writer.close();

      for await (const message of fromReadable(framedStream.readable)) {
        expect(decoder.decode(message)).toBe(`Hello ${testId}`);
      }
    }

    await Promise.all([testConnection('A'), testConnection('B')]);
  });

  test('multiple streams multiple directions', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    const serverMuxer = await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
    });

    async function handleStreams(
      streams: AsyncIterable<DuplexStream<Uint8Array>>
    ) {
      async function handleMessages(stream: DuplexStream<Uint8Array>) {
        const writer = stream.writable.getWriter();

        for await (const chunk of fromReadable(stream.readable)) {
          const testId = decoder.decode(chunk);
          await writer.write(encoder.encode(`Hello ${testId}`));
          await writer.close();
        }
      }

      for await (const stream of streams) {
        const framedStream = frameStream(stream);

        // Process incoming messages without blocking
        handleMessages(framedStream);
      }
    }

    const serverStreams = serverMuxer.listen();
    const clientStreams = clientMuxer.listen();

    // Process incoming streams without blocking
    handleStreams(serverStreams);
    handleStreams(clientStreams);

    async function testConnection(muxer: YamuxMultiplexer, testId: string) {
      // Send and receive messages from client-to-server
      const stream = await muxer.connect();
      const framedStream = frameStream(stream);
      const writer = framedStream.writable.getWriter();

      await writer.write(encoder.encode(testId));
      await writer.close();

      for await (const message of fromReadable(framedStream.readable)) {
        expect(decoder.decode(message)).toBe(`Hello ${testId}`);
      }
    }

    await Promise.all([
      testConnection(clientMuxer, 'A'),
      testConnection(clientMuxer, 'B'),
      testConnection(serverMuxer, 'A'),
      testConnection(serverMuxer, 'B'),
    ]);
  });
});
