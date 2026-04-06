import { createServer } from 'http';
import app from './app';
import { initSocket } from './socket';
const port = process.env.PORT ? Number(process.env.PORT) : 4000;
const host = process.env.HOST ?? '0.0.0.0';
const server = createServer(app);
initSocket(server);
server.listen(port, host, () => {
    console.log(`API listening on http://${host}:${port}`);
});
