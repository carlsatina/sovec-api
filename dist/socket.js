import { Server } from 'socket.io';
let io = null;
export function initSocket(server) {
    io = new Server(server, {
        cors: { origin: '*' }
    });
    io.on('connection', (socket) => {
        // Generic room join (passenger + driver)
        socket.on('join', ({ userId, rideId }) => {
            if (userId)
                socket.join(`user:${userId}`);
            if (rideId)
                socket.join(`ride:${rideId}`);
        });
        // Driver comes online — join their personal room to receive ride assignments
        socket.on('driver:online', ({ driverId }) => {
            if (driverId)
                socket.join(`user:${driverId}`);
        });
        // Driver location broadcast — passengers on the ride see live movement
        socket.on('driver:location_update', ({ rideId, lat, lng }) => {
            if (!io || !rideId)
                return;
            io.to(`ride:${rideId}`).emit('driver:location', { lat, lng });
        });
    });
    return io;
}
export function getIo() {
    if (!io)
        throw new Error('Socket.io not initialized');
    return io;
}
