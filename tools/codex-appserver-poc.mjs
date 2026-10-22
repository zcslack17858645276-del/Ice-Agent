// PoC: drive `codex app-server` over JSON-RPC and prove that a command
// approval request can be received and answered.
//
//   node tools/codex-appserver-poc.mjs
import { spawn } from 'node:child_process';

const CODEX = 'D:\\nodejs\\node_global\\node_modules\\@openai\\codex\\bin\\codex.js';
const WORKSPACE = 'D:\\codex\\workspace';
const TIMEOUT_MS = 150000;

const child = spawn('node', [CODEX, 'app-server'], {
  cwd: WORKSPACE,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});

let nextId = 0;
const pending = new Map();
const log = (...args) => console.log('[poc]', ...args);

function write(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function send(method, params) {
  const id = ++nextId;
  write({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject, method }));
}

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  const lines = buffer.split('\n');
  buffer = lines.pop() ?? '';
  for (const line of lines) {
    const text = line.trim();
    if (!text) continue;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      continue;
    }

    if (message.id !== undefined && message.method === undefined) {
      const entry = pending.get(message.id);
      if (entry) {
        pending.delete(message.id);
        if (message.error) {
          entry.reject(new Error(`${entry.method}: ${JSON.stringify(message.error)}`));
        } else {
          entry.resolve(message.result);
        }
      }
      continue;
    }

    if (message.method && message.id !== undefined) {
      log('server request:', message.method);
      log('params:', JSON.stringify(message.params ?? {}).slice(0, 600));
      if (String(message.method).includes('requestApproval')) {
        const decision = process.env.POC_DECISION ?? 'accept';
        write({ jsonrpc: '2.0', id: message.id, result: { decision } });
        log(`answered ${message.method} with decision=${decision}`);
      } else {
        write({ jsonrpc: '2.0', id: message.id, result: {} });
      }
      continue;
    }

    if (message.method) {
      const summary = JSON.stringify(message.params ?? {}).slice(0, 200);
      log('notify:', message.method, summary);
      if (message.method === 'turn/completed') {
        log('TURN COMPLETED');
        finish(0);
      }
      if (
        message.method === 'thread/status/changed' &&
        message.params?.status?.type === 'idle' &&
        turnStarted
      ) {
        log('THREAD IDLE (turn finished)');
        finish(0);
      }
    }
  }
});

child.stderr.on('data', (chunk) => {
  const text = chunk.toString('utf8').trim();
  if (text) log('stderr:', text.slice(0, 240));
});

let finished = false;
let turnStarted = false;
function finish(code) {
  if (finished) return;
  finished = true;
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 200);
}

setTimeout(() => {
  log('TIMEOUT');
  finish(2);
}, TIMEOUT_MS);

try {
  await send('initialize', {
    clientInfo: { name: 'ice-agent-poc', title: 'Ice Agent PoC', version: '0.1.0' }
  });
  log('handshake ok');
  write({ jsonrpc: '2.0', method: 'initialized', params: {} });

  const thread = await send('thread/start', {
    cwd: WORKSPACE,
    approvalPolicy: 'on-request',
    sandbox: 'workspace-write'
  });
  const threadId = thread.threadId ?? thread.thread?.id ?? thread.id;
  log('thread:', threadId);

  await send('turn/start', {
    threadId,
    input: [
      {
        type: 'text',
        text: 'Use the shell tool to run exactly: cmd /c echo danger > C:\\Windows\\Temp\\codex-poc.txt. Do not do anything else.'
      }
    ]
  });
  turnStarted = true;
  log('turn started, waiting for approval request');
} catch (error) {
  log('ERROR:', error.message);
  finish(1);
}
