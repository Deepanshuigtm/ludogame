import pino from 'pino';
import admin from 'firebase-admin';
import { loadConfig } from './config.js';
import { connectMongo, ensureSchema } from './db/mongo.js';
import { MongoRepositories } from './db/repositories.js';
import { initFirebase, createTokenVerifier } from './auth/firebase.js';
import { createApp } from './app.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', '*.token', '*.fcmTokens'] });

async function main() {
  const config = loadConfig();
  const firebase = initFirebase(config);
  const { client, db } = await connectMongo(config.mongoUri, config.mongoDb, logger);
  await ensureSchema(db, logger);
  const repos = new MongoRepositories(client, db);
  await repos.users.resetAllOffline(); // nobody is connected to a fresh process

  const server = createApp({ config, repos, verify: createTokenVerifier(firebase), messaging: admin.messaging(firebase), logger });
  server.httpServer.listen(config.port, '0.0.0.0', () => logger.info({ port: config.port }, 'Ludo backend listening'));

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 10_000).unref();
    try {
      await server.close();
      await repos.users.resetAllOffline();
      await client.close();
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err }, 'failed to start');
  process.exit(1);
});
