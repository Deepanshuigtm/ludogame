import { Errors } from '../errors.js';
import { normalizeEmail, publicProfile } from '../db/repositories.js';

/**
 * Friends: search by email, requests (send / accept / decline / cancel), friend list, unfriend.
 *
 * Consistency rules
 * - One pending request per pair (partial unique index on pairKey); a duplicate insert race maps to REQUEST_ALREADY_SENT.
 * - If B already asked A and A now sends a request to B, it is treated as A accepting B's request.
 * - Accepting flips the request and adds both uids to each other's `friends` array in ONE transaction, so the
 *   friendship can never be half-written.
 * - Every state change is pushed to the affected user(s) through `events` (sockets) and, for new requests to an
 *   offline user, through the notifier (FCM).
 */
export class SocialService {
  constructor({ repos, events, notifier, presence, maxFriends = 500, logger }) {
    this.repos = repos;
    this.events = events;       // { toUser(uid, event, payload) }
    this.notifier = notifier;   // { friendRequest(toUser, fromUser) }
    this.presence = presence;   // { isOnline(uid) }
    this.maxFriends = maxFriends;
    this.log = logger;
  }

  relationship(me, other, pending) {
    if (me.firebaseUid === other.firebaseUid) return 'self';
    if (me.friends?.includes(other.firebaseUid)) return 'friend';
    if (pending) return pending.fromUid === me.firebaseUid ? 'pending_out' : 'pending_in';
    return 'none';
  }

  /** Exact-match email lookup (no prefix search, so the user base can't be enumerated). */
  async searchByEmail(me, email) {
    const target = await this.repos.users.findByEmail(normalizeEmail(email));
    if (!target) throw Errors.userNotFound();
    const pending = await this.repos.requests.findPendingForPair(me.firebaseUid, target.firebaseUid);
    const profile = publicProfile(target);
    // Online status is only visible to friends.
    const rel = this.relationship(me, target, pending);
    return { ...profile, isOnline: rel === 'friend' ? profile.isOnline : false, relationship: rel, requestId: pending?._id?.toString() ?? null };
  }

  async sendRequest(me, { email, toUid }) {
    const target = toUid ? await this.repos.users.findByUid(toUid) : await this.repos.users.findByEmail(normalizeEmail(email));
    if (!target) throw Errors.userNotFound();
    if (target.firebaseUid === me.firebaseUid) throw Errors.self();
    if (me.friends?.includes(target.firebaseUid)) throw Errors.alreadyFriends();

    const pending = await this.repos.requests.findPendingForPair(me.firebaseUid, target.firebaseUid);
    if (pending) {
      if (pending.fromUid === me.firebaseUid) throw Errors.alreadyRequested();
      // They already asked us: sending back means "yes".
      const friend = await this.accept(me, pending._id.toString());
      return { status: 'accepted', friend };
    }

    let request;
    try {
      request = await this.repos.requests.create(me.firebaseUid, target.firebaseUid);
    } catch (err) {
      if (err?.code === 11000) throw Errors.alreadyRequested(); // concurrent duplicate
      throw err;
    }
    const payload = this.requestView(request, me);
    this.events.toUser(target.firebaseUid, 'friend:request', payload);
    if (!this.presence.isOnline(target.firebaseUid)) {
      this.notifier.friendRequest(target, me).catch((e) => this.log?.warn({ err: e }, 'friend request push failed'));
    }
    return { status: 'pending', request: { ...payload, to: publicProfile(target) } };
  }

  async accept(me, requestId) {
    const friendUid = await this.repos.withTransaction(async (session) => {
      const request = await this.repos.requests.close(requestId, 'toUid', me.firebaseUid, 'accepted', session);
      if (!request) throw Errors.requestGone();
      const [a, b] = await this.repos.users.findManyByUids([request.fromUid, request.toUid], session);
      if (!a || !b) throw Errors.userNotFound();
      if ((a.friends?.length ?? 0) >= this.maxFriends || (b.friends?.length ?? 0) >= this.maxFriends) throw Errors.friendLimit();
      await this.repos.users.addFriendPair(request.fromUid, request.toUid, session);
      return request.fromUid;
    });
    const friend = await this.repos.users.findByUid(friendUid);
    const meFresh = await this.repos.users.findByUid(me.firebaseUid);
    this.events.toUser(friendUid, 'friend:accepted', { requestId, friend: this.friendView(meFresh) });
    this.events.toUser(me.firebaseUid, 'friend:accepted', { requestId, friend: this.friendView(friend) });
    return this.friendView(friend);
  }

  async decline(me, requestId) {
    const request = await this.repos.requests.close(requestId, 'toUid', me.firebaseUid, 'declined');
    if (!request) throw Errors.requestGone();
    this.events.toUser(request.fromUid, 'friend:declined', { requestId });
    return { ok: true };
  }

  async cancel(me, requestId) {
    const request = await this.repos.requests.close(requestId, 'fromUid', me.firebaseUid, 'cancelled');
    if (!request) throw Errors.requestGone();
    this.events.toUser(request.toUid, 'friend:cancelled', { requestId });
    return { ok: true };
  }

  async listRequests(me) {
    const [incoming, outgoing] = await Promise.all([
      this.repos.requests.listPending('toUid', me.firebaseUid),
      this.repos.requests.listPending('fromUid', me.firebaseUid),
    ]);
    const others = await this.repos.users.findManyByUids([...incoming.map((r) => r.fromUid), ...outgoing.map((r) => r.toUid)]);
    const byUid = new Map(others.map((u) => [u.firebaseUid, u]));
    const view = (r, uid) => ({ id: r._id.toString(), createdAt: r.createdAt, user: { ...publicProfile(byUid.get(uid)), isOnline: false } });
    return {
      incoming: incoming.filter((r) => byUid.has(r.fromUid)).map((r) => view(r, r.fromUid)),
      outgoing: outgoing.filter((r) => byUid.has(r.toUid)).map((r) => view(r, r.toUid)),
    };
  }

  async listFriends(me) {
    const fresh = await this.repos.users.findByUid(me.firebaseUid);
    const friends = await this.repos.users.findManyByUids(fresh?.friends ?? []);
    return friends
      .map((f) => this.friendView(f))
      .sort((a, b) => Number(b.isOnline) - Number(a.isOnline) || a.displayName.localeCompare(b.displayName));
  }

  async unfriend(me, friendUid) {
    if (!me.friends?.includes(friendUid)) throw Errors.notFriends();
    await this.repos.withTransaction((session) => this.repos.users.removeFriendPair(me.firebaseUid, friendUid, session));
    this.events.toUser(friendUid, 'friend:removed', { uid: me.firebaseUid });
    return { ok: true };
  }

  /** Live presence comes from the socket layer (authoritative and instant); the DB flag is the fallback. */
  friendView(u) {
    const p = publicProfile(u);
    return { ...p, isOnline: this.presence.isOnline(u.firebaseUid) || false };
  }

  requestView(r, from) {
    return { id: r._id.toString(), createdAt: r.createdAt, user: { ...publicProfile(from), isOnline: false } };
  }
}
