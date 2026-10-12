import { randomInt, randomUUID } from 'node:crypto';
import * as engine from './engine.js';
import { Errors } from '../errors.js';

const MAX_PLAYERS = 4;
const MAX_INVITES_PER_CALL = 3;
/** Pause before the server plays for a bot / absent player – long enough for clients to finish animating. */
const AUTO_PLAY_DELAY_MS = 2_600;
/** A human with exactly one legal move gets it played automatically once the die has settled (same as offline). */
const SINGLE_MOVE_DELAY_MS = 2_400;
const FINISHED_ROOM_TTL_MS = 60_000;

/**
 * Lobbies and authoritative game rooms.
 *
 * Flow: host creates a lobby and invites ≤3 friends → online friends get `invite:received` instantly, offline friends
 * get FCM + email → each accept adds a seat and the whole lobby gets `lobby:update` (names + photos) → host starts →
 * `game:started` → players send `game:roll` / `game:move` intents, the server validates them, rolls the die with a
 * CSPRNG, applies the rules engine and broadcasts `game:rolled` / `game:moved` with the full new state and a
 * monotonically increasing `seq` (clients apply events strictly in seq order and can resync with `room:sync`).
 *
 * Transport is abstracted (`transport.toRoom/toUser/joinRoom/leaveRoom`) so this class is unit-tested without sockets.
 */
