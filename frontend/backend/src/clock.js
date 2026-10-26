// Controllable test clock: the whole app reads time through now()/today(),
// so dev tools can shift time to exercise expiry, waiting and grace periods.
import { meta } from './db.js';

export const now = () => new Date(Date.now() + (meta().clockOffsetMs || 0));
export const today = () => now().toISOString().slice(0, 10);
