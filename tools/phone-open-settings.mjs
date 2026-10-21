// Verifies the Android back button closes the settings sheet instead of exiting.
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
  return response.result?.result?.value;
};
await evaluate('document.querySelector(".icon-button")?.click()');
await new Promise((resolve) => setTimeout(resolve, 600));
console.log('sheet open:', await evaluate('!!document.querySelector(".sheet")'));
socket.close();