export class RoomManager {
  constructor({ transport, presence, users, games, notifier, config, logger, rng, clock }) {
    this.t = transport;
    this.presence = presence;
    this.users = users;
    this.games = games;
    this.notifier = notifier;
    this.config = config;
    this.log = logger;
    this.rng = rng ?? (() => randomInt(1, 7));
    this.clock = clock ?? { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h) };
    this.rooms = new Map();     // roomId → room
    this.userRoom = new Map();  // uid → roomId (one active table per player)
  }

  // ------------------------------------------------------------------------------------------------ lobby

  async createLobby(host, friendUids) {
    await this.leaveCurrent(host.firebaseUid);
    const room = {
      id: randomUUID(),
      hostUid: host.firebaseUid,
      status: 'lobby',
      createdAt: this.clock.now(),
      members: [this.memberOf(host)],
      invites: new Map(),
      inviteTimers: new Map(),
      game: null,
      seq: 0,
      turnTimer: null,
      turnDeadline: null,
      graceTimers: new Map(),
    };
    this.rooms.set(room.id, room);
    this.userRoom.set(host.firebaseUid, room.id);
    this.t.joinRoom(host.firebaseUid, room.id);
    await this.sendInvites(room, host, friendUids);
    return this.lobbyView(room);
  }

  async inviteMore(roomId, host, friendUids) {
    const room = this.requireRoom(roomId);
    if (room.hostUid !== host.firebaseUid) throw Errors.notHost();
    if (room.status !== 'lobby') throw Errors.alreadyStarted();
    await this.sendInvites(room, host, friendUids);
    return this.lobbyView(room);
  }

  async sendInvites(room, host, friendUids) {
    const uids = [...new Set(friendUids ?? [])].filter((u) => u !== host.firebaseUid);
    if (uids.length > MAX_INVITES_PER_CALL) throw Errors.tooManyInvites();
    if (uids.some((u) => !host.friends?.includes(u))) throw Errors.notFriends();
    const pending = [...room.invites.values()].filter((i) => i.status === 'pending' && !this.isMember(room, i.uid)).length;
    if (room.members.length + pending + uids.filter((u) => !this.isMember(room, u)).length > MAX_PLAYERS) throw Errors.roomFull();

    const invitees = await this.users.findManyByUids(uids);
    const expiresAt = this.clock.now() + this.config.inviteTtlMs;
    room.inviteExpiresAt = expiresAt;
    for (const user of invitees) {
      if (this.isMember(room, user.firebaseUid)) continue;
      const online = this.presence.isOnline(user.firebaseUid);
      const invite = { uid: user.firebaseUid, name: user.displayName, photoUrl: user.photoUrl ?? null, status: 'pending', delivery: online ? 'live' : 'push', expiresAt };
      room.invites.set(user.firebaseUid, invite);
      this.clock.clearTimeout(room.inviteTimers.get(user.firebaseUid));
      room.inviteTimers.set(user.firebaseUid, this.clock.setTimeout(() => this.expireInvite(room.id, user.firebaseUid), this.config.inviteTtlMs));
      if (online) {
        this.t.toUser(user.firebaseUid, 'invite:received', this.inviteView(room, host, expiresAt));
      } else {
        // Offline: phone notification + email. Fire-and-forget – the invite stays valid while it travels.
        this.notifier.gameInvite(user, host, { id: room.id, inviteExpiresAt: expiresAt })
          .then((r) => this.log?.info({ roomId: room.id, to: user.firebaseUid, ...r }, 'offline invite delivered'))
          .catch((err) => this.log?.warn({ err }, 'offline invite failed'));
      }
    }
    this.broadcastLobby(room);
  }

  expireInvite(roomId, uid) {
    const room = this.rooms.get(roomId);
    const invite = room?.invites.get(uid);
    if (!invite || invite.status !== 'pending') return;
    invite.status = 'expired';
    this.t.toUser(uid, 'invite:cancelled', { roomId, reason: 'EXPIRED' });
    this.broadcastLobby(room);
  }

  async acceptInvite(roomId, user) {
    const room = this.rooms.get(roomId);
    if (!room) throw Errors.roomNotFound();
    if (this.isMember(room, user.firebaseUid)) return this.lobbyView(room); // idempotent (double tap / two devices)
    const invite = room.invites.get(user.firebaseUid);
    if (room.status !== 'lobby') throw Errors.alreadyStarted();
    if (!invite || invite.status !== 'pending' || invite.expiresAt < this.clock.now()) throw Errors.inviteExpired();
    if (room.members.length >= MAX_PLAYERS) throw Errors.roomFull();

    await this.leaveCurrent(user.firebaseUid);
    invite.status = 'accepted';
    this.clock.clearTimeout(room.inviteTimers.get(user.firebaseUid));
    room.members.push(this.memberOf(user));
    this.userRoom.set(user.firebaseUid, room.id);
    this.t.joinRoom(user.firebaseUid, room.id);
    this.broadcastLobby(room);
    return this.lobbyView(room);
  }

  declineInvite(roomId, user) {
    const room = this.rooms.get(roomId);
    const invite = room?.invites.get(user.firebaseUid);
    if (!invite || invite.status !== 'pending') return { ok: true };
    invite.status = 'declined';
    this.clock.clearTimeout(room.inviteTimers.get(user.firebaseUid));
    this.broadcastLobby(room);
    return { ok: true };
  }

  async start(roomId, user) {
    const room = this.requireRoom(roomId);
    if (room.hostUid !== user.firebaseUid) throw Errors.notHost();
    if (room.status !== 'lobby') throw Errors.alreadyStarted();
    if (room.members.length < 2) throw Errors.notEnoughPlayers();

    // Seats: host gets Blue, then the classic layout for 2 / 3 / 4 players in join order.
    const colors = engine.defaultColors(room.members.length, 'BLUE');
    room.members.forEach((m, i) => { m.color = colors[i]; });
    room.game = engine.newGame(room.members.map((m) => ({ color: m.color, name: m.name, type: 'HUMAN' })));
    room.status = 'playing';
    room.startedAt = new Date(this.clock.now());
    for (const [uid, invite] of room.invites) {
      if (invite.status === 'pending') {
        invite.status = 'expired';
        this.clock.clearTimeout(room.inviteTimers.get(uid));
        this.t.toUser(uid, 'invite:cancelled', { roomId, reason: 'STARTED' });
      }
    }
    room.seq += 1;
    this.scheduleTurn(room);
    this.t.toRoom(room.id, 'game:started', { roomId: room.id, seq: room.seq, seats: this.seats(room), state: room.game, turnDeadline: room.turnDeadline, serverNow: this.clock.now() });
    return { ok: true };
  }

  // ------------------------------------------------------------------------------------------------ game actions

  roll(roomId, user) {
    const room = this.requirePlaying(roomId);
    this.requireTurn(room, user.firebaseUid, 'ROLL');
    this.applyRoll(room);
    return { ok: true };
  }

  move(roomId, user, tokenId) {
    const room = this.requirePlaying(roomId);
    this.requireTurn(room, user.firebaseUid, 'MOVE');
    const mv = room.game.legalMoves.find((m) => m.tokenId === tokenId);
    if (!mv) throw Errors.illegalMove();
    this.applyMove(room, mv);
    return { ok: true };
  }

  applyRoll(room) {
    const value = this.rng();
    const { state, events } = engine.roll(room.game, value);
    room.game = state;
    room.seq += 1;
    this.afterAction(room);
    this.t.toRoom(room.id, 'game:rolled', { roomId: room.id, seq: room.seq, value, events, state, turnDeadline: room.turnDeadline, serverNow: this.clock.now() });
  }

  applyMove(room, mv) {
    const { state, events } = engine.move(room.game, mv);
    room.game = state;
    room.seq += 1;
    this.afterAction(room);
    this.t.toRoom(room.id, 'game:moved', { roomId: room.id, seq: room.seq, move: mv, events, state, turnDeadline: room.turnDeadline, serverNow: this.clock.now() });
    if (state.phase === 'GAME_OVER') this.finish(room).catch((err) => this.log?.error({ err }, 'finish failed'));
  }

  afterAction(room) {
    if (room.game.phase === 'GAME_OVER') {
      this.clock.clearTimeout(room.turnTimer);
      room.turnTimer = null;
      room.turnDeadline = null;
    } else {
      this.scheduleTurn(room);
    }
  }

  /** Arms the turn timer: humans get TURN_TIMEOUT, bots / absent players are played after a short pause. */
  scheduleTurn(room) {
    this.clock.clearTimeout(room.turnTimer);
    const member = this.memberByColor(room, engine.currentColor(room.game));
    const auto = !member || member.isBot;
    const single = room.game.phase === 'MOVE' && room.game.legalMoves.length === 1;
    const delay = auto ? AUTO_PLAY_DELAY_MS : single ? SINGLE_MOVE_DELAY_MS : this.config.turnTimeoutMs;
    room.turnDeadline = this.clock.now() + delay;
    const expectedSeq = room.seq;
    room.turnTimer = this.clock.setTimeout(() => this.autoAct(room.id, expectedSeq), delay);
  }

  autoAct(roomId, expectedSeq) {
    const room = this.rooms.get(roomId);
    if (!room || room.status !== 'playing' || room.seq !== expectedSeq) return; // someone acted meanwhile
    try {
      if (room.game.phase === 'ROLL') this.applyRoll(room);
      else if (room.game.phase === 'MOVE') this.applyMove(room, engine.chooseAutoMove(room.game));
    } catch (err) {
      this.log?.error({ err, roomId }, 'auto-play failed');
    }
  }

  async finish(room) {
    room.status = 'finished';
    const ranking = room.game.finishOrder.map((color, i) => {
      const m = this.memberByColor(room, color);
      return { uid: m.uid, name: m.name, photoUrl: m.photoUrl, color, rank: i + 1 };
    });
    this.t.toRoom(room.id, 'game:over', { roomId: room.id, seq: room.seq, ranking });
    room.disposeTimer = this.clock.setTimeout(() => this.dispose(room.id), FINISHED_ROOM_TTL_MS);
    try {
      await this.games.recordFinished({
        roomId: room.id,
        players: ranking.map(({ uid, name, color, rank }) => ({ uid, name, color, rank })),
        startedAt: room.startedAt,
        finishedAt: new Date(this.clock.now()),
        turns: room.game.turnNumber,
      });
    } catch (err) {
      this.log?.error({ err, roomId: room.id }, 'could not record game');
    }
  }

  // ------------------------------------------------------------------------------------------------ membership

  /** Leaving a lobby frees the seat (host leaving closes it); leaving a game hands your seat to the bot. */
  async leave(roomId, user) {
    const room = this.rooms.get(roomId);
    if (!room || !this.isMember(room, user.firebaseUid)) return { ok: true };
    this.userRoom.delete(user.firebaseUid);
    this.t.leaveRoom(user.firebaseUid, room.id);

    if (room.status === 'lobby') {
      if (room.hostUid === user.firebaseUid) {
        this.t.toRoom(room.id, 'lobby:closed', { roomId: room.id, reason: 'HOST_LEFT' });
        for (const [uid, invite] of room.invites) if (invite.status === 'pending') this.t.toUser(uid, 'invite:cancelled', { roomId: room.id, reason: 'HOST_LEFT' });
        this.dispose(room.id);
      } else {
        room.members = room.members.filter((m) => m.uid !== user.firebaseUid);
        const invite = room.invites.get(user.firebaseUid);
        if (invite) invite.status = 'declined';
        this.broadcastLobby(room);
      }
    } else if (room.status === 'playing') {
      const m = room.members.find((x) => x.uid === user.firebaseUid);
      m.left = true;
      m.isBot = true;
      m.connected = false;
      this.t.toRoom(room.id, 'room:seat', { roomId: room.id, uid: m.uid, connected: false, isBot: true, left: true });
      if (room.members.every((x) => x.left)) this.dispose(room.id);
      else if (this.memberByColor(room, engine.currentColor(room.game))?.uid === m.uid) this.scheduleTurn(room);
    }
    return { ok: true };
  }

  async leaveCurrent(uid) {
    const current = this.userRoom.get(uid);
    if (current) await this.leave(current, { firebaseUid: uid });
  }

  /** Socket presence changes for a player who is at a table. */
  connectionChanged(uid, connected) {
    const room = this.rooms.get(this.userRoom.get(uid));
    if (!room) return;
    const m = room.members.find((x) => x.uid === uid);
    if (!m || m.left) return;
    m.connected = connected;
    this.clock.clearTimeout(room.graceTimers.get(uid));
    room.graceTimers.delete(uid);
    if (connected) {
      this.t.joinRoom(uid, room.id);
      if (m.isBot) m.isBot = false;
    } else if (room.status === 'playing') {
      // Keep the seat for the grace period, then let the bot play it until they're back.
      room.graceTimers.set(uid, this.clock.setTimeout(() => {
        m.isBot = true;
        this.t.toRoom(room.id, 'room:seat', { roomId: room.id, uid, connected: false, isBot: true, left: false });
        if (this.memberByColor(room, engine.currentColor(room.game))?.uid === uid) this.scheduleTurn(room);
      }, this.config.reconnectGraceMs));
    }
    if (room.status === 'lobby') this.broadcastLobby(room);
    else this.t.toRoom(room.id, 'room:seat', { roomId: room.id, uid, connected, isBot: m.isBot, left: false });
  }

  /** Open invitations waiting for this user (shown when the app is opened from a push notification or email). */
  pendingInvitesFor(uid) {
    const now = this.clock.now();
    const out = [];
    for (const room of this.rooms.values()) {
      const invite = room.invites.get(uid);
      if (room.status !== 'lobby' || invite?.status !== 'pending' || invite.expiresAt <= now) continue;
      const host = room.members.find((m) => m.uid === room.hostUid);
      if (!host) continue;
      out.push({ roomId: room.id, host: { uid: host.uid, name: host.name, photoUrl: host.photoUrl ?? null }, players: room.members.length, expiresAt: invite.expiresAt });
    }
    return out.sort((a, b) => b.expiresAt - a.expiresAt);
  }

  /** Full picture for a (re)connecting client. */
  snapshot(uid) {
    const room = this.rooms.get(this.userRoom.get(uid));
    if (!room) return { room: null };
    if (room.status === 'lobby') return { room: this.lobbyView(room) };
    return { room: this.lobbyView(room), game: { roomId: room.id, seq: room.seq, seats: this.seats(room), state: room.game, turnDeadline: room.turnDeadline, serverNow: this.clock.now() } };
  }

  dispose(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    this.clock.clearTimeout(room.turnTimer);
    this.clock.clearTimeout(room.disposeTimer);
    for (const h of room.inviteTimers.values()) this.clock.clearTimeout(h);
    for (const h of room.graceTimers.values()) this.clock.clearTimeout(h);
    for (const m of room.members) {
      if (this.userRoom.get(m.uid) === roomId) this.userRoom.delete(m.uid);
      this.t.leaveRoom(m.uid, roomId);
    }
    this.rooms.delete(roomId);
  }

  shutdown() { for (const id of [...this.rooms.keys()]) this.dispose(id); }

  // ------------------------------------------------------------------------------------------------ helpers & views

  memberOf(user) {
    return { uid: user.firebaseUid, name: user.displayName, photoUrl: user.photoUrl ?? null, color: null, connected: true, isBot: false, left: false };
  }

  isMember(room, uid) { return room.members.some((m) => m.uid === uid); }
  memberByColor(room, color) { return room.members.find((m) => m.color === color); }

  requireRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) throw Errors.roomNotFound();
    return room;
  }

  requirePlaying(roomId) {
    const room = this.requireRoom(roomId);
    if (room.status !== 'playing') throw Errors.notYourTurn();
    return room;
  }

  requireTurn(room, uid, phase) {
    const member = this.memberByColor(room, engine.currentColor(room.game));
    if (!member || member.uid !== uid || room.game.phase !== phase) throw Errors.notYourTurn();
  }

  seats(room) {
    return room.members.map(({ uid, name, photoUrl, color, connected, isBot, left }) => ({ uid, name, photoUrl, color, connected, isBot, left }));
  }

  lobbyView(room) {
    return {
      roomId: room.id,
      hostUid: room.hostUid,
      status: room.status,
      maxPlayers: MAX_PLAYERS,
      players: room.members.map(({ uid, name, photoUrl, color, connected }) => ({ uid, name, photoUrl, color, connected, isHost: uid === room.hostUid })),
      invites: [...room.invites.values()].map(({ uid, name, photoUrl, status, delivery, expiresAt }) => ({ uid, name, photoUrl, status, delivery, expiresAt })),
    };
  }

  inviteView(room, host, expiresAt) {
    return { roomId: room.id, host: { uid: host.firebaseUid, name: host.displayName, photoUrl: host.photoUrl ?? null }, players: room.members.length, expiresAt };
  }

  broadcastLobby(room) { this.t.toRoom(room.id, 'lobby:update', this.lobbyView(room)); }
}
