import { MongoClient } from 'mongodb';

/**
 * MongoDB schema (database `ludogame`).
 *
 * users                     — one document per Firebase account
 *   _id            ObjectId
 *   firebaseUid    string   unique · the identity used everywhere else (friends, requests, games)
 *   email          string   unique · lower-cased, used for "add friend by email"
 *   displayName    string
 *   photoUrl       string|null
 *   isOnline       bool     true while ≥1 socket is connected (maintained by realtime/presence.js)
 *   lastSeenAt     Date
 *   friends        [string] firebaseUids of accepted friends · symmetric (both sides updated in one transaction)
 *   fcmTokens      [{ token, platform, updatedAt }]  ≤ 5 most recent devices
 *   settings       { emailInvites: bool }
 *   stats          { gamesPlayed, wins }
 *   createdAt / updatedAt
 *
 * friend_requests
 *   fromUid / toUid  string
 *   pairKey          string  "<smallerUid>|<largerUid>" – one pending request per pair, in either direction
 *   status           'pending' | 'accepted' | 'declined' | 'cancelled'
 *   createdAt / respondedAt
 *   expiresAt        Date    set when declined/cancelled → TTL index purges it after 30 days
 *
 * games                     — finished online matches (history + stats)
 *   roomId, players [{ uid, name, color, rank }], startedAt, finishedAt, turns
 *
 * Why an embedded `friends` array (not a separate edge collection): friend lists are small (capped at MAX_FRIENDS),
 * always read whole with the user, and the multikey index on `friends` answers "who has X as a friend" for presence
 * fan-out. Requests live in their own collection because they have a lifecycle, are queried by receiver, and need
 * a uniqueness rule across both directions (the partial unique index on pairKey).
 */
export const COLLECTIONS = Object.freeze({ users: 'users', friendRequests: 'friend_requests', games: 'games' });

const validators = {
  users: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['firebaseUid', 'email', 'displayName', 'isOnline', 'friends', 'createdAt'],
      properties: {
        firebaseUid: { bsonType: 'string', minLength: 1, maxLength: 128 },
        email: { bsonType: 'string', pattern: '^[^@\\s]+@[^@\\s]+$', maxLength: 320 },
        displayName: { bsonType: 'string', minLength: 1, maxLength: 80 },
        photoUrl: { bsonType: ['string', 'null'], maxLength: 2048 },
        isOnline: { bsonType: 'bool' },
        lastSeenAt: { bsonType: ['date', 'null'] },
        friends: { bsonType: 'array', items: { bsonType: 'string' }, maxItems: 1000 },
        fcmTokens: {
          bsonType: 'array',
          maxItems: 10,
          items: { bsonType: 'object', required: ['token'], properties: { token: { bsonType: 'string' }, platform: { bsonType: 'string' }, updatedAt: { bsonType: 'date' } } },
        },
        settings: { bsonType: 'object', properties: { emailInvites: { bsonType: 'bool' } } },
        stats: { bsonType: 'object', properties: { gamesPlayed: { bsonType: ['int', 'long', 'double'] }, wins: { bsonType: ['int', 'long', 'double'] } } },
      },
    },
  },
  friend_requests: {
    $jsonSchema: {
      bsonType: 'object',
      required: ['fromUid', 'toUid', 'pairKey', 'status', 'createdAt'],
      properties: {
        fromUid: { bsonType: 'string' },
        toUid: { bsonType: 'string' },
        pairKey: { bsonType: 'string' },
        status: { enum: ['pending', 'accepted', 'declined', 'cancelled'] },
        createdAt: { bsonType: 'date' },
        respondedAt: { bsonType: ['date', 'null'] },
        expiresAt: { bsonType: ['date', 'null'] },
      },
    },
  },
};

export async function connectMongo(uri, dbName, logger) {
  const client = new MongoClient(uri, {
    appName: 'ludo-backend',
    maxPoolSize: 50,
    retryWrites: true,
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  const db = client.db(dbName);
  await db.command({ ping: 1 });
  logger?.info({ dbName }, 'MongoDB connected');
  return { client, db };
}

/** Idempotent: creates collections with validators, and every index the app relies on. Safe to run at each boot. */
export async function ensureSchema(db, logger) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  // Never let schema housekeeping stop the server from booting (e.g. a hosted DB user without dbAdmin rights,
  // or an older `users` collection with documents that clash with a new index): log it and carry on.
  const soft = async (what, fn) => {
    try {
      await fn();
    } catch (err) {
      logger?.warn({ err: { code: err.code, codeName: err.codeName, message: err.message } }, `schema: could not ${what} – continuing`);
    }
  };
  for (const [name, validator] of Object.entries(validators)) {
    if (!existing.has(name)) {
      await soft(`create ${name}`, () => db.createCollection(name, { validator, validationLevel: 'moderate' }));
    } else {
      // collMod needs the dbAdmin role; Atlas users created as "readWrite" can't run it. Validators are optional.
      await soft(`update validator of ${name}`, () => db.command({ collMod: name, validator, validationLevel: 'moderate' }));
    }
  }
  if (!existing.has(COLLECTIONS.games)) await soft('create games', () => db.createCollection(COLLECTIONS.games));

  const users = db.collection(COLLECTIONS.users);
  // Partial unique indexes: documents written by other tools (without these fields) don't collide on null.
  await soft('create users indexes', () => users.createIndexes([
    { key: { firebaseUid: 1 }, name: 'uniq_firebaseUid', unique: true, partialFilterExpression: { firebaseUid: { $type: 'string' } } },
    { key: { email: 1 }, name: 'uniq_email', unique: true, partialFilterExpression: { email: { $type: 'string' } } },
    { key: { friends: 1 }, name: 'friends_multikey' },
    { key: { 'fcmTokens.token': 1 }, name: 'fcm_token', sparse: true },
  ]));

  const requests = db.collection(COLLECTIONS.friendRequests);
  await soft('create friend_requests indexes', () => requests.createIndexes([
    // At most ONE pending request per pair of users, whichever direction it was sent in.
    { key: { pairKey: 1 }, name: 'uniq_pending_pair', unique: true, partialFilterExpression: { status: 'pending' } },
    { key: { toUid: 1, status: 1, createdAt: -1 }, name: 'inbox' },
    { key: { fromUid: 1, status: 1, createdAt: -1 }, name: 'outbox' },
    // Declined / cancelled requests are purged automatically 30 days later.
    { key: { expiresAt: 1 }, name: 'ttl_closed_requests', expireAfterSeconds: 0 },
  ]));

  const games = db.collection(COLLECTIONS.games);
  await soft('create games indexes', () => games.createIndexes([
    { key: { roomId: 1 }, name: 'uniq_room', unique: true },
    { key: { 'players.uid': 1, finishedAt: -1 }, name: 'history_by_player' },
  ]));
  logger?.info('MongoDB schema and indexes ensured');
}
