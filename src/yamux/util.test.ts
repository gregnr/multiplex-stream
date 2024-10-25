import { describe, expect, test } from 'vitest';
import { serializeHeader } from './util';
import { MessageType } from './types';

describe('headers', () => {
  test('header length outside of bit range throws error', () => {
    expect(() =>
      serializeHeader({
        version: 0,
        type: MessageType.Data,
        flags: 0,
        streamId: 1,
        length: 2 ** 33,
      })
    ).toThrowError('header length exceeds 32-bit unsigned integer range');
  });
});
