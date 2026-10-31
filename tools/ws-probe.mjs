/**
 * Minimal loopback WebSocket probe for the auto-context-compression panel.
 *
 * Usage:
 *   node tools/ws-probe.mjs
 *   DSH_GUI_ORIGIN=http://127.0.0.1:51890 node tools/ws-probe.mjs
 *
 * It fetches the short-lived capability from the same origin, performs the
 * RFC 6455 handshake, sends one hello, and exits after two snapshots.
 * Requires no npm dependencies; run only against a DSH instance on loopback.
 */
import net from 'node:net'
import { randomBytes } from 'node:crypto'

const origin = process.env.DSH_GUI_ORIGIN || 'http://127.0.0.1:51890'
const target = new URL(origin)
const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80))
const host = target.hostname

if (!['127.0.0.1', 'localhost', '::1'].includes(host.replace(/^\[|\]$/g, ''))) {
  throw new Error('ws-probe only runs against a loopback DSH GUI origin')
}

const tokenResponse = await fetch(`${target.origin}/auto-context-compression/api/ws-token`, {
  headers: { accept: 'application/json' },
})
const tokenBody = await tokenResponse.json()
if (tokenBody.ok !== true) throw new Error(JSON.stringify(tokenBody))
const capability = tokenBody.value

const socket = net.connect(port, host)
let buffer = Buffer.alloc(0)
let upgraded = false
let snapshots = 0
const startedAt = Date.now()

function maskedFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, 0x80 | payload.length])
  } else {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(payload.length, 2)
  }
  const body = Buffer.alloc(payload.length)
  for (let index = 0; index < payload.length; index += 1) {
    body[index] = payload[index] ^ mask[index & 3]
  }
  return Buffer.concat([header, mask, body])
}

function consumeFrames() {
  while (buffer.length >= 2) {
    const first = buffer[0]
    const second = buffer[1]
    const opcode = first & 0x0f
    let length = second & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < 4) return
      length = buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (buffer.length < 10) return
      length = Number(buffer.readBigUInt64BE(2))
      offset = 10
    }
    if (buffer.length < offset + length) return
    const payload = buffer.subarray(offset, offset + length)
    buffer = buffer.subarray(offset + length)
    if (opcode === 0x9) {
      socket.write(Buffer.from([0x8a, 0x80, 1, 2, 3, 4, 0]))
      continue
    }
    if (opcode === 0x8) {
      console.log('server closed the socket')
      socket.end()
      return
    }
    if (opcode !== 0x1) continue
    const message = JSON.parse(payload.toString('utf8'))
    if (message.type !== 'snapshot') continue
    snapshots += 1
    const value = message.data ?? {}
    console.log(JSON.stringify({
      snapshot: snapshots,
      elapsedMs: Date.now() - startedAt,
      engine: value.engine,
      title: value.bili?.title,
      requests: value.bili?.requests,
      savedUsd: value.bili?.savedUsd,
      sessionId: value.session?.sessionId,
      websocket: value.websocket,
    }, null, 2))
    if (snapshots >= 2) {
      clearTimeout(timer)
      socket.end()
      process.exit(0)
    }
  }
}

socket.on('connect', () => {
  socket.write(
    `GET ${capability.path} HTTP/1.1\r\n`
    + `Host: ${target.host}\r\n`
    + 'Upgrade: websocket\r\n'
    + 'Connection: Upgrade\r\n'
    + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\n`
    + 'Sec-WebSocket-Version: 13\r\n'
    + `Origin: ${target.origin}\r\n`
    + `Sec-WebSocket-Protocol: ${capability.protocol}, ${capability.token}\r\n`
    + '\r\n',
  )
})

socket.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  if (!upgraded) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end === -1) return
    const header = buffer.subarray(0, end + 4).toString('utf8')
    buffer = buffer.subarray(end + 4)
    if (!/^HTTP\/1\.1 101/.test(header)) {
      console.error(header)
      process.exit(1)
    }
    upgraded = true
    socket.write(maskedFrame(JSON.stringify({ type: 'hello' })))
  }
  consumeFrames()
})

socket.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

const timer = setTimeout(() => {
  console.error('timed out waiting for snapshots')
  process.exit(1)
}, 8000)
