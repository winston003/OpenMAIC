import { gzipSync } from 'node:zlib';
import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deriveDoubaoASRTimeoutMs,
  transcribeWithDoubaoASR,
} from '@/lib/audio/doubao-asr-client';
import { resolveDoubaoASRWebSocketUrl } from '@/lib/audio/asr-providers';

const servers: Server[] = [];

function makePcmWav(durationMs = 200): Buffer {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const frames = Math.max(1, Math.round((sampleRate * durationMs) / 1000));
  const dataBytes = frames * channels * (bitsPerSample / 8);
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  wav.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function wsFrame(fin: boolean, opcode: number, payload: Buffer): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  if (payload.length < 126) {
    return Buffer.concat([Buffer.from([first, payload.length]), payload]);
  }
  const ext = Buffer.alloc(2);
  ext.writeUInt16BE(payload.length);
  return Buffer.concat([Buffer.from([first, 126]), ext, payload]);
}

function finalDoubaoMessage(text: string): Buffer {
  const json = gzipSync(Buffer.from(JSON.stringify({ result: { text } }), 'utf8'));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(json.length);
  return Buffer.concat([
    Buffer.from([
      0x11, // version=1, header=4 bytes
      0x92, // full server response + last-package flag
      0x11, // JSON + gzip
      0x00,
    ]),
    size,
    json,
  ]);
}

async function startFragmentingServer(text: string): Promise<{ port: number }> {
  const server = createServer((socket: Socket) => {
    let handshake = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf('\r\n\r\n');
      if (end < 0) return;

      socket.removeAllListeners('data');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n\r\n',
      );

      const message = finalDoubaoMessage(text);
      const midpoint = Math.max(1, Math.floor(message.length / 2));
      socket.write(wsFrame(false, 0x2, message.subarray(0, midpoint)));
      socket.write(wsFrame(true, 0x0, message.subarray(midpoint)));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return { port: address.port };
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('Doubao ASR provider', () => {
  it('binds the default WebSocket endpoint to the credential type', () => {
    expect(resolveDoubaoASRWebSocketUrl('ark-plan-key')).toContain('/api/v3/plan/sauc/');
    expect(resolveDoubaoASRWebSocketUrl('app-id:access-key')).toBe(
      'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async',
    );
    expect(resolveDoubaoASRWebSocketUrl('app-id:access-key', 'wss://example.test/asr')).toBe(
      'wss://example.test/asr',
    );
  });

  it('sizes the default timeout beyond a paced 60 second upload', () => {
    const pcmBytesFor60Seconds = 16_000 * 2 * 60;
    expect(deriveDoubaoASRTimeoutMs(pcmBytesFor60Seconds)).toBeGreaterThan(60_000);
    expect(deriveDoubaoASRTimeoutMs(pcmBytesFor60Seconds, 1234)).toBe(1234);
  });

  it('reassembles a binary WebSocket message split across continuation frames', async () => {
    const server = await startFragmentingServer('fragmented response');

    await expect(
      transcribeWithDoubaoASR({
        url: `ws://127.0.0.1:${server.port}/asr`,
        apiKey: 'ark-plan-key',
        wav: makePcmWav(),
        timeoutMs: 2_000,
      }),
    ).resolves.toBe('fragmented response');
  });
});
