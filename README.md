# Ludo Classic – multiplayer backend

Node.js · Express · Socket.IO · MongoDB (native driver) · Firebase Admin (auth + FCM) · Nodemailer.

```
Android app ──HTTPS (REST, Firebase ID token)──▶ Express  /api/*      ─┐
            ──WebSocket (Socket.IO, ID token)──▶ realtime/sockets.js  ├─▶ MongoDB  ludogame.{users, friend_requests, games}
                                                 game/rooms.js        │
                                                 game/engine.js  (authoritative rules, same as the app's Kotlin engine)
                                                 services/notifier.js ─▶ FCM push + SMTP email for offline friends
```

## Run it

```bash
cd server
npm ci
cp ~/Downloads/voice-chat-56647-firebase-adminsdk-*.json service-account.json   # your Firebase key (git-ignored); .env already has MongoDB
npm run doctor              # checks MongoDB, the Firebase key, FCM and SMTP and prints the URL for your phone
npm run setup-db            # creates collections, JSON-schema validators and indexes in `ludogame`
npm start                   # http://localhost:8080/healthz
npm test                    # 8 tests: auth, friends, presence, invites (push + email), a full online game, engine parity
```

**Firebase service account** (required – verifies sign-ins and sends pushes): Firebase console → Project settings →
Service accounts → *Generate new private key*, then put `base64 -i key.json | tr -d '\n'` into `FIREBASE_SERVICE_ACCOUNT_BASE64`.

**MongoDB Atlas network access**: allow the IP of wherever the server runs (Atlas → Network Access).

**Phones must reach the server.** For local testing run it on your Mac and set `ludo.serverUrl=http://<your-Mac-LAN-IP>:8080`
in the app's `gradle.properties` (same Wi-Fi as the phone). For real players deploy the Docker image to any HTTPS host
(Render, Railway, Fly.io, Cloud Run) and set `ludo.serverUrl=https://your-host`.

## MongoDB design (`src/db/mongo.js`)

| Collection | Key fields | Indexes |
|---|---|---|
| `users` | `firebaseUid`, `email` (lower-case), `displayName`, `photoUrl`, `isOnline`, `lastSeenAt`, `friends[]` (uids), `fcmTokens[]`, `settings`, `stats` | unique `firebaseUid`, unique `email`, multikey `friends`, `fcmTokens.token` |
| `friend_requests` | `fromUid`, `toUid`, `pairKey`, `status` (pending/accepted/declined/cancelled), `createdAt`, `respondedAt`, `expiresAt` | **partial unique `pairKey` where status = pending** (one open request per pair, either direction), inbox/outbox, TTL purge of closed requests after 30 days |
| `games` | `roomId`, `players[{uid,name,color,rank}]`, `startedAt`, `finishedAt`, `turns` | unique `roomId`, `players.uid + finishedAt` |

Accepting a request updates the request **and both users' `friends` arrays in one transaction**. Sending a request to
someone who already asked you counts as accepting theirs. Search is exact-email only, so the user base can't be scraped,
and online status is only shown to friends.

## REST API (`Authorization: Bearer <Firebase ID token>`)

`GET /api/me` · `PATCH /api/me/settings` · `PUT` / `DELETE /api/me/fcm-token` · `GET /api/users/search?email=` ·
`GET /api/friends` · `DELETE /api/friends/:uid` · `GET /api/friends/requests` · `POST /api/friends/requests {email}` ·
`POST /api/friends/requests/:id/accept|decline` · `DELETE /api/friends/requests/:id` · `GET /api/invites` · `GET /api/rooms/current`

Responses: `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.

## Socket.IO protocol (`auth: { token }` in the handshake)

Client → server (every call takes an ack → `{ ok, data | error }`):
`lobby:create {friendUids≤3}` · `lobby:invite` · `invite:accept {roomId}` · `invite:decline` · `lobby:start` · `room:leave` ·
`game:roll {roomId}` · `game:move {roomId, tokenId}` · `room:sync`

Server → client: `presence:update` · `friend:request|accepted|declined|cancelled|removed` · `invite:received` ·
`invite:cancelled` · `lobby:update` · `lobby:closed` · `game:started` · `game:rolled` · `game:moved` · `room:seat` · `game:over`

The server owns the game: it rolls with a CSPRNG, validates every move with `engine.js`, and broadcasts the new state
with an increasing `seq`. Missed turns are auto-played after `TURN_TIMEOUT_SECONDS`; a disconnected player keeps their
seat for `RECONNECT_GRACE_SECONDS`, then the server plays for them until they're back. Online games use fair dice
(the app's "drama dice" director is for offline games only).

## Scaling past one instance

Presence and rooms live in process memory. For several instances: add `@socket.io/redis-adapter`, move
`Presence.sockets` and `RoomManager.rooms` to Redis, and pin a room to one instance (or use Redis locks).

## Deploy on Render

Everything Render needs is in the repo: `render.yaml` (Blueprint), `.node-version` (Node 22), `/healthz`, and a server that
binds `0.0.0.0:$PORT` and shuts down cleanly on `SIGTERM`.

1. **Push to GitHub.** Either the whole `LudoClassic` project (uses `LudoClassic/render.yaml`, `rootDir: server`) or only
   this `server` folder as its own repo (uses `server/render.yaml`). `.env`, `service-account*.json` and `node_modules`
   are git-ignored – never commit them.
2. **MongoDB Atlas → Network Access → Add IP → `0.0.0.0/0`.** Render's free plan has no fixed outbound IPs.
3. **Render → New → Blueprint →** pick the repo. Fill in the prompted secrets:
   - `MONGODB_URI` – your Atlas connection string (same as in `.env`).
   - `FIREBASE_SERVICE_ACCOUNT_BASE64` – run `base64 -i service-account.json | tr -d '\n' | pbcopy` and paste.
     (Or leave it empty and add a **Secret File** named `service-account.json`; it's read from `/etc/secrets/`.)
   - `SMTP_*` / `MAIL_FROM` – optional, for invite emails (Gmail: `smtp.gmail.com`, 465, an App Password).
4. Deploy. Check `https://<service>.onrender.com/healthz` → `{"ok":true}`. The logs show `MongoDB connected` and
   `Ludo backend listening`.
5. **Android app:** in `LudoClassic/gradle.properties` set `ludo.serverUrl=https://<service>.onrender.com`, rebuild.

Notes
- Keep **one instance**: lobbies and running games are held in memory. A redeploy/restart ends running games
  (players are returned to the home screen; friends, requests and stats are in MongoDB and survive).
- The **free plan sleeps** after ~15 minutes without traffic; the first request then takes ~30–60 s while it wakes.
  The app waits for it, but for real players use the Starter plan (always on).
- If the Atlas database user only has `readWrite`, schema validators can't be updated (needs `dbAdmin`); the server logs
  a warning and runs normally – indexes and data are unaffected.
