// Configure the phone app to use the PC server (via adb reverse) and send a test message.
const serverUrl = process.argv[2] ?? 'http://127.0.0.1:8787';
const token = process.argv[3] ?? '';
const message = process.argv[4] ?? '服务器联通测试：说一句你好';

const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((target) => target.type === 'page');
if (!page) {
  console.error('no page target');
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
  if (response.result?.exceptionDetails) return `EXC: ${response.result.exceptionDetails.text}`;
  return response.result?.result?.value;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const setInput = async (index, value) =>
  evaluate(`(() => {
    const el = document.querySelectorAll('.sheet-card input[type="text"], .sheet-card input:not([type]), .sheet-card input[type="password"]')[${index}];
    if (!el) return 'missing';
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);

await evaluate('document.querySelector(".icon-button[aria-label=\\"设置\\"]")?.click()');
await wait(600);
console.log('settings open:', await evaluate('!!document.querySelector(".sheet-card")'));

// fields: 0 apiKey, 1 model, 2 baseUrl, 3 serverUrl, 4 serverToken, 5 persona(textarea)
console.log('clear key:', await setInput(0, ''));
console.log('server url:', await setInput(3, serverUrl));
console.log('token:', await setInput(4, token));
console.log('server toggle:', await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.toggle-row')];
  const row = rows.find((item) => item.innerText.includes('PC 服务器'));
  const input = row?.querySelector('input[type="checkbox"]');
  if (!input) return 'missing';
  if (!input.checked) input.click();
  return input.checked;
})()`));
await wait(300);
await evaluate('[...document.querySelectorAll(".sheet-actions button")].slice(-1)[0]?.click()');
await wait(700);
console.log('settings closed:', !(await evaluate('!!document.querySelector(".sheet-card")')));

await evaluate('document.querySelector("textarea")?.focus(); document.querySelector("textarea")?.select();');
await send('Input.insertText', { text: message });
await wait(300);
console.log('typed:', await evaluate('document.querySelector("textarea")?.value'));
await evaluate('document.querySelector("form.composer button[type=\\"submit\\"]")?.click()');
await wait(12000);
console.log('last message:', JSON.stringify(await evaluate('[...document.querySelectorAll(".row.assistant .bubble")].slice(-1)[0]?.innerText ?? ""')).slice(0, 400));
console.log('error text:', await evaluate('document.querySelector(".error")?.innerText ?? ""'));
socket.close();
