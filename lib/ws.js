/**
 * Minimal RFC 6455 WebSocket server for the Host status panel.
 *
 * The DSH `webServer` owns the HTTP listener and exposes
 * `registerUpgrade({ path, handler })`, so this module only performs the
 * handshake, frame parsing, authentication, heartbeat, and snapshot push. It
 * intentionally implements no subprotocol application beyond
 * `dsh-auto-context-v1`, and no client-controlled filesystem/network actions.
 *
 * Security model (also documented in WEBSOCKET_REVIEW.md):
 * - the socket is reachable only through the already-bound DSH listener;
 * - the Origin must be a loopback origin on the listener's own port;
 * - the browser must offer the fixed protocol plus a per-process random token
 *   (fetched from a same-origin, non-CORS JSON endpoint);
 * - every client frame must be masked, bounded, and valid UTF-8 text;
 * - outgoing frames are coalesced per client and dropped under backpressure.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const WS_PATH = '/auto-context-compression/ws'
export const WS_PROTOCOL = 'dsh-auto-context-v1'

const OP_CONTINUATION = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

const DEFAULTS = {
  maxClients: 8,
  maxFramePayload: 16 * 1024,
  maxMessage: 32 * 1024,
  maxBuffered: 1024 * 1024,
  heartbeatMs: 30000,
  idleMs: 90000,
  maxMessagesPerSecond: 50,
}

/** A fresh, URL-safe per-process capability token. */
export function makeToken() {
  return randomBytes(32).toString('base64url')
}

/** RFC 6455 `Sec-WebSocket-Accept` value. */
export function acceptKey(key) {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64')
}

