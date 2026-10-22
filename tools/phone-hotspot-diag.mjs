
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const socket = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); socket.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => socket.addEventListener('open', r, { once: true }));
const ev = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
console.log('health:', await ev(`fetch('http://192.168.137.1:8787/v1/health').then(r => r.text()).catch(e => 'ERR: ' + e.message)`));
socket.close();
