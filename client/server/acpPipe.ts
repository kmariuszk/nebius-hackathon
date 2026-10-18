import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'

// The ACP pipe (T03): one WebSocket at /api/acp, one harness process on stdio.
// Placeholder until the pipe lands: every chat is refused.
export function handleAcpUpgrade(_req: IncomingMessage, socket: Duplex, _head: Buffer) {
	socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
	socket.destroy()
}
