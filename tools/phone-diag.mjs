
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); socket.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => socket.addEventListener('open', r, { once: true }));
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await ev('document.querySelector(".icon-button[aria-label=\\"设置\\"]")?.click()');
await new Promise((r) => setTimeout(r, 700));
console.log(JSON.stringify({
  inputs: await ev('[...document.querySelectorAll(".sheet-card input:not([type=checkbox])")].map((el) => el.value)'),
  toggles: await ev('[...document.querySelectorAll(".toggle-row input[type=checkbox]")].map((el) => el.checked)'),
  toggleLabels: await ev('[...document.querySelectorAll(".toggle-row span")].map((el) => el.innerText)')
}, null, 2));
socket.close();
