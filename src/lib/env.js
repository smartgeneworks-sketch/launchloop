import fs from 'node:fs';
import path from 'node:path';

/** Minimal .env loader (no dependency). Existing process.env values win. */
export function loadEnv(file = path.resolve(process.cwd(), '.env')) {
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!m || line.trim().startsWith('#')) continue;
      let v = m[2];
      if (/^".*"$|^'.*'$/.test(v)) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
  return config(process.env);
}

export function config(env) {
  return {
    port: Number(env.PORT || 3000),
    dataDir: env.DATA_DIR || './data',
    publicBaseUrl: env.PUBLIC_BASE_URL || `http://localhost:${env.PORT || 3000}`,
    appApiToken: env.APP_API_TOKEN || '',
    publishMode: env.PUBLISH_MODE === 'live' ? 'live' : 'mock',
    mockFailureRate: env.MOCK_FAILURE_RATE !== undefined ? Number(env.MOCK_FAILURE_RATE) : 0.1,
    simulateMetrics: env.SIMULATE_METRICS !== 'false',
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS || 15000),
    env,
  };
}
