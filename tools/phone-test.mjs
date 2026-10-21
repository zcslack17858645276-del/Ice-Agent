// Phone test harness: drives the running Android WebView through CDP.
// Usage: node tools/phone-test.mjs "message text" [waitSeconds]
const message = process.argv[2] ?? 'ping';
const waitSeconds = Number(process.argv[3] ?? 10);

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((target) => target.type === 'page');
if (!page) {
  console.error('no page target; is the app running and adb forward set?');
  process.exit(1);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const consoleLines = [];

socket.addEventListener('message', (event) => {
  const payload = JSON.parse(event.data);
  if (payload.id && pending.has(payload.id)) {
    pending.get(payload.id)(payload);
    pending.delete(payload.id);
    return;
  }
  if (payload.method === 'Runtime.consoleAPICalled') {
    const args = (payload.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ');
    consoleLines.push(`[console:${payload.params.type}] ${args}`);
  }
  if (payload.method === 'Runtime.exceptionThrown') {
    consoleLines.push(`[exception] ${payload.params.exceptionDetails?.text ?? ''}`);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
await send('Runtime.enable');

const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return response.result?.result?.value;
};

const before = await evaluate('document.querySelectorAll(".row.user").length');
console.log('user messages before:', before);

await evaluate('document.querySelector("textarea")?.focus()');
await send('Input.insertText', { text: message });
await new Promise((resolve) => setTimeout(resolve, 400));
const typed = await evaluate('document.querySelector("textarea")?.value');
console.log('typed value:', typed);

await evaluate('document.querySelector("form.composer button[type=\\"submit\\"]")?.click()');
await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000));

const rows = await evaluate('document.querySelectorAll(".row.user").length');
const last = await evaluate('[...document.querySelectorAll(".row.assistant .bubble")].slice(-1)[0]?.innerText ?? ""');
const busy = await evaluate('document.body.innerText.includes("正在输入")');
console.log('user messages after:', rows);
console.log('still busy:', busy);
console.log('last assistant:', JSON.stringify(last).slice(0, 600));
if (consoleLines.length) console.log('console:', consoleLines.slice(-6).join('\n'));
socket.close();
