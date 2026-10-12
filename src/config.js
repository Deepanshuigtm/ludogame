import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return v;
}

const int = (name, fallback) => {
  const v = process.env[name];
  const n = v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`${name} must be an integer`);
  return n;
};

/** All runtime configuration, read once at start-up. Secrets only ever come from the environment. */
export function loadConfig() {
  return {
    port: int('PORT', 8080),
    nodeEnv: process.env.NODE_ENV ?? 'development',
    corsOrigins: (process.env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),

    mongoUri: required('MONGODB_URI'),
    mongoDb: process.env.MONGODB_DB ?? 'ludogame',

    // Firebase Admin: a service-account JSON, base64-encoded (FIREBASE_SERVICE_ACCOUNT_BASE64) or a file path
    // (GOOGLE_APPLICATION_CREDENTIALS). Download it from Firebase console → Project settings → Service accounts.
    firebaseServiceAccountBase64: process.env.FIREBASE_SERVICE_ACCOUNT_BASE64 ?? null,
    firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? null,

    // Email (any SMTP provider: Gmail app password, SendGrid, Mailgun, SES SMTP…). Email is skipped if unset.
    smtp: process.env.SMTP_HOST
      ? {
          host: process.env.SMTP_HOST,
          port: int('SMTP_PORT', 587),
          secure: process.env.SMTP_SECURE === 'true',
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS,
        }
      : null,
    mailFrom: process.env.MAIL_FROM ?? 'Ludo Classic <no-reply@ludoclassic.app>',
    appDeepLink: process.env.APP_DEEP_LINK ?? 'https://play.google.com/store/apps/details?id=com.ludoclassic',

    inviteTtlMs: int('INVITE_TTL_SECONDS', 600) * 1000,
    turnTimeoutMs: int('TURN_TIMEOUT_SECONDS', 25) * 1000,
    reconnectGraceMs: int('RECONNECT_GRACE_SECONDS', 60) * 1000,
    maxFriends: int('MAX_FRIENDS', 500),
  };
}
