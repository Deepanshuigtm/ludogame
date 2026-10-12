/**
 * Online status.
 *
 * A user is online while at least one of their sockets is connected (phone + tablet both count). Going offline is
 * debounced by `offlineGraceMs` so a flaky network or an app switch doesn't make friend lists flicker.
 * Every transition is written to MongoDB (`users.isOnline`, `lastSeenAt`) and pushed to the user's friends.
 *
 * Note: this map lives in the process. For more than one server instance, move it to Redis (see README → Scaling).
 */
export class Presence {
  constructor({ users, emitToUser, offlineGraceMs = 5_000, logger }) {
    this.users = users;
    this.emitToUser = emitToUser;
    this.offlineGraceMs = offlineGraceMs;
    this.log = logger;
    this.sockets = new Map();        // uid → Set<socketId>
    this.offlineTimers = new Map();  // uid → Timeout
    this.listeners = new Set();      // (uid, isOnline) => void
  }

  isOnline(uid) { return (this.sockets.get(uid)?.size ?? 0) > 0; }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async connected(user, socketId) {
    const uid = user.firebaseUid;
    clearTimeout(this.offlineTimers.get(uid));
    this.offlineTimers.delete(uid);
    const set = this.sockets.get(uid) ?? new Set();
    const wasOnline = set.size > 0;
    set.add(socketId);
    this.sockets.set(uid, set);
    if (!wasOnline) await this.publish(user, true);
  }

  disconnected(user, socketId) {
    const uid = user.firebaseUid;
    const set = this.sockets.get(uid);
    if (!set) return;
    set.delete(socketId);
    if (set.size > 0) return;
    this.sockets.delete(uid);
    clearTimeout(this.offlineTimers.get(uid));
    this.offlineTimers.set(uid, setTimeout(() => {
      this.offlineTimers.delete(uid);
      if (!this.isOnline(uid)) this.publish(user, false).catch((err) => this.log?.error({ err }, 'presence publish failed'));
    }, this.offlineGraceMs));
  }

  async publish(user, isOnline) {
    const uid = user.firebaseUid;
    await this.users.setOnline(uid, isOnline);
    // Fresh friend list: friendships may have changed since this socket connected.
    const fresh = (await this.users.findByUid(uid)) ?? user;
    for (const friendUid of fresh.friends ?? []) this.emitToUser(friendUid, 'presence:update', { uid, isOnline, lastSeenAt: new Date() });
    for (const fn of this.listeners) fn(uid, isOnline);
  }

  shutdown() {
    for (const t of this.offlineTimers.values()) clearTimeout(t);
    this.offlineTimers.clear();
  }
}
