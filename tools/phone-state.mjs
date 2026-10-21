// Prints lightweight app state over CDP (no interaction).
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
const evaluate = async (expression) => {
  const response = await send('Runtime.evaluate', { expression, returnByValue: true });
  return response.result?.result?.value;
};
console.log(
  JSON.stringify({
    sheet: await evaluate('!!document.querySelector(".sheet")'),
    userRows: await evaluate('document.querySelectorAll(".row.user").length'),
    lastAssistant: (await evaluate('[...document.querySelectorAll(".row.assistant .bubble")].slice(-1)[0]?.innerText ?? ""')).slice(0, 80)
  })
);
socket.close();
