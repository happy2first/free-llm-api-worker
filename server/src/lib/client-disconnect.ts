import type { Response } from 'express';

/** Hosts with a Fetch transport can provide an authoritative cancellation
 * signal instead of relying on emulated Node socket close events. */
export function onClientDisconnect(res: Response, listener: () => void): void {
  const signal = res.locals.hostClientSignal as AbortSignal | undefined;
  if (!signal) {
    res.on('close', listener);
    return;
  }
  if (signal.aborted) listener();
  else signal.addEventListener('abort', listener, { once: true });
  res.once('finish', () => signal.removeEventListener('abort', listener));
}
