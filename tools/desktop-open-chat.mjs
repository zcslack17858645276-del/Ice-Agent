
const list = async () => (await (await fetch('http://127.0.0.1:9223/json')).json());
const targets = await list();
const pet = targets.find(t => t.type === 'page');
const socket = new WebSocket(pet.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); socket.send(JSON.stringify({ id: i, method, params })); });
await new Promise(r => socket.addEventListener('open', r, { once: true }));
await send('Runtime.enable');
const out = await send('Runtime.evaluate', { expression: `window.__TAURI_INTERNALS__.invoke('window:open_panel', { panel: 'chat' }).then(()=>'ok').catch(e=>'ERR '+JSON.stringify(e))`, returnByValue: true, awaitPromise: true });
console.log('result:', JSON.stringify(out.result?.result?.value));
socket.close();
await new Promise(r => setTimeout(r, 2000));
console.log('targets:', (await list()).map(t => t.title));
