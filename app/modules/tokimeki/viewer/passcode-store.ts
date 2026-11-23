// Session passcode memory for the web viewer.
//
// The passcode is only needed during the relay WebSocket handshake. Keeping it in
// sessionStorage means a refresh (or an in-page reconnect) in the same tab does
// not ask again, while a new tab / device still has to enter it. It never goes
// into localStorage or the URL.
const VALUE_PREFIX = "tokimeki:passcode:";
const NEEDED_PREFIX = "tokimeki:passcode-needed:";

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function read(key: string): string | null {
  const store = storage();
  if (store === null) return null;
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.setItem(key, value);
  } catch {
    // Private mode or quota exceeded: fall back to asking again.
  }
}

function remove(key: string): void {
  const store = storage();
  if (store === null) return;
  try {
    store.removeItem(key);
  } catch {
    // Ignore.
  }
}

export interface RememberedPasscode {
  readonly value: string | null;
  readonly needed: boolean;
}

export function readRememberedPasscode(code: string): RememberedPasscode {
  return {
    value: read(`${VALUE_PREFIX}${code}`),
    needed: read(`${NEEDED_PREFIX}${code}`) === "1",
  };
}

export function rememberPasscode(code: string, value: string): void {
  write(`${VALUE_PREFIX}${code}`, value);
  write(`${NEEDED_PREFIX}${code}`, "1");
}

/** Drop the remembered value but keep the "this session needs a passcode" flag. */
export function forgetPasscodeValue(code: string): void {
  remove(`${VALUE_PREFIX}${code}`);
}
