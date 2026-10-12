import nodemailer from 'nodemailer';

const DEAD_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * Reaches players who are NOT connected: Firebase Cloud Messaging to every registered device, plus an email.
 *
 * - `messaging` is firebase-admin's Messaging (injected so tests can fake it).
 * - Tokens FCM reports as dead are removed from the user document.
 * - Email is rate-limited per (sender, receiver) pair so a host can't spam someone's inbox, and respects
 *   the receiver's `settings.emailInvites`.
 */
export class Notifier {
  constructor({ messaging, users, config, logger, transport }) {
    this.messaging = messaging;
    this.users = users;
    this.config = config;
    this.log = logger;
    this.mailer = transport ?? (config.smtp
      ? nodemailer.createTransport({
          host: config.smtp.host,
          port: config.smtp.port,
          secure: config.smtp.secure,
          auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
          pool: true,
        })
      : null);
    this.lastEmailAt = new Map(); // "fromUid|toUid" → ms
  }

  /** Offline game invite → push + email. Resolves to what was delivered; never throws. */
  async gameInvite(toUser, fromUser, room) {
    const [push, email] = await Promise.allSettled([this.pushGameInvite(toUser, fromUser, room), this.emailGameInvite(toUser, fromUser, room)]);
    const result = { push: push.status === 'fulfilled' ? push.value : 0, email: email.status === 'fulfilled' && email.value === true };
    if (push.status === 'rejected') this.log?.warn({ err: push.reason }, 'invite push failed');
    if (email.status === 'rejected') this.log?.warn({ err: email.reason }, 'invite email failed');
    return result;
  }

  async pushGameInvite(toUser, fromUser, room) {
    return this.send(toUser, {
      notification: { title: `${fromUser.displayName} challenged you to Ludo!`, body: 'Tap to join the table before the invite expires.' },
      data: {
        type: 'GAME_INVITE',
        roomId: room.id,
        hostUid: fromUser.firebaseUid,
        hostName: fromUser.displayName,
        hostPhotoUrl: fromUser.photoUrl ?? '',
        expiresAt: String(room.inviteExpiresAt ?? ''),
      },
      android: {
        priority: 'high',
        ttl: this.config.inviteTtlMs,
        collapseKey: `invite_${room.id}`,
        notification: { channelId: 'game_invites', tag: `invite_${room.id}`, clickAction: 'OPEN_GAME_INVITE' },
      },
    });
  }

  async friendRequest(toUser, fromUser) {
    return this.send(toUser, {
      notification: { title: 'New friend request', body: `${fromUser.displayName} wants to be your Ludo friend.` },
      data: { type: 'FRIEND_REQUEST', fromUid: fromUser.firebaseUid, fromName: fromUser.displayName },
      android: { priority: 'normal', notification: { channelId: 'social', tag: `fr_${fromUser.firebaseUid}` } },
    });
  }

  /** Sends to every device of the user; returns the number of successful deliveries. */
  async send(toUser, message) {
    const tokens = (toUser.fcmTokens ?? []).map((t) => t.token).filter(Boolean);
    if (!this.messaging || tokens.length === 0) return 0;
    const res = await this.messaging.sendEachForMulticast({ ...message, tokens });
    const dead = [];
    res.responses.forEach((r, i) => {
      if (!r.success && DEAD_TOKEN_CODES.has(r.error?.code)) dead.push(tokens[i]);
    });
    if (dead.length) await this.users.removeFcmTokens(dead);
    return res.successCount;
  }

  async emailGameInvite(toUser, fromUser, room) {
    if (!this.mailer || !toUser.email || toUser.settings?.emailInvites === false) return false;
    const key = `${fromUser.firebaseUid}|${toUser.firebaseUid}`;
    const now = Date.now();
    if (now - (this.lastEmailAt.get(key) ?? 0) < 15 * 60_000) return false;
    this.lastEmailAt.set(key, now);

    const host = escapeHtml(fromUser.displayName);
    const name = escapeHtml(toUser.displayName);
    const minutes = Math.round(this.config.inviteTtlMs / 60_000);
    const link = escapeHtml(`${this.config.appDeepLink}${this.config.appDeepLink.includes('?') ? '&' : '?'}invite=${encodeURIComponent(room.id)}`);
    await this.mailer.sendMail({
      from: this.config.mailFrom,
      to: toUser.email,
      subject: `${fromUser.displayName} challenged you to a game of Ludo`,
      text: `Hi ${toUser.displayName},\n\n${fromUser.displayName} has saved you a seat at their Ludo table. Open Ludo Classic within ${minutes} minutes to join.\n\n${this.config.appDeepLink}\n\nYou can turn off invite emails in the app settings.`,
      html: `<!doctype html><html><body style="margin:0;background:#0A1F17;font-family:-apple-system,Segoe UI,Roboto,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;background:#4A2D1E;border:2px solid #C59A3E;border-radius:18px;padding:28px">
<tr><td style="color:#EBD089;font-size:13px;letter-spacing:2px;font-weight:800">LUDO CLASSIC</td></tr>
<tr><td style="color:#EFE9DC;font-size:24px;font-weight:800;padding:12px 0 6px">You've been challenged, ${name}!</td></tr>
<tr><td style="color:#EFE9DC;font-size:16px;line-height:1.5;padding-bottom:22px"><b>${host}</b> has saved you a seat at their table. The invite is open for ${minutes} minutes.</td></tr>
<tr><td><a href="${link}" style="display:inline-block;background:#EBD089;color:#231510;text-decoration:none;font-weight:900;padding:14px 26px;border-radius:12px;letter-spacing:1px">JOIN THE GAME</a></td></tr>
<tr><td style="color:#B9A88A;font-size:12px;padding-top:24px">You get this because ${host} is your friend on Ludo Classic. Turn off invite emails in Settings.</td></tr>
</table></td></tr></table></body></html>`,
    });
    return true;
  }
}
