import http from 'node:http';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { httpAuth } from './auth/firebase.js';
import { createApiRouter, errorHandler } from './http/routes.js';
import { Presence } from './realtime/presence.js';
import { attachSockets, createTransport } from './realtime/sockets.js';
import { SocialService } from './services/socialService.js';
import { Notifier } from './services/notifier.js';
import { RoomManager } from './game/rooms.js';

/**
 * Builds the whole server from its dependencies. Production wiring is in server.js; tests pass in-memory
 * repositories, a fake token verifier and a fake FCM.
 */
export function createApp({ config, repos, verify, messaging = null, mailTransport, logger, rng, offlineGraceMs }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(express.json({ limit: '32kb' }));

  const httpServer = http.createServer(app);
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins.length ? config.corsOrigins : false },
    pingInterval: 20_000,
    pingTimeout: 20_000,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60_000, skipMiddlewares: false },
  });
  const transport = createTransport(io);

  const presence = new Presence({ users: repos.users, emitToUser: transport.toUser, offlineGraceMs, logger });
  const notifier = new Notifier({ messaging, users: repos.users, config, logger, transport: mailTransport });
  const social = new SocialService({ repos, events: transport, notifier, presence, maxFriends: config.maxFriends, logger });
  const rooms = new RoomManager({ transport, presence, users: repos.users, games: repos.games, notifier, config, logger, rng });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.get('/', (req, res) => res.json({ ok: true, service: 'ludo-classic-server' }));
  app.use('/api', createApiRouter({ auth: httpAuth(verify, repos.users), social, users: repos.users, rooms }));
  app.use((req, res) => res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No such endpoint' } }));
  app.use(errorHandler(logger));

  attachSockets(io, { verify, users: repos.users, presence, rooms, logger, ratePerSecond: config.socketRatePerSecond ?? 20 });

  async function close() {
    rooms.shutdown();
    presence.shutdown();
    await new Promise((resolve) => io.close(() => resolve()));
    if (httpServer.listening) await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return { app, httpServer, io, services: { presence, notifier, social, rooms }, close };
}
