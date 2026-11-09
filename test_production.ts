import { spawn } from 'child_process';
import http from 'http';

function get(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function runDevOpsProductionTests() {
  console.log('🚀 Running Production & DevOps Integrity Tests...');
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✅ PASS: ${msg}`);
      passed++;
    } else {
      console.error(`  ❌ FAIL: ${msg}`);
      failed++;
    }
  }

  const TEST_PORT = 3008;
  const proc = spawn('node', ['dist/server/server.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(TEST_PORT),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let serverStarted = false;
  proc.stdout.on('data', (d) => {
    const text = d.toString();
    if (text.includes(`running on http://127.0.0.1:${TEST_PORT}`)) {
      serverStarted = true;
    }
  });

  proc.stderr.on('data', (d) => {
    console.error('Server stderr:', d.toString());
  });

  // Wait for server to boot up
  const startWait = Date.now();
  while (!serverStarted && Date.now() - startWait < 8000) {
    await new Promise((r) => setTimeout(r, 200));
  }

  assert(serverStarted, `Compiled server started in production mode on port ${TEST_PORT}`);

  try {
    // 1. Root route
    const root = await get(`http://127.0.0.1:${TEST_PORT}/`);
    assert(root.status === 200, 'Root / returns HTTP 200');
    assert(root.headers['content-type']?.includes('text/html') === true, 'Root Content-Type is text/html');
    assert(root.body.includes('<div id="root"></div>'), 'Root HTML contains root div');

    // 2. Client SPA route
    const spa = await get(`http://127.0.0.1:${TEST_PORT}/editor/proj_test`);
    assert(spa.status === 200, 'Client route /editor/proj_test returns HTTP 200 (SPA fallback)');
    assert(spa.body.includes('Khmersub Studio'), 'Client route serves index.html');

    // 3. API route requires auth and returns JSON
    const api = await get(`http://127.0.0.1:${TEST_PORT}/api/projects`);
    assert(api.status === 401, 'API /api/projects returns HTTP 401 Unauthorized');
    assert(api.headers['content-type']?.includes('application/json') === true, 'API response is application/json');

    // 4. Unmatched API route returns JSON 404
    const notFoundApi = await get(`http://127.0.0.1:${TEST_PORT}/api/non_existent_route`);
    assert(notFoundApi.status === 404, 'Unmatched /api/* route returns HTTP 404');
    assert(notFoundApi.headers['content-type']?.includes('application/json') === true, 'Unmatched API response is application/json (not HTML)');

    // 5. Test graceful shutdown
    console.log('\n--- Testing Graceful Shutdown (SIGTERM) ---');
    const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      proc.on('exit', (code, signal) => resolve({ code, signal }));
    });

    proc.kill('SIGTERM');

    const exitResult = await Promise.race([
      exitPromise,
      new Promise<null>((r) => setTimeout(() => r(null), 5000)),
    ]);

    assert(exitResult !== null, 'Server responded to SIGTERM within timeout');
    assert(exitResult?.code === 0, `Server exited with clean code 0 (got code ${exitResult?.code})`);

  } catch (err: any) {
    assert(false, `Test encountered error: ${err.message}`);
    proc.kill('SIGKILL');
  }

  console.log(`\n========================================`);
  console.log(`DevOps Test Results: ${passed} Passed, ${failed} Failed`);
  console.log(`========================================\n`);

  if (failed > 0) process.exit(1);
}

runDevOpsProductionTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
