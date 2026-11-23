// Pure invite-code shape shared by the worker and the SPA.
// Keep this module free of DB/server imports so the browser bundle can use it.
export const INVITE_CODE_LENGTH = 16;

/** 30-char readable alphabet (excludes 0/1/4 and i/l/o), ~78 bits at 16 chars. */
export const INVITE_CODE_PATTERN = /^[2356789abcdefghjkmnpqrstuvwxyz]{16}$/;

export function isValidInviteCode(value: string): boolean {
  return INVITE_CODE_PATTERN.test(value);
}
