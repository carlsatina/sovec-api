import type { Server as HttpServer } from 'http'
import { Server } from 'socket.io'

let io: Server | null = null

export function initSocket(server: HttpServer) {
  io = new Server(server, {
    cors: { origin: '*' }
  })

  io.on('connection', (socket) => {
    // Generic room join (passenger + driver)
    socket.on('join', ({ userId, rideId }) => {
      if (userId) socket.join(`user:${userId}`)
      if (rideId) socket.join(`ride:${rideId}`)
    })

    // Driver comes online — join their personal room to receive ride assignments
    socket.on('driver:online', ({ driverId }: { driverId: string }) => {
      if (driverId) socket.join(`user:${driverId}`)
    })

    // Driver location broadcast — passengers on the ride see live movement
    socket.on('driver:location_update', ({ rideId, lat, lng }: { rideId?: string; lat: number; lng: number }) => {
      if (rideId) io.to(`ride:${rideId}`).emit('driver:location', { lat, lng })
    })
  })

  return io
}

export function getIo(): Server {
  if (!io) throw new Error('Socket.io not initialized')
  return io
}
