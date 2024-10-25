import { describe, expect, test } from 'vitest';
import { multiplexStream } from '../index.js';
import { collectStream, getFirstStream } from '../../test/util.js';
import { createDuplexPair } from '../util/index.js';
import { frameStream } from './length-prefixed-frames.js';

describe('frame', () => {
  test('re-assembles multiple segments', async () => {
    const [clientTransport, serverTransport] = createDuplexPair<Uint8Array>();

    const clientMuxer = await multiplexStream(clientTransport, {
      transportDirection: 'outbound',
    });
    const serverMuxer = await multiplexStream(serverTransport, {
      transportDirection: 'inbound',
      defaultMaxBufferSize: 256 * 1024,
    });

    const [clientStream, serverStream] = await Promise.all([
      clientMuxer.connect().then(frameStream),
      getFirstStream(serverMuxer.listen()).then(frameStream),
    ]);
    const clientWriter = clientStream.writable.getWriter();

    const [chunks] = await Promise.all([
      collectStream(serverStream.readable),
      clientWriter
        .write(new Uint8Array(256 * 1024 + 1))
        .then(() => clientWriter.close()),
    ]);

    expect(chunks.length).toBe(1);
    expect(chunks[0]?.byteLength).toBe(256 * 1024 + 1);
  });
});
