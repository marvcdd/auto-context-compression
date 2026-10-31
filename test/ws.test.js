/**
 * WebSocket 握手、帧解析和鉴权测试。
 * WebSocket handshake, frame parsing, and authentication tests.
 *
 * 中文：覆盖 masked 文本帧、未掩码拒绝、分片/上限、Origin/token 校验和 101 握手。
 * English: Covers masked text frames, unmasked rejection, fragmentation/limits,
 * Origin/token validation, and the 101 handshake.
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import {
  FrameParser,
  WS_PATH,
  WS_PROTOCOL,
  createWebSocketHub,
  isAllowedOrigin,
  tokenMatches,
} from '../lib/ws.js'

// 构造带固定 mask 的客户端帧，便于逐字节断言。
// Build a client frame with a fixed mask for byte-level assertions.
function maskedFrame(opcode, payload, fin = true) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8')
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44])
  let header
  if (data.length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, 0x80 | data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = (fin ? 0x80 : 0) | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = (fin ? 0x80 : 0) | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  const body = Buffer.alloc(data.length)
  for (let index = 0; index < data.length; index += 1) body[index] = data[index] ^ mask[index & 3]
  return Buffer.concat([header, mask, body])
}

class FakeSocket extends EventEmitter {
  constructor() {
    super()
    this.chunks = []
    this.writable = true
    this.destroyed = false
    this.ended = false
  }

  write(chunk) {
    this.chunks.push(Buffer.from(chunk))
    return true
  }

  end() {
    this.ended = true
    this.writable = false
  }

  destroy() {
    this.destroyed = true
    this.writable = false
  }
}

function upgradeRequest(token, overrides = {}) {
  const key = Buffer.alloc(16, 7).toString('base64')
  return {
    method: 'GET',
    url: WS_PATH,
    headers: {
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-version': '13',
      origin: 'http://127.0.0.1:51890',
      'sec-websocket-key': key,
      'sec-websocket-protocol': `${WS_PROTOCOL}, ${token}`,
      ...overrides,
    },
  }
}

test('FrameParser accepts masked text messages and rejects unmasked frames', () => {
  const messages = []
  const parser = new FrameParser({ onMessage: (text) => messages.push(text) })
  parser.push(maskedFrame(0x1, '{"type":"ping"}'))
  assert.deepEqual(messages, ['{"type":"ping"}'])

  const bad = new FrameParser()
  assert.throws(() => bad.push(Buffer.from([0x81, 0x01, 0x41])), /masked/)
})

test('FrameParser handles fragmented text and bounded payloads', () => {
  const messages = []
  const parser = new FrameParser({ onMessage: (text) => messages.push(text), maxMessage: 8 })
  parser.push(maskedFrame(0x1, 'hel', false))
  parser.push(maskedFrame(0x0, 'lo', true))
  assert.deepEqual(messages, ['hello'])
  assert.throws(() => parser.push(maskedFrame(0x1, '123456789')), /too large/)
})

test('origin and token checks are strict', () => {
  assert.equal(isAllowedOrigin('http://127.0.0.1:51890', 'http://127.0.0.1:51890'), true)
  assert.equal(isAllowedOrigin('http://localhost:51890', 'http://127.0.0.1:51890'), true)
  assert.equal(isAllowedOrigin('https://127.0.0.1:51890', 'http://127.0.0.1:51890'), false)
  assert.equal(isAllowedOrigin('http://192.168.1.5:51890', 'http://127.0.0.1:51890'), false)
  assert.equal(isAllowedOrigin(undefined, 'http://127.0.0.1:51890'), false)
  assert.equal(tokenMatches('abc', 'abc'), true)
  assert.equal(tokenMatches('abc', 'abd'), false)
  assert.equal(tokenMatches('abc', 'abcd'), false)
})

test('the hub completes a valid handshake and rejects a bad capability', async () => {
  const snapshots = []
  const hub = createWebSocketHub({
    getOrigin: () => 'http://127.0.0.1:51890',
    getSnapshot: async () => ({ ok: true, value: 'snapshot' }),
  })
  const socket = new FakeSocket()
  await hub.handleUpgrade(upgradeRequest(hub.token), socket, Buffer.alloc(0))
  const handshake = Buffer.concat(socket.chunks).toString('utf8')
  assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/)
  assert.match(handshake, /Sec-WebSocket-Accept:/)
  assert.match(handshake, new RegExp(`Sec-WebSocket-Protocol: ${WS_PROTOCOL}`))
  assert.equal(hub.clientCount, 1)
  hub.close()
  assert.equal(hub.clientCount, 0)

  const rejected = new FakeSocket()
  const badHub = createWebSocketHub({
    getOrigin: () => 'http://127.0.0.1:51890',
    getSnapshot: async () => ({ ok: true }),
  })
  await badHub.handleUpgrade(upgradeRequest('wrong-token'), rejected, Buffer.alloc(0))
  assert.match(Buffer.concat(rejected.chunks).toString('utf8'), /401 Unauthorized/)
  badHub.close()
  assert.equal(snapshots.length, 0)
})
