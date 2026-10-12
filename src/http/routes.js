import express from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { AppError, Errors, toClientError } from '../errors.js';
import { publicProfile } from '../db/repositories.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then((data) => res.json({ ok: true, data })).catch(next);
const parse = (schema, value) => {
  const r = schema.safeParse(value);
  if (!r.success) throw Errors.validation(r.error.issues[0]?.message ?? 'Invalid request');
  return r.data;
};

const emailSchema = z.string().trim().toLowerCase().email().max(320);

/** REST API (all routes require `Authorization: Bearer <Firebase ID token>`). */
export function createApiRouter({ auth, social, users, rooms }) {
  const r = express.Router();
  r.use(auth);
  const perUser = (max) => rateLimit({ windowMs: 60_000, max, keyGenerator: (req) => req.user.firebaseUid, standardHeaders: true, legacyHeaders: false, validate: false });

  // ---- me
  r.get('/me', wrap((req) => ({ ...publicProfile(req.user), email: req.user.email, settings: req.user.settings ?? { emailInvites: true }, stats: req.user.stats ?? {} })));
  r.patch('/me/settings', wrap(async (req) => {
    const body = parse(z.object({ emailInvites: z.boolean() }).partial(), req.body);
    const u = await users.updateSettings(req.user.firebaseUid, body);
    return u.settings;
  }));
  r.put('/me/fcm-token', perUser(20), wrap(async (req) => {
    const { token, platform } = parse(z.object({ token: z.string().min(20).max(4096), platform: z.enum(['android', 'ios', 'web']).default('android') }), req.body);
    await users.addFcmToken(req.user.firebaseUid, token, platform);
    return { ok: true };
  }));
  // Called on sign-out so this device stops receiving the previous account's invites.
  r.delete('/me/fcm-token', perUser(20), wrap(async (req) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(4096) }), req.body);
    await users.removeFcmTokens([token]);
    return { ok: true };
  }));

  // ---- social
  r.get('/users/search', perUser(30), wrap((req) => social.searchByEmail(req.user, parse(emailSchema, req.query.email))));
  r.get('/friends', wrap((req) => social.listFriends(req.user)));
  r.delete('/friends/:uid', wrap((req) => social.unfriend(req.user, parse(z.string().min(1).max(128), req.params.uid))));
  r.get('/friends/requests', wrap((req) => social.listRequests(req.user)));
  r.post('/friends/requests', perUser(30), wrap((req) => {
    const body = parse(z.object({ email: emailSchema.optional(), toUid: z.string().min(1).max(128).optional() }).refine((b) => b.email || b.toUid, 'email or toUid is required'), req.body);
    return social.sendRequest(req.user, body);
  }));
  r.post('/friends/requests/:id/accept', wrap((req) => social.accept(req.user, req.params.id)));
  r.post('/friends/requests/:id/decline', wrap((req) => social.decline(req.user, req.params.id)));
  r.delete('/friends/requests/:id', wrap((req) => social.cancel(req.user, req.params.id)));

  // ---- table the user is sitting at (for cold starts from a notification)
  r.get('/rooms/current', wrap((req) => rooms.snapshot(req.user.firebaseUid)));
  r.get('/invites', wrap((req) => rooms.pendingInvitesFor(req.user.firebaseUid)));

  return r;
}

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (!(err instanceof AppError)) logger?.error({ err, path: req.path }, 'request failed');
    if (err?.type === 'entity.parse.failed') return res.status(400).json({ ok: false, error: { code: 'VALIDATION', message: 'Malformed JSON' } });
    res.status(err instanceof AppError ? err.status : 500).json({ ok: false, error: toClientError(err) });
  };
}
