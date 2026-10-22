// Mobile feature test: sessions, long-press actions, dark theme, notifications permission.
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((target) => target.type === 'page');
if (!page) {
  console.error('no page');
  process.exit(1);
}
const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
socket.addEventListener('message', (event) => {
  const payload = JSON.parse(event.data);
  if (payload.id && pending.has(payload.id)) {
    pending.get(payload.id)(payload);
    pending.delete(payload.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const current = ++id;
    pending.set(current, resolve);
    socket.send(JSON.stringify({ id: current, method, params }));
  });
await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
await send('Runtime.enable');
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.result?.exceptionDetails) {
    return `EXCEPTION: ${response.result.exceptionDetails.text}`;
  }
  return response.result?.result?.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const step = process.argv[2] ?? 'all';

if (step === 'sessions' || step === 'all') {
  await evaluate('document.querySelector(".icon-button")?.click()');
  await wait(500);
  console.log('drawer open:', await evaluate('!!document.querySelector(".session-list")'));
  await evaluate('document.querySelector(".drawer-head .primary")?.click()');
  await wait(400);
  await evaluate('document.querySelector("textarea")?.focus()');
  await send('Input.insertText', { text: '第一条多会话测试' });
  await wait(300);
  await evaluate('document.querySelector("form.composer button[type=\\"submit\\"]")?.click()');
  await wait(9000);
  await evaluate('document.querySelector(".icon-button")?.click()');
  await wait(500);
  console.log(
    'sessions:',
    await evaluate('[...document.querySelectorAll(".session-row .session-main")].map((n) => n.innerText.replace("\\n"," | ")).slice(0,5)')
  );
  await evaluate('document.querySelector(".icon-button")?.click()');
  await wait(400);
}

if (step === 'theme' || step === 'all') {
  await evaluate('[...document.querySelectorAll(".icon-button")].slice(-1)[0]?.click()');
  await wait(500);
  await evaluate('document.querySelectorAll(".toggle-row input")[0]?.click()');
  await wait(300);
  await evaluate('[...document.querySelectorAll(".sheet-actions button")].slice(-1)[0]?.click()');
  await wait(600);
  console.log('theme:', await evaluate('document.documentElement.dataset.theme'));
}

if (step === 'longpress' || step === 'all') {
  const opened = await evaluate(`(() => {
    const bubble = document.querySelector('.row.assistant .bubble');
    if (!bubble) return false;
    const rect = bubble.getBoundingClientRect();
    bubble.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + 10, clientY: rect.top + 10 }));
    return true;
  })()`);
  await wait(700);
  console.log('longpress fired:', opened, 'action sheet:', await evaluate('!!document.querySelector(".action-card")'));
  await evaluate('[...document.querySelectorAll(".action-card button")].slice(-1)[0]?.click()');
  await wait(300);
}

socket.close();
