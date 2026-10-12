import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createApp } from '../src/app.js';
import { memoryRepos } from './support/memoryRepos.js';
import { Errors } from '../src/errors.js';

/*
 * End-to-end over real HTTP + real Socket.IO connections, with:
 *   - in-memory repositories (MongoDB is swapped out),
 *   - a fake Firebase token verifier (token "tok-<uid>"),
 *   - fake FCM + fake SMTP transport that record what they were asked to send.
 */
const people = {
  asha: { uid: 'asha', email: 'Asha@Example.com', displayName: 'Asha', photoUrl: 'https://img/asha.png' },
  ben: { uid: 'ben', email: 'ben@example.com', displayName: 'Ben', photoUrl: 'https://img/ben.png' },
  chen: { uid: 'chen', email: 'chen@example.com', displayName: 'Chen', photoUrl: null },
  dev: { uid: 'dev', email: 'dev@example.com', displayName: 'Dev', photoUrl: null },
};
const verify = async (token) => {
  const p = people[String(token ?? '').replace('tok-', '')];
  if (!p) throw Errors.unauthenticated();
  return p;
};

let server; let base; let repos;
const pushes = []; const emails = [];
const messaging = {
  async sendEachForMulticast(msg) {
    pushes.push(msg);
    return { successCount: msg.tokens.filter((t) => t !== 'dead-token-000000000000').length, responses: msg.tokens.map((t) => (t === 'dead-token-000000000000' ? { success: false, error: { code: 'messaging/registration-token-not-registered' } } : { success: true })) };
  },
};
const mailTransport = { async sendMail(m) { emails.push(m); } };
const sockets = [];

const config = {
  corsOrigins: [], maxFriends: 500, inviteTtlMs: 60_000, turnTimeoutMs: 60_000, reconnectGraceMs: 150,
  mailFrom: 'Ludo <no-reply@test>', appDeepLink: 'https://example.com/app', smtp: null, socketRatePerSecond: 100_000,
};

let dice = 0;
const rng = () => [6, 6, 3, 5, 1, 6, 2, 4, 6, 3, 1, 5, 4, 2, 6][dice++ % 15];

before(async () => {
  repos = memoryRepos();
  server = createApp({ config, repos, verify, messaging, mailTransport, rng, offlineGraceMs: 80 });
  await new Promise((r) => server.httpServer.listen(0, r));
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  sockets.forEach((s) => s.close());
  await server.close();
});

