import { createServer } from 'http'
import app from './app.js'
import { initSocket } from './socket.js'
import { bootstrapAssignmentTimeouts } from './services/ride-assignment.js'

const port = process.env.PORT ? Number(process.env.PORT) : 4000
const host = process.env.HOST ?? '0.0.0.0'

const server = createServer(app)
initSocket(server)
bootstrapAssignmentTimeouts().catch(() => null)

server.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`)
})