/** Split and trim a `Sec-WebSocket-Protocol` request header. */
export function parseProtocols(value) {
  if (Array.isArray(value)) value = value.join(',')
  return String(value ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/** Constant-time comparison for two short ASCII protocol capabilities. */
export function tokenMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false
  const left = Buffer.from(provided)
  const right = Buffer.from(expected)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Only a loopback page on the exact listener port may open the socket. The
 * Origin header is not secret, but the browser cannot forge it from another
 * site, which blocks cross-site WebSocket hijacking before the token check.
 */
export function isAllowedOrigin(origin, serverOrigin) {
  if (typeof origin !== 'string' || origin.length === 0) return false
  let page
  let server
  try {
    page = new URL(origin)
    server = new URL(serverOrigin)
  } catch {
    return false
  }
  if (page.protocol !== server.protocol) return false
  if (page.port !== server.port) return false
  const hostname = page.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const serverHost = server.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') return false
  return serverHost === '127.0.0.1' || serverHost === 'localhost' || serverHost === '::1'
}

/** Encode one unmasked server-to-client frame. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
  let header
  if (data.length < 126) {
    header = Buffer.from([0x80 | opcode, data.length])
  } else if (data.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(data.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(data.length), 2)
  }
  return Buffer.concat([header, data])
}

/** Encode a close frame with a valid application close code. */
export function encodeClose(code = 1000, reason = '') {
  const text = Buffer.from(String(reason), 'utf8').subarray(0, 120)
  const payload = Buffer.alloc(2 + text.length)
  payload.writeUInt16BE(code, 0)
  text.copy(payload, 2)
  return encodeFrame(OP_CLOSE, payload)
}

function protocolError(message, closeCode = 1002) {
  const error = new Error(message)
  error.closeCode = closeCode
  return error
}

/**
 * Incremental client-frame parser. It enforces masking, RSV bits,
 * fragmentation/control rules, payload caps, and fatal UTF-8 decoding.
 * Hooks are synchronous; a thrown hook is treated as a connection failure.
 */
export class FrameParser {
  constructor(options = {}) {
    this.maxFramePayload = options.maxFramePayload ?? DEFAULTS.maxFramePayload
    this.maxMessage = options.maxMessage ?? DEFAULTS.maxMessage
    this.onMessage = options.onMessage ?? (() => {})
    this.onPing = options.onPing ?? (() => {})
    this.onPong = options.onPong ?? (() => {})
    this.onClose = options.onClose ?? (() => {})
    this.onFrame = options.onFrame ?? (() => {})
    this.buffer = Buffer.alloc(0)
    this.fragmentOpcode = null
    this.fragmentLength = 0
    this.fragmentParts = []
    this.closed = false
    this.decoder = new TextDecoder('utf-8', { fatal: true })
  }

  push(chunk) {
    if (this.closed) return
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return
    const nextLength = this.buffer.length + chunk.length
    if (nextLength > this.maxFramePayload * 4) throw protocolError('frame buffer limit exceeded', 1009)
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    while (this.buffer.length >= 2) {
      if (this.closed) return
      this.#parseOne()
    }
  }

  #parseOne() {
    const first = this.buffer[0]
    const second = this.buffer[1]
    const fin = (first & 0x80) !== 0
    const rsv = first & 0x70
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let offset = 2

    if (rsv !== 0) throw protocolError('reserved bits are not supported')
    if (!masked) throw protocolError('client frames must be masked')
    if (length === 126) {
      if (this.buffer.length < 4) return
      length = this.buffer.readUInt16BE(2)
      offset = 4
    } else if (length === 127) {
      if (this.buffer.length < 10) return
      const large = this.buffer.readBigUInt64BE(2)
      if (large > BigInt(this.maxFramePayload)) throw protocolError('frame too large', 1009)
      length = Number(large)
      offset = 10
    }
    if (length > this.maxFramePayload) throw protocolError('frame too large', 1009)
    if ((opcode === OP_CLOSE || opcode === OP_PING || opcode === OP_PONG) && (length > 125 || !fin)) {
      throw protocolError('invalid control frame')
    }
    if ((opcode === OP_CONTINUATION || opcode === OP_TEXT || opcode === OP_BINARY) && length > this.maxMessage) {
      throw protocolError('message too large', 1009)
    }
    const total = offset + 4 + length
    if (this.buffer.length < total) return

    const mask = this.buffer.subarray(offset, offset + 4)
    const payload = Buffer.allocUnsafe(length)
    const source = this.buffer.subarray(offset + 4, total)
    for (let index = 0; index < length; index += 1) {
      payload[index] = source[index] ^ mask[index & 3]
    }
    this.buffer = this.buffer.subarray(total)
    this.onFrame()
    this.#handleFrame(fin, opcode, payload)
  }

  #handleFrame(fin, opcode, payload) {
    if (opcode === OP_CLOSE) {
      if (payload.length === 1) throw protocolError('invalid close payload')
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000
      if (code < 1000 || code > 4999 || code === 1004 || code === 1005 || code === 1006 || code === 1015) {
        throw protocolError('invalid close code')
      }
      this.closed = true
      this.onClose(code, payload.length > 2 ? payload.subarray(2).toString('utf8') : '')
      return
    }
    if (opcode === OP_PING) {
      this.onPing(payload)
      return
    }
    if (opcode === OP_PONG) {
      this.onPong(payload)
      return
    }
    if (opcode === OP_BINARY) throw protocolError('binary messages are not supported', 1003)
    if (opcode === OP_CONTINUATION) {
      if (this.fragmentOpcode === null) throw protocolError('unexpected continuation frame')
      this.fragmentLength += payload.length
      if (this.fragmentLength > this.maxMessage) throw protocolError('message too large', 1009)
      this.fragmentParts.push(payload)
      if (!fin) return
      const text = this.#decode(Buffer.concat(this.fragmentParts, this.fragmentLength))
      this.fragmentOpcode = null
      this.fragmentLength = 0
      this.fragmentParts = []
      this.onMessage(text)
      return
    }
    if (opcode !== OP_TEXT) throw protocolError(`unsupported opcode ${opcode}`)
    if (this.fragmentOpcode !== null) throw protocolError('new message while fragmented')
    if (!fin) {
      this.fragmentOpcode = OP_TEXT
      this.fragmentLength = payload.length
      this.fragmentParts = [payload]
      return
    }
    this.onMessage(this.#decode(payload))
  }

  #decode(payload) {
    try {
      return this.decoder.decode(payload)
    } catch {
      throw protocolError('invalid UTF-8 text', 1007)
    }
  }
}

