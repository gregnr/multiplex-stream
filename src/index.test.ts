import { describe, expect, test } from 'vitest';
import { collectStream, delayStream, getFirstStream } from '../test/util.js';
import { frameStream } from './frame/length-prefixed-frames.js';
import { multiplexStream, type YamuxMultiplexer } from './index.js';
import type { DuplexStream } from './types.js';
import { fromReadable } from './util/async-iterator.js';
import { createDuplexPair } from './util/streams.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('multiplex', () => {
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

describe('flow control', () => {
  test('chunk less than window size sends single segment', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    const serverMuxer = await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
    });

    const [clientStream, serverStream] = await Promise.all([
      clientMuxer.connect(),
      getFirstStream(serverMuxer.listen()),
    ]);
    const clientWriter = clientStream.writable.getWriter();

    const [chunks] = await Promise.all([
      collectStream(serverStream.readable),
      clientWriter
        .write(new Uint8Array(256 * 1024))
        .then(() => clientWriter.close()),
    ]);

    expect(chunks.length).toBe(1);
    expect(chunks[0]?.byteLength).toBe(256 * 1024);
  });

  test('chunk greater than window size sends multiple segments', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    const serverMuxer = await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
    });

    const [clientStream, serverStream] = await Promise.all([
      clientMuxer.connect(),
      getFirstStream(serverMuxer.listen()),
    ]);
    const clientWriter = clientStream.writable.getWriter();

    const [chunks] = await Promise.all([
      collectStream(serverStream.readable),
      clientWriter
        .write(new Uint8Array(256 * 1024 + 1))
        .then(() => clientWriter.close()),
    ]);

    expect(chunks.length).toBe(2);
    expect(chunks[0]?.byteLength).toBe(256 * 1024);
    expect(chunks[1]?.byteLength).toBe(1);
  });

  test('custom buffer size on inbound streams', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    const serverMuxer = await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
      defaultMaxBufferSize: 512 * 1024,
    });

    const [clientStream, serverStream] = await Promise.all([
      clientMuxer.connect(),
      getFirstStream(serverMuxer.listen()),
    ]);
    const clientWriter = clientStream.writable.getWriter();

    const [chunks] = await Promise.all([
      collectStream(serverStream.readable),
      clientWriter
        .write(new Uint8Array(512 * 1024 + 1))
        .then(() => clientWriter.close()),
    ]);

    expect(chunks.length).toBe(2);
    expect(chunks[0]?.byteLength).toBe(512 * 1024);
    expect(chunks[1]?.byteLength).toBe(1);
  });

  test('custom buffer size less than 256KB on inbound streams fails', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });

    await expect(
      multiplexStream(serverTransport, {
        transportDirection: 'inbound',
        defaultMaxBufferSize: 32,
      })
    ).rejects.toThrowError('defaultMaxBufferSize must be a minimum of 256KB');
  });

  test('custom buffer size on outbound streams', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    const serverMuxer = await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
    });

    const [clientStream, serverStream] = await Promise.all([
      clientMuxer.connect({ maxBufferSize: 512 * 1024 }),
      getFirstStream(serverMuxer.listen()),
    ]);
    const serverWriter = serverStream.writable.getWriter();

    const [chunks] = await Promise.all([
      collectStream(clientStream.readable),
      serverWriter
        .write(new Uint8Array(512 * 1024 + 1))
        .then(() => serverWriter.close()),
    ]);

    expect(chunks.length).toBe(2);
    expect(chunks[0]?.byteLength).toBe(512 * 1024);
    expect(chunks[1]?.byteLength).toBe(1);
  });

  test('custom buffer size less than 256KB on outbound streams fails', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
    });

    await expect(
      clientMuxer.connect({ maxBufferSize: 32 })
    ).rejects.toThrowError('maxBufferSize must be a minimum of 256KB');
  });
});

describe('ping', () => {
  test('rtt', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientDelay = 30;
    const serverDelay = 20;

    const clientMuxer = await multiplexStream(
      delayStream(clientTransport, clientDelay),
      {
        transportDirection: 'outbound',
      }
    );
    const serverMuxer = await multiplexStream(
      delayStream(serverTransport, serverDelay),
      {
        transportDirection: 'inbound',
      }
    );

    const totalDelay = clientDelay + serverDelay;

    const clientRtt = await clientMuxer.calculateRtt();
    const serverRtt = await serverMuxer.calculateRtt();

    // Expect RTT to be within 5ms of the artificial delay
    expect(clientRtt - totalDelay).toBeLessThanOrEqual(5);
    expect(serverRtt - totalDelay).toBeLessThanOrEqual(5);
  });
});
