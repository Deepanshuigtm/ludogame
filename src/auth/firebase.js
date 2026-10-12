import fs from 'node:fs';
import path from 'node:path';
import admin from 'firebase-admin';
import { Errors } from '../errors.js';

/**
 * Firebase Admin (token verification + FCM). Credentials: FIREBASE_SERVICE_ACCOUNT_BASE64 (base64 of the service
 * account JSON) or the standard GOOGLE_APPLICATION_CREDENTIALS file path.
 */
export function initFirebase(config) {
  if (admin.apps.length) return admin.app();
  const serviceAccount = loadServiceAccount(config.firebaseServiceAccountBase64);
  if (!serviceAccount && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    throw new Error('Firebase Admin credentials missing: put the key at server/service-account.json or set FIREBASE_SERVICE_ACCOUNT_BASE64 (see .env.example).');
  }
  const credential = serviceAccount ? admin.credential.cert(serviceAccount) : admin.credential.applicationDefault();
  return admin.initializeApp({ credential, projectId: config.firebaseProjectId ?? serviceAccount?.project_id ?? undefined });
}

/**
 * The service-account JSON, from FIREBASE_SERVICE_ACCOUNT_BASE64 (containers / hosting) or, for local runs, the file
 * FIREBASE_SERVICE_ACCOUNT_FILE (default `service-account.json` in the server folder – git-ignored).
 */
export function loadServiceAccount(base64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
  if (base64) return JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  // Explicit path, else ./service-account.json (local runs), else Render's Secret Files location.
  const candidates = process.env.FIREBASE_SERVICE_ACCOUNT_FILE
    ? [process.env.FIREBASE_SERVICE_ACCOUNT_FILE]
    : ['service-account.json', '/etc/secrets/service-account.json'];
  const file = candidates.map((f) => path.resolve(f)).find((f) => fs.existsSync(f));
  return file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * Verifies a Firebase ID token from the Android app. Returns the identity fields we store.
 * Only Google sign-in accounts with a verified email are accepted (friend search is by email).
 */
export function createTokenVerifier(app) {
  const auth = admin.auth(app);
  return async function verify(idToken) {
    if (!idToken || typeof idToken !== 'string') throw Errors.unauthenticated();
    let decoded;
    try {
      decoded = await auth.verifyIdToken(idToken);
    } catch {
      throw Errors.unauthenticated();
    }
    if (!decoded.email || decoded.email_verified === false) throw Errors.unauthenticated();
    return { uid: decoded.uid, email: decoded.email, displayName: decoded.name ?? null, photoUrl: decoded.picture ?? null };
  };
}

/** Express middleware: `Authorization: Bearer <Firebase ID token>` → req.user (the MongoDB user document). */
export function httpAuth(verify, users) {
  const cache = new Map(); // uid → { user, at } — avoids a write per request; refreshed every 5 minutes
  return async (req, res, next) => {
    try {
      const header = req.get('authorization') ?? '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : null;
      const identity = await verify(token);
      const hit = cache.get(identity.uid);
      if (hit && Date.now() - hit.at < 5 * 60_000) {
        req.user = await users.findByUid(identity.uid) ?? hit.user;
      } else {
        req.user = await users.upsertFromAuth(identity);
        cache.set(identity.uid, { user: req.user, at: Date.now() });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
