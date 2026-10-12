import { z } from 'zod';
import { toClientError, Errors } from '../errors.js';

const uid = z.string().min(1).max(128);
const roomId = z.string().uuid();
const schemas = {
  'lobby:create': z.object({ friendUids: z.array(uid).max(3) }),
  'lobby:invite': z.object({ roomId, friendUids: z.array(uid).min(1).max(3) }),
  'invite:accept': z.object({ roomId }),
  'invite:decline': z.object({ roomId }),
  'lobby:start': z.object({ roomId }),
  'room:leave': z.object({ roomId }),
  'game:roll': z.object({ roomId }),
  'game:move': z.object({ roomId, tokenId: z.number().int().min(0).max(15) }),
  'room:sync': z.object({}).passthrough(),
};

/**
 * Socket.IO wiring.
 *
 * Handshake: the app connects with `auth: { token: <Firebase ID token> }`. The token is verified before the
 * connection is accepted; the socket joins `user:<uid>` (all of that user's devices) and, if they are at a table,
 * `room:<roomId>`.
 *
 * Client → server events are *requests with acks*: `socket.emit(event, payload, ack)` → ack({ ok, data } | { ok:false, error }).
 * Server → client events: presence:update, friend:*, invite:received, invite:cancelled, lobby:update, lobby:closed,
 * game:started, game:rolled, game:moved, game:over, room:seat.
 */
export function attachSockets(io, { verify, users, presence, rooms, logger, ratePerSecond = 20 }) {
  io.use(async (socket, next) => {
    try {
      const identity = await verify(socket.handshake.auth?.token);
      socket.data.user = await users.upsertFromAuth(identity);
      next();
    } catch (err) {
      next(Object.assign(new Error(toClientError(err).code), { data: toClientError(err) }));
    }
  });

  io.on('connection', async (socket) => {
    const me = socket.data.user;
    const myUid = me.firebaseUid;
    socket.join(`user:${myUid}`);
    try {
      await presence.connected(me, socket.id);
    } catch (err) {
      logger?.error({ err }, 'presence connect failed');
    }
    rooms.connectionChanged(myUid, true);
    // Someone invited this player while they were offline: deliver the invites now that they're here.
    for (const invite of rooms.pendingInvitesFor(myUid)) socket.emit('invite:received', invite);

    // Token-bucket rate limit per socket (default 20 requests / second). Real players send a few per turn.
    let tokens = ratePerSecond;
    const refill = setInterval(() => { tokens = Math.min(ratePerSecond, tokens + ratePerSecond / 2); }, 500);

    const handle = (event, fn) => socket.on(event, async (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      if (tokens-- <= 0) return reply({ ok: false, error: { code: 'RATE_LIMITED', message: 'Slow down.' } });
      try {
        const parsed = schemas[event].safeParse(payload ?? {});
        if (!parsed.success) throw Errors.validation(parsed.error.issues[0]?.message ?? 'Invalid request');
        // Always act on fresh user data (friend list may have changed since connect).
        const fresh = (await users.findByUid(myUid)) ?? me;
        reply({ ok: true, data: await fn(parsed.data, fresh) });
      } catch (err) {
        if (!err?.code) logger?.error({ err, event, uid: myUid }, 'socket handler failed');
        reply({ ok: false, error: toClientError(err) });
      }
    });

    handle('lobby:create', ({ friendUids }, user) => rooms.createLobby(user, friendUids));
    handle('lobby:invite', ({ roomId, friendUids }, user) => rooms.inviteMore(roomId, user, friendUids));
    handle('invite:accept', ({ roomId }, user) => rooms.acceptInvite(roomId, user));
    handle('invite:decline', ({ roomId }, user) => rooms.declineInvite(roomId, user));
    handle('lobby:start', ({ roomId }, user) => rooms.start(roomId, user));
    handle('room:leave', ({ roomId }, user) => rooms.leave(roomId, user));
    handle('game:roll', ({ roomId }, user) => rooms.roll(roomId, user));
    handle('game:move', ({ roomId, tokenId }, user) => rooms.move(roomId, user, tokenId));
    handle('room:sync', (_payload, user) => rooms.snapshot(user.firebaseUid));

    socket.on('disconnect', (reason) => {
      clearInterval(refill);
      presence.disconnected(me, socket.id);
      if (!presence.isOnline(myUid)) rooms.connectionChanged(myUid, false);
      logger?.debug({ uid: myUid, reason }, 'socket disconnected');
    });
  });

}

/** Server → client delivery used by the services (decoupled from the connection handler to avoid a cycle). */
export function createTransport(io) {
  return {
    toUser: (uidValue, event, payload) => io.to(`user:${uidValue}`).emit(event, payload),
    toRoom: (id, event, payload) => io.to(`room:${id}`).emit(event, payload),
    joinRoom: (uidValue, id) => io.in(`user:${uidValue}`).socketsJoin(`room:${id}`),
    leaveRoom: (uidValue, id) => io.in(`user:${uidValue}`).socketsLeave(`room:${id}`),
  };
}