function rejectUpgrade(socket, status = 400, message = 'bad request') {
  const labels = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    503: 'Service Unavailable',
  }
  try {
    const body = Buffer.from(message, 'utf8')
    socket.write(
      `HTTP/1.1 ${status} ${labels[status] ?? 'Error'}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Type: text/plain; charset=utf-8\r\n'
      + `Content-Length: ${body.length}\r\n`
      + 'Cache-Control: no-store\r\n'
      + '\r\n',
    )
    socket.write(body)
    socket.end()
  } catch {
    /* the peer may already be gone */
  }
}

/**
 * Create the upgrade handler and client registry.
 *
 * Required callbacks:
 * - getOrigin(): the bound Web server origin
 * - getSnapshot(sessionId, refresh): serializable status payload (may be async)
 * - token: per-process capability token
 * Optional: log(level, message).
 */
export function createWebSocketHub(options) {
  const settings = { ...DEFAULTS, ...(options ?? {}) }
  const token = settings.token ?? makeToken()
  const clients = new Set()
  let timer = null
  let closed = false

  function log(level, message) {
    if (typeof settings.log === 'function') settings.log(level, message)
  }

  function write(socket, chunk) {
    try {
      if (!socket.destroyed && socket.writable) socket.write(chunk)
    } catch {
      /* ignore a peer that disappeared mid-write */
    }
  }

  function sendJson(client, message) {
    if (client.closed || client.socket.destroyed) return
    if (client.socket.writableLength > settings.maxBuffered) {
      client.pending = true
      return
    }
    let encoded
    try {
      encoded = Buffer.from(JSON.stringify(message), 'utf8')
    } catch (error) {
      log('warn', `snapshot serialization failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    write(client.socket, encodeFrame(OP_TEXT, encoded))
  }

  function closeClient(client, code = 1000, reason = '') {
    if (client.closed) return
    client.closed = true
    clients.delete(client)
    write(client.socket, encodeClose(code, reason))
    try {
      client.socket.end()
    } catch {
      /* already gone */
    }
    const timerId = setTimeout(() => {
      try {
        client.socket.destroy()
      } catch {
        /* already gone */
      }
    }, 500)
    if (typeof timerId.unref === 'function') timerId.unref()
  }

  async function pushSnapshot(client, refresh = false) {
    if (client.closed || client.sending) {
      if (!client.closed) client.pending = true
      return
    }
    client.sending = true
    try {
      const value = await settings.getSnapshot(client.sessionId, refresh === true)
      sendJson(client, { type: 'snapshot', rev: Date.now(), data: value ?? null })
    } catch (error) {
      log('warn', `snapshot build failed: ${error instanceof Error ? error.message : String(error)}`)
      sendJson(client, {
        type: 'error',
        error: 'snapshot unavailable',
      })
    } finally {
      client.sending = false
      if (client.pending && !client.closed) {
        client.pending = false
        void pushSnapshot(client, false)
      }
    }
  }

  function broadcast() {
    for (const client of clients) void pushSnapshot(client, false)
  }

  function handleClientText(client, text) {
    const now = Date.now()
    if (now - client.rateStart >= 1000) {
      client.rateStart = now
      client.rateCount = 0
    }
    client.rateCount += 1
    if (client.rateCount > settings.maxMessagesPerSecond) {
      closeClient(client, 1008, 'message rate limit')
      return
    }
    let message
    try {
      message = JSON.parse(text)
    } catch {
      sendJson(client, { type: 'error', error: 'invalid JSON' })
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      sendJson(client, { type: 'error', error: 'message must be an object' })
      return
    }
    if (message.type === 'hello') {
      const requested = message.sessionId
      if (requested !== undefined && requested !== null && (typeof requested !== 'string' || requested.length > 200)) {
        sendJson(client, { type: 'error', error: 'invalid sessionId' })
        return
      }
      client.sessionId = typeof requested === 'string' && requested.length > 0 ? requested : null
      void pushSnapshot(client, true)
      return
    }
    if (message.type === 'snapshot') {
      void pushSnapshot(client, false)
      return
    }
    if (message.type === 'ping') {
      sendJson(client, { type: 'pong', at: Date.now() })
      return
    }
    sendJson(client, { type: 'error', error: 'unsupported message type' })
  }

  function handleUpgrade(request, socket, head) {
    if (closed) {
      rejectUpgrade(socket, 503, 'server is shutting down')
      return
    }
    if (!socket || typeof socket.write !== 'function') return
    try {
      socket.on('error', (error) => log('debug', `websocket socket error: ${error?.message ?? error}`))
    } catch {
      /* not all Duplex implementations expose events */
    }

    let pathname
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname
    } catch {
      rejectUpgrade(socket, 400, 'bad request url')
      return
    }
    if (pathname !== WS_PATH) {
      rejectUpgrade(socket, 404, 'not found')
      return
    }
    if (request.method !== 'GET'
      || String(request.headers.upgrade ?? '').toLowerCase() !== 'websocket'
      || !String(request.headers.connection ?? '').toLowerCase().split(',').map((part) => part.trim()).includes('upgrade')
      || String(request.headers['sec-websocket-version'] ?? '') !== '13') {
      rejectUpgrade(socket, 400, 'websocket upgrade required')
      return
    }
    let origin
    try {
      origin = settings.getOrigin()
    } catch {
      rejectUpgrade(socket, 503, 'web server origin unavailable')
      return
    }
    if (!isAllowedOrigin(request.headers.origin, origin)) {
      rejectUpgrade(socket, 403, 'origin not allowed')
      return
    }
    if (clients.size >= settings.maxClients) {
      rejectUpgrade(socket, 503, 'too many clients')
      return
    }
    const protocols = parseProtocols(request.headers['sec-websocket-protocol'])
    if (protocols[0] !== WS_PROTOCOL || !tokenMatches(protocols[1], token)) {
      rejectUpgrade(socket, 401, 'invalid websocket capability')
      return
    }
    const key = String(request.headers['sec-websocket-key'] ?? '')
    if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) {
      rejectUpgrade(socket, 400, 'invalid websocket key')
      return
    }

    const client = {
      socket,
      sessionId: null,
      lastPong: Date.now(),
      sending: false,
      pending: false,
      closed: false,
      parser: null,
      rateStart: Date.now(),
      rateCount: 0,
    }
    clients.add(client)
    try {
      socket.setNoDelay?.(true)
      socket.setKeepAlive?.(true, 30000)
    } catch {
      /* best effort */
    }
    write(socket,
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n`
      + `Sec-WebSocket-Protocol: ${WS_PROTOCOL}\r\n`
      + '\r\n')

    const parser = new FrameParser({
      maxFramePayload: settings.maxFramePayload,
      maxMessage: settings.maxMessage,
      onMessage: (text) => handleClientText(client, text),
      onPing: (payload) => write(socket, encodeFrame(OP_PONG, payload)),
      onPong: () => { client.lastPong = Date.now() },
      onClose: (code, reason) => closeClient(client, code === 1005 ? 1000 : code, reason),
    })
    client.parser = parser

    const onData = (chunk) => {
      if (client.closed) return
      try {
        parser.push(chunk)
      } catch (error) {
        const code = Number.isInteger(error?.closeCode) ? error.closeCode : 1002
        closeClient(client, code, error instanceof Error ? error.message : 'protocol error')
      }
    }
    socket.on('data', onData)
    socket.on('close', () => {
      if (!client.closed) {
        client.closed = true
        clients.delete(client)
      }
    })
    if (Buffer.isBuffer(head) && head.length > 0) onData(head)
    log('debug', `websocket client connected (${clients.size})`)
  }

  timer = setInterval(() => {
    if (closed) return
    const now = Date.now()
    for (const client of clients) {
      if (now - client.lastPong > settings.idleMs) {
        closeClient(client, 1001, 'heartbeat timeout')
        continue
      }
      write(client.socket, encodeFrame(OP_PING, Buffer.alloc(0)))
    }
  }, settings.heartbeatMs)
  if (typeof timer.unref === 'function') timer.unref()

  return {
    token,
    handleUpgrade,
    broadcast,
    close(code = 1001, reason = 'plugin unloaded') {
      if (closed) return
      closed = true
      if (timer !== null) clearInterval(timer)
      for (const client of [...clients]) closeClient(client, code, reason)
      clients.clear()
    },
    get clientCount() {
      return clients.size
    },
  }
}
