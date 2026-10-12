/** A failure the client can act on: stable `code`, HTTP `status`, human `message`. */
export class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export const Errors = {
  unauthenticated: () => new AppError('UNAUTHENTICATED', 'Sign in again to continue.', 401),
  notFound: (what = 'Not found') => new AppError('NOT_FOUND', what, 404),
  validation: (msg) => new AppError('VALIDATION', msg, 400),
  userNotFound: () => new AppError('USER_NOT_FOUND', 'No player has signed up with that email yet.', 404),
  self: () => new AppError('CANNOT_ADD_SELF', "That's you!", 400),
  alreadyFriends: () => new AppError('ALREADY_FRIENDS', 'You are already friends.', 409),
  alreadyRequested: () => new AppError('REQUEST_ALREADY_SENT', 'A friend request is already pending.', 409),
  requestGone: () => new AppError('REQUEST_NOT_PENDING', 'This request is no longer pending.', 409),
  friendLimit: () => new AppError('FRIEND_LIMIT', 'Friend list is full.', 409),
  notFriends: () => new AppError('NOT_FRIENDS', 'You can only invite friends.', 403),
  roomNotFound: () => new AppError('ROOM_NOT_FOUND', 'That table no longer exists.', 404),
  roomFull: () => new AppError('ROOM_FULL', 'The table is full.', 409),
  inviteExpired: () => new AppError('INVITE_EXPIRED', 'This invite has expired.', 410),
  alreadyStarted: () => new AppError('ALREADY_STARTED', 'The game has already started.', 409),
  notHost: () => new AppError('NOT_HOST', 'Only the host can do that.', 403),
  notEnoughPlayers: () => new AppError('NOT_ENOUGH_PLAYERS', 'At least 2 players are needed.', 409),
  notYourTurn: () => new AppError('NOT_YOUR_TURN', "It's not your turn.", 409),
  illegalMove: () => new AppError('ILLEGAL_MOVE', 'That move is not allowed.', 409),
  tooManyInvites: () => new AppError('TOO_MANY_INVITES', 'You can invite up to 3 friends.', 400),
};

/** Shape sent to clients for both REST and socket acks. */
export const toClientError = (err) =>
  err instanceof AppError ? { code: err.code, message: err.message } : { code: 'INTERNAL', message: 'Something went wrong. Please try again.' };
