// Creates collections, JSON-schema validators and indexes in the `ludogame` database, then exits.
// Usage: npm run setup-db   (reads MONGODB_URI / MONGODB_DB from .env)
import 'dotenv/config';
import { connectMongo, ensureSchema, COLLECTIONS } from '../src/db/mongo.js';

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('Set MONGODB_URI in .env');
const { client, db } = await connectMongo(uri, process.env.MONGODB_DB ?? 'ludogame', console);
try {
  await ensureSchema(db, console);
  for (const name of Object.values(COLLECTIONS)) {
    const indexes = await db.collection(name).indexes();
    console.log(`${name}: ${indexes.map((i) => i.name).join(', ')}`);
  }
} finally {
  await client.close();
}