async function api(who, method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: { authorization: `Bearer tok-${who}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, ...(await res.json()) };
}

function socketFor(who) {
  return new Promise((resolve, reject) => {
    const s = connect(base, { auth: { token: `tok-${who}` }, transports: ['websocket'], reconnection: false });
    s.events = [];
    s.onAny((event, payload) => s.events.push({ event, payload }));
    s.once('connect', () => { sockets.push(s); resolve(s); });
    s.once('connect_error', reject);
  });
}

const call = (s, event, payload) => new Promise((resolve) => s.emit(event, payload, resolve));
const waitFor = (s, event, pred = () => true, ms = 3000) => new Promise((resolve, reject) => {
  const found = s.events.find((e) => e.event === event && pred(e.payload));
  if (found) return resolve(found.payload);
  const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
  const h = (ev, payload) => { if (ev === event && pred(payload)) { clearTimeout(timer); s.offAny(h); resolve(payload); } };
  s.onAny(h);
});

test('rejects unauthenticated requests and sockets', async () => {
  const res = await fetch(`${base}/api/me`);
  assert.equal(res.status, 401);
  await assert.rejects(socketFor('nobody'));
});

test('friend requests: search by email, send, accept, live presence', async () => {
  const [asha, ben] = [await socketFor('asha'), await socketFor('ben')];
  await api('chen', 'GET', '/me'); // chen signs up but stays offline
  await api('dev', 'GET', '/me');

  const search = await api('asha', 'GET', '/users/search?email=BEN@example.com');
  assert.equal(search.data.relationship, 'none');
  assert.equal(search.data.displayName, 'Ben');
  assert.equal(search.data.isOnline, false, 'online status hidden from non-friends');
  assert.equal((await api('asha', 'GET', '/users/search?email=nobody@example.com')).error.code, 'USER_NOT_FOUND');
  assert.equal((await api('asha', 'POST', '/friends/requests', { email: 'asha@example.com' })).error.code, 'CANNOT_ADD_SELF');

  const sent = await api('asha', 'POST', '/friends/requests', { email: 'ben@example.com' });
  assert.equal(sent.data.status, 'pending');
  assert.equal((await api('asha', 'POST', '/friends/requests', { email: 'ben@example.com' })).error.code, 'REQUEST_ALREADY_SENT');
  const live = await waitFor(ben, 'friend:request');
  assert.equal(live.user.displayName, 'Asha');

  const inbox = await api('ben', 'GET', '/friends/requests');
  assert.equal(inbox.data.incoming.length, 1);
  assert.equal((await api('asha', 'POST', `/friends/requests/${inbox.data.incoming[0].id}/accept`)).error.code, 'REQUEST_NOT_PENDING', 'only the receiver can accept');
  const accepted = await api('ben', 'POST', `/friends/requests/${inbox.data.incoming[0].id}/accept`);
  assert.equal(accepted.data.uid, 'asha');
  await waitFor(asha, 'friend:accepted');

  const friends = await api('asha', 'GET', '/friends');
  assert.deepEqual(friends.data.map((f) => [f.uid, f.isOnline]), [['ben', true]]);
  assert.deepEqual(repos._users.get('ben').friends, ['asha']);

  // Reverse request auto-accepts.
  await api('chen', 'POST', '/friends/requests', { email: 'asha@example.com' });
  const back = await api('asha', 'POST', '/friends/requests', { toUid: 'chen' });
  assert.equal(back.data.status, 'accepted');
  assert.ok(repos._users.get('chen').friends.includes('asha'));

  // Decline
  await api('dev', 'POST', '/friends/requests', { email: 'asha@example.com' });
  const req = (await api('asha', 'GET', '/friends/requests')).data.incoming[0];
  assert.equal((await api('asha', 'POST', `/friends/requests/${req.id}/decline`)).ok, true);
  assert.equal((await api('asha', 'GET', '/friends/requests')).data.incoming.length, 0);
});

test('offline friend invite → FCM push + email; online friend → live invite; lobby broadcasts players', async () => {
  const asha = sockets.find((s) => s.auth.token === 'tok-asha');
  const ben = sockets.find((s) => s.auth.token === 'tok-ben');
  await api('chen', 'PUT', '/me/fcm-token', { token: 'chen-device-token-0123456789' });
  await repos.users.addFcmToken('chen', 'dead-token-000000000000');

  assert.equal((await call(asha, 'lobby:create', { friendUids: ['dev'] })).error.code, 'NOT_FRIENDS');
  const created = await call(asha, 'lobby:create', { friendUids: ['ben', 'chen'] });
  assert.equal(created.ok, true);
  const roomId = created.data.roomId;

  const invite = await waitFor(ben, 'invite:received');
  assert.equal(invite.host.name, 'Asha');
  assert.equal(invite.host.photoUrl, 'https://img/asha.png');

  // chen is offline: push + email were sent, and the dead token was cleaned up.
  await new Promise((r) => setTimeout(r, 50));
  const push = pushes.find((p) => p.data?.type === 'GAME_INVITE');
  assert.ok(push, 'push sent');
  assert.equal(push.data.roomId, roomId);
  assert.ok(push.tokens.includes('chen-device-token-0123456789'));
  assert.deepEqual(repos._users.get('chen').fcmTokens.map((t) => t.token), ['chen-device-token-0123456789']);
  assert.equal(emails.length, 1);
  assert.equal(emails[0].to, 'chen@example.com');
  assert.match(emails[0].subject, /Asha challenged you/);

  const joined = await call(ben, 'invite:accept', { roomId });
  assert.equal(joined.ok, true);
  const update = await waitFor(asha, 'lobby:update', (l) => l.players.length === 2);
  assert.deepEqual(update.players.map((p) => [p.name, p.photoUrl, p.isHost]), [['Asha', 'https://img/asha.png', true], ['Ben', 'https://img/ben.png', false]]);
  assert.equal(update.invites.find((i) => i.uid === 'chen').delivery, 'push');

  assert.equal((await call(ben, 'lobby:start', { roomId })).error.code, 'NOT_HOST');
  assert.equal((await call(asha, 'lobby:start', { roomId })).ok, true);
  const started = await waitFor(ben, 'game:started');
  assert.deepEqual(started.seats.map((s) => [s.uid, s.color]), [['asha', 'BLUE'], ['ben', 'GREEN']]);

  // Play the whole game through the server, each client acting only on its own turn.
  const seatOf = Object.fromEntries(started.seats.map((s) => [s.color, s.uid]));
  const clients = { asha, ben };
  let lastSeq = started.seq;
  let state = started.state;
  let wrongTurnChecked = false;
  let over = null;
  ben.on('game:over', (p) => { over = p; });
  const act = async () => {
    while (!over) {
      const color = state.players[state.currentPlayerIndex].color;
      const me = clients[seatOf[color]];
      const other = me === asha ? ben : asha;
      if (!wrongTurnChecked) {
        assert.equal((await call(other, 'game:roll', { roomId })).error.code, 'NOT_YOUR_TURN');
        wrongTurnChecked = true;
      }
      const res = state.phase === 'ROLL'
        ? await call(me, 'game:roll', { roomId })
        : await call(me, 'game:move', { roomId, tokenId: state.legalMoves[0].tokenId });
      assert.equal(res.ok, true, JSON.stringify(res.error));
      const next = await waitFor(ben, state.phase === 'ROLL' ? 'game:rolled' : 'game:moved', (p) => p.seq === lastSeq + 1);
      assert.equal(next.seq, lastSeq + 1, 'events arrive in order');
      lastSeq = next.seq;
      state = next.state;
      if (state.phase === 'GAME_OVER') break;
    }
  };
  await act();
  const result = over ?? await waitFor(ben, 'game:over');
  assert.equal(result.ranking.length, 2);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(repos._games.length, 1);
  assert.equal(repos._users.get(result.ranking[0].uid).stats.wins, 1);
});

test('presence: a friend going offline is pushed to their friends', async () => {
  const asha = sockets.find((s) => s.auth.token === 'tok-asha');
  const ben = sockets.find((s) => s.auth.token === 'tok-ben');
  ben.close();
  const update = await waitFor(asha, 'presence:update', (p) => p.uid === 'ben' && p.isOnline === false);
  assert.equal(update.isOnline, false);
  assert.equal(repos._users.get('ben').isOnline, false);
});

test('an offline friend sees the invite when they open the app later (REST + on socket connect)', async () => {
  const asha = sockets.find((s) => s.auth.token === 'tok-asha');
  const created = await call(asha, 'lobby:create', { friendUids: ['chen'] });
  assert.equal(created.ok, true);
  const roomId = created.data.roomId;

  const pending = await api('chen', 'GET', '/invites');
  assert.equal(pending.data.length, 1);
  assert.equal(pending.data[0].roomId, roomId);
  assert.equal(pending.data[0].host.name, 'Asha');

  const chen = await socketFor('chen');
  const delivered = await waitFor(chen, 'invite:received', (i) => i.roomId === roomId);
  assert.equal(delivered.host.uid, 'asha');
  assert.equal((await call(chen, 'invite:accept', { roomId })).ok, true);
  const lobby = await waitFor(asha, 'lobby:update', (l) => l.roomId === roomId && l.players.length === 2);
  assert.deepEqual(lobby.players.map((p) => p.name), ['Asha', 'Chen']);
  assert.equal((await api('chen', 'GET', '/invites')).data.length, 0, 'accepted invite is no longer pending');
});
