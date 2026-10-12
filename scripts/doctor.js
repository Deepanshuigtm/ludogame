// Checks that everything the server needs is configured and reachable, without starting it.
// Usage: npm run doctor
import 'dotenv/config';
import os from 'node:os';
import admin from 'firebase-admin';
import { MongoClient } from 'mongodb';
import nodemailer from 'nodemailer';
import { loadServiceAccount } from '../src/auth/firebase.js';

const results = [];
const pass = (name, detail = '') => results.push({ ok: true, name, detail });
const fail = (name, detail) => results.push({ ok: false, name, detail });
const warn = (name, detail) => results.push({ ok: null, name, detail });

async function check(name, fn) {
  try {
    const detail = await fn();
    pass(name, detail ?? '');
  } catch (err) {
    fail(name, err?.message ?? String(err));
  }
}

// ---- 1. MongoDB Atlas
await check('MongoDB connection', async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in .env');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 12_000 });
  try {
    await client.connect();
    const db = client.db(process.env.MONGODB_DB ?? 'ludogame');
    await db.command({ ping: 1 });
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    const users = names.includes('users') ? await db.collection('users').estimatedDocumentCount() : 0;
    const missing = ['users', 'friend_requests', 'games'].filter((n) => !names.includes(n));
    if (missing.length) warn('MongoDB schema', `collections missing: ${missing.join(', ')} → run: npm run setup-db`);
    return `db "${db.databaseName}" reachable · ${users} user(s)`;
  } catch (err) {
    if (/querySrv|ENOTFOUND/.test(err.message)) throw new Error(`DNS lookup failed – check the cluster host / your internet. (${err.message})`);
    if (/auth/i.test(err.message)) throw new Error(`login rejected – check the username/password in MONGODB_URI (password must be URL-encoded, e.g. @ → %40). (${err.message})`);
    if (/Server selection timed out|ECONNREFUSED|timed out/i.test(err.message)) {
      throw new Error(`can't reach the cluster – in Atlas → Network Access, add this machine's IP (or 0.0.0.0/0 for testing). (${err.message})`);
    }
    throw err;
  } finally {
    await client.close().catch(() => {});
  }
});

// ---- 2. Firebase Admin (sign-in verification + push)
let app = null;
await check('Firebase service account', async () => {
  const sa = loadServiceAccount();
  if (!sa) throw new Error('no key found – copy the downloaded key to server/service-account.json (or set FIREBASE_SERVICE_ACCOUNT_BASE64)');
  const expected = process.env.FIREBASE_PROJECT_ID;
  if (expected && sa.project_id !== expected) throw new Error(`key is for project "${sa.project_id}" but FIREBASE_PROJECT_ID is "${expected}"`);
  app = admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
  // Exchanges the key for an OAuth token at Google: proves the key is valid and not revoked.
  await app.options.credential.getAccessToken();
  return `${sa.client_email} · Google accepted the key`;
});

if (app) {
  await check('Firebase Cloud Messaging', async () => {
    try {
      // Dry run to a dummy token: an "invalid token" answer means FCM itself accepted our credentials.
      await admin.messaging(app).send({ token: 'doctor-dummy-token', data: { t: 'ping' } }, true);
      return 'reachable';
    } catch (err) {
      const code = err?.errorInfo?.code ?? err?.code ?? '';
      if (/invalid-argument|registration-token-not-registered|invalid-registration-token/.test(code)) return 'reachable · credentials accepted';
      if (/third-party-auth-error|mismatched-credential|permission|PERMISSION_DENIED/i.test(code + err.message)) {
        throw new Error(`FCM refused the credentials – enable "Firebase Cloud Messaging API (V1)" in Google Cloud console for this project. (${code})`);
      }
      throw new Error(`${code} ${err.message}`);
    }
  });
}

// ---- 3. Email (optional)
if (process.env.SMTP_HOST) {
  await check('SMTP (invite emails)', async () => {
    const t = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
    });
    await t.verify();
    return `${process.env.SMTP_HOST} login OK`;
  });
} else {
  warn('SMTP (invite emails)', 'not configured – offline friends get push only. Set SMTP_* in .env to enable emails.');
}

// ---- Report
console.log('\nLudo Classic server – doctor\n');
for (const r of results) {
  const mark = r.ok === true ? '✅' : r.ok === false ? '❌' : '⚠️ ';
  console.log(`${mark} ${r.name}${r.detail ? ` – ${r.detail}` : ''}`);
}
const port = process.env.PORT ?? 8080;
const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
console.log(`\nPhone on the same Wi-Fi → put this in gradle.properties:`);
for (const ip of lan) console.log(`   ludo.serverUrl=http://${ip}:${port}`);
const failed = results.some((r) => r.ok === false);
console.log(failed ? '\nFix the ❌ items above, then run `npm start`.\n' : '\nAll good – run `npm run setup-db` (first time only), then `npm start`.\n');
process.exit(failed ? 1 : 0);
