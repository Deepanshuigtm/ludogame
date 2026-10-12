import { ObjectId } from 'mongodb';
import { normalizeEmail, pairKey } from '../../src/db/repositories.js';

/** In-memory twin of MongoRepositories with the same semantics the services rely on (incl. the pending-pair rule). */
export function memoryRepos() {
  const users = new Map(); // uid → doc
  const requests = [];
  const games = [];
  // Shallow copy with copied arrays/objects one level down (keeps ObjectId instances intact, unlike structuredClone).
  const clone = (x) => (x ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, Array.isArray(v) ? v.map((e) => (e && typeof e === 'object' && !(e instanceof ObjectId) ? { ...e } : e)) : v && typeof v === 'object' && !(v instanceof ObjectId) && !(v instanceof Date) ? { ...v } : v])) : null);

  const repos = {
    _users: users, _requests: requests, _games: games,
    async withTransaction(fn) { return fn(null); },
    users: {
      async upsertFromAuth({ uid, email, displayName, photoUrl }) {
        const now = new Date();
        const existing = users.get(uid);
        const doc = existing ?? { firebaseUid: uid, isOnline: false, lastSeenAt: now, friends: [], fcmTokens: [], settings: { emailInvites: true }, stats: { gamesPlayed: 0, wins: 0 }, createdAt: now };
        Object.assign(doc, { email: normalizeEmail(email), displayName: displayName || email.split('@')[0], photoUrl: photoUrl ?? null, updatedAt: now });
        users.set(uid, doc);
        return clone(doc);
      },
      async findByUid(uid) { return clone(users.get(uid)); },
      async findByEmail(email) { return clone([...users.values()].find((u) => u.email === normalizeEmail(email))); },
      async findManyByUids(uids) { return uids.map((u) => users.get(u)).filter(Boolean).map(clone); },
      async addFriendPair(a, b) {
        const ua = users.get(a); const ub = users.get(b);
        if (!ua.friends.includes(b)) ua.friends.push(b);
        if (!ub.friends.includes(a)) ub.friends.push(a);
      },
      async removeFriendPair(a, b) {
        users.get(a).friends = users.get(a).friends.filter((x) => x !== b);
        users.get(b).friends = users.get(b).friends.filter((x) => x !== a);
      },
      async setOnline(uid, isOnline) { const u = users.get(uid); if (u) Object.assign(u, { isOnline, lastSeenAt: new Date() }); },
      async resetAllOffline() { for (const u of users.values()) u.isOnline = false; },
      async addFcmToken(uid, token, platform = 'android') {
        const u = users.get(uid);
        u.fcmTokens = [{ token, platform, updatedAt: new Date() }, ...u.fcmTokens.filter((t) => t.token !== token)].slice(0, 5);
      },
      async removeFcmTokens(tokens) { for (const u of users.values()) u.fcmTokens = u.fcmTokens.filter((t) => !tokens.includes(t.token)); },
      async updateSettings(uid, settings) { const u = users.get(uid); u.settings = { ...u.settings, ...settings }; return clone(u); },
    },
    requests: {
      async findPendingForPair(a, b) { return clone(requests.find((r) => r.pairKey === pairKey(a, b) && r.status === 'pending')); },
      async create(fromUid, toUid) {
        const key = pairKey(fromUid, toUid);
        if (requests.some((r) => r.pairKey === key && r.status === 'pending')) throw Object.assign(new Error('dup'), { code: 11000 });
        const doc = { _id: new ObjectId(), fromUid, toUid, pairKey: key, status: 'pending', createdAt: new Date(), respondedAt: null, expiresAt: null };
        requests.push(doc);
        return clone(doc);
      },
      async findById(id) { return clone(requests.find((r) => r._id.toString() === id)); },
      async close(id, actorField, actorUid, status) {
        const r = requests.find((x) => x._id.toString() === id && x.status === 'pending' && x[actorField] === actorUid);
        if (!r) return null;
        Object.assign(r, { status, respondedAt: new Date() });
        return clone(r);
      },
      async listPending(field, uid) { return requests.filter((r) => r[field] === uid && r.status === 'pending').map(clone); },
    },
    games: {
      async recordFinished(game) {
        games.push(game);
        for (const p of game.players) {
          const u = users.get(p.uid);
          u.stats.gamesPlayed += 1;
          if (p.rank === 1) u.stats.wins += 1;
        }
      },
    },
  };
  return repos;
}
