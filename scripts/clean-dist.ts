/** Remove stale compiler output before emitting the publishable package. */

import { rmSync } from 'node:fs';
import { join } from 'node:path';

const dist = join(import.meta.dirname, '..', 'dist');
rmSync(dist, { recursive: true, force: true });
