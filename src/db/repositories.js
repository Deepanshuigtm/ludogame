import { ObjectId } from 'mongodb';
import { COLLECTIONS } from './mongo.js';

/**
 * Data access, kept behind a small interface so the social/realtime services can be unit-tested against the
 * in-memory twin in test/support/memoryRepos.js. Every method takes an optional `session` for transactions.
 */

export const normalizeEmail = (email) => String(email ?? '').trim().toLowerCase();
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** Public profile shape returned to clients – never leaks email of non-friends, tokens or settings. */
export const publicProfile = (u) => u && { uid: u.firebaseUid, displayName: u.displayName, photoUrl: u.photoUrl ?? null, isOnline: !!u.isOnline, lastSeenAt: u.lastSeenAt ?? null };

const MAX_FCM_TOKENS = 5;
const CLOSED_REQUEST_RETENTION_MS = 30 * 24 * 3600 * 1000;

export class MongoRepositories {
  constructor(client, db) {
    this.client = client;
    this.usersCol = db.collection(COLLECTIONS.users);
    this.requestsCol = db.collection(COLLECTIONS.friendRequests);
    this.gamesCol = db.collection(COLLECTIONS.games);
    this.users = new MongoUserRepo(this.usersCol);
    this.requests = new MongoRequestRepo(this.requestsCol);
    this.games = new MongoGameRepo(this.gamesCol, this.usersCol);
  }

  /** Runs fn(session) in a multi-document transaction (Atlas replica set), retrying transient errors. */
  async withTransaction(fn) {
    const session = this.client.startSession();
    try {
      let result;
      await session.withTransaction(async () => { result = await fn(session); }, {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      return result;
    } finally {
      await session.endSession();
    }
  }
}

class MongoUserRepo {
  constructor(col) { this.col = col; }

  /** Create on first sign-in, refresh name/photo/email on later ones. Returns the stored document. */
  async upsertFromAuth({ uid, email, displayName, photoUrl }) {
    const now = new Date();
    return this.col.findOneAndUpdate(
      { firebaseUid: uid },
      {
        $set: { email: normalizeEmail(email), displayName: (displayName || email.split('@')[0]).slice(0, 80), photoUrl: photoUrl ?? null, updatedAt: now },
        $setOnInsert: { firebaseUid: uid, isOnline: false, lastSeenAt: now, friends: [], fcmTokens: [], settings: { emailInvites: true }, stats: { gamesPlayed: 0, wins: 0 }, createdAt: now },
      },
      { upsert: true, returnDocument: 'after' },
    );
  }

  findByUid(uid, session) { return this.col.findOne({ firebaseUid: uid }, { session }); }
  findByEmail(email, session) { return this.col.findOne({ email: normalizeEmail(email) }, { session }); }
  findManyByUids(uids, session) { return uids.length ? this.col.find({ firebaseUid: { $in: uids } }, { session }).toArray() : Promise.resolve([]); }

  async addFriendPair(a, b, session) {
    await this.col.updateOne({ firebaseUid: a }, { $addToSet: { friends: b }, $set: { updatedAt: new Date() } }, { session });
    await this.col.updateOne({ firebaseUid: b }, { $addToSet: { friends: a }, $set: { updatedAt: new Date() } }, { session });
  }

  async removeFriendPair(a, b, session) {
    await this.col.updateOne({ firebaseUid: a }, { $pull: { friends: b } }, { session });
    await this.col.updateOne({ firebaseUid: b }, { $pull: { friends: a } }, { session });
  }

  setOnline(uid, isOnline) {
    return this.col.updateOne({ firebaseUid: uid }, { $set: { isOnline, lastSeenAt: new Date() } });
  }

  /** Crash recovery at boot: nobody is connected to a fresh process. (Single instance – see README for scaling.) */
  resetAllOffline() { return this.col.updateMany({ isOnline: true }, { $set: { isOnline: false } }); }

  /** Keeps the MAX_FCM_TOKENS most recent device tokens. */
  async addFcmToken(uid, token, platform = 'android') {
    await this.col.updateOne({ firebaseUid: uid }, { $pull: { fcmTokens: { token } } });
    await this.col.updateOne(
      { firebaseUid: uid },
      { $push: { fcmTokens: { $each: [{ token, platform, updatedAt: new Date() }], $sort: { updatedAt: -1 }, $slice: MAX_FCM_TOKENS } } },
    );
  }

  removeFcmTokens(tokens) {
    return tokens.length ? this.col.updateMany({ 'fcmTokens.token': { $in: tokens } }, { $pull: { fcmTokens: { token: { $in: tokens } } } }) : null;
  }

  updateSettings(uid, settings) {
    const set = Object.fromEntries(Object.entries(settings).map(([k, v]) => [`settings.${k}`, v]));
    return this.col.findOneAndUpdate({ firebaseUid: uid }, { $set: { ...set, updatedAt: new Date() } }, { returnDocument: 'after' });
  }
}

class MongoRequestRepo {
  constructor(col) { this.col = col; }

  findPendingForPair(a, b, session) { return this.col.findOne({ pairKey: pairKey(a, b), status: 'pending' }, { session }); }

  async create(fromUid, toUid, session) {
    const doc = { fromUid, toUid, pairKey: pairKey(fromUid, toUid), status: 'pending', createdAt: new Date(), respondedAt: null, expiresAt: null };
    const res = await this.col.insertOne(doc, { session });
    return { ...doc, _id: res.insertedId };
  }

  findById(id, session) {
    if (!ObjectId.isValid(id)) return null;
    return this.col.findOne({ _id: new ObjectId(id) }, { session });
  }

  /** Atomically moves a *pending* request to `status`, only if `actorField` (toUid/fromUid) is the caller. */
  async close(id, actorField, actorUid, status, session) {
    if (!ObjectId.isValid(id)) return null;
    const now = new Date();
    return this.col.findOneAndUpdate(
      { _id: new ObjectId(id), status: 'pending', [actorField]: actorUid },
      { $set: { status, respondedAt: now, expiresAt: status === 'accepted' ? null : new Date(now.getTime() + CLOSED_REQUEST_RETENTION_MS) } },
      { returnDocument: 'after', session },
    );
  }

  listPending(field, uid) {
    return this.col.find({ [field]: uid, status: 'pending' }).sort({ createdAt: -1 }).limit(100).toArray();
  }
}

class MongoGameRepo {
  constructor(col, usersCol) { this.col = col; this.usersCol = usersCol; }

  async recordFinished(game) {
    await this.col.updateOne({ roomId: game.roomId }, { $setOnInsert: game }, { upsert: true });
    const ops = game.players.map((p) => ({
      updateOne: { filter: { firebaseUid: p.uid }, update: { $inc: { 'stats.gamesPlayed': 1, 'stats.wins': p.rank === 1 ? 1 : 0 } } },
    }));
    if (ops.length) await this.usersCol.bulkWrite(ops, { ordered: false });
  }
}
