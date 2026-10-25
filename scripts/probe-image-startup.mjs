// Stage 0 startup probe. Does not send a prompt or claim generation support.
import { CodexClient } from '../server/codex-client.mjs';
const client = new CodexClient({ profile: 'images' });
try {
  await client.start();
  const status = await client.status();
  console.log(
    JSON.stringify({ profile: 'images', connected: true, authenticated: status.available, generation: 'unverified' }),
  );
} catch (error) {
  const codes = ['RPC_ERROR', 'RPC_TIMEOUT', 'CODEX_STOPPED', 'INVALID_PROTOCOL'];
  console.log(
    JSON.stringify({
      profile: 'images',
      connected: false,
      generation: 'unverified',
      code: codes.includes(error.message) ? error.message : 'STARTUP_FAILED',
      method: error.method || null,
      rpcCode: error.rpcCode ?? null,
    }),
  );
  process.exitCode = 1;
} finally {
  await client.close();
}
