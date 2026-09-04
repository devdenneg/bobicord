import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const filename = fileURLToPath(new URL('./Auth.tsx', import.meta.url));
const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function textOf(node) {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props?.children);
}

function find(tree, predicate) {
  if (!tree || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (const child of tree) { const result = find(child, predicate); if (result) return result; }
    return null;
  }
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
}

// Run the production component with persistent state/ref hooks and inert effects. JSX remains
// an inspectable tree, so handlers are called directly before rerender instead of relying on the
// browser's disabled attribute to hide duplicate-submit races. No auth-handler code is copied.
function harness(options = {}) {
  let hookIndex = 0, tree, token = options.token ?? null;
  const hooks = [], requests = [], accepted = [], tokenWrites = [];
  const values = new Map(Object.entries(options.storage || {}));
  const react = {
    useState(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial;
      return [hooks[index], (next) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }];
    },
    useRef(initial) {
      const index = hookIndex++;
      if (!(index in hooks)) hooks[index] = { current: initial };
      return hooks[index];
    },
    useMemo(make) { hookIndex++; return make(); },
    useEffect() { hookIndex++; },
  };
  class ApiError extends Error {
    constructor(message, options = {}) { super(message); this.status = 0; Object.assign(this, options); }
  }
  const api = new Proxy({}, {
    get(_, method) {
      return (...args) => { const pending = deferred(); requests.push({ ...pending, method, args }); return pending.promise; };
    },
  });
  const state = {
    sessionError: options.sessionError || '', passwordResetToken: null,
    acceptSession: async (...args) => { accepted.push(args); await options.acceptSession?.(...args); },
    setPasswordResetToken(value) { state.passwordResetToken = value; },
  };
  const useStore = (selector) => selector(state);
  useStore.getState = () => state;
  useStore.setState = (patch) => Object.assign(state, patch);
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react, 'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: 'fragment' },
    '../api': {
      api, ApiError, isApiError: (error) => error instanceof ApiError,
      getToken: () => token, setToken: (value) => { tokenWrites.push(value); token = value; },
    },
    '../store': { useStore }, '../Icon': { Icon: () => null }, './LogoLoader': { LogoLoader: () => null },
  };
  const exports = {};
  runInNewContext(compiled, {
    exports, Error, console,
    sessionStorage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) },
    requestAnimationFrame: (cb) => cb(), document: { getElementById: () => null },
    require(id) { if (!(id in imports)) throw new Error(`Unexpected import: ${id}`); return imports[id]; },
  }, { filename });
  const render = () => { hookIndex = 0; tree = exports.Auth(); return tree; };
  const button = (label) => {
    const result = find(tree, (node) => node.type === 'button' && textOf(node) === label);
    assert.ok(result, `Missing button ${label}`);
    return result;
  };
  render();
  return {
    render, button, requests, accepted, tokenWrites, state,
    token: () => token, setToken: (value) => { token = value; },
    error: (message, status = 0) => new ApiError(message, { status }),
    form: () => { const form = find(tree, (node) => node.type === 'form'); assert.ok(form, 'Missing form'); return form; },
    title: () => textOf(find(tree, (node) => node.props?.id === 'auth-title')),
    busy: () => find(tree, (node) => node.type === 'section').props['aria-busy'] === true,
    text: () => textOf(tree),
    input(id, value) {
      const input = find(tree, (node) => node.props?.id === id);
      assert.ok(input, `Missing input ${id}`);
      input.props.onChange(input.type === 'input' ? { target: { value } } : value);
      render();
    },
  };
}

const event = () => ({ preventDefault() {} });
const response = () => ({ token: 'new-token', user: { id: 'alice', username: 'alice' }, account: { state: 'ready' } });

function fillLogin(h) {
  h.input('auth-login-user', 'alice');
  h.input('auth-login-password', 'long-test-password');
}

test('two login submits before rerender issue exactly one credential request', async () => {
  const h = harness();
  fillLogin(h);
  const submit = h.form().props.onSubmit;
  const first = submit(event());
  await submit(event());
  assert.equal(h.requests.length, 1);
  h.render();
  assert.equal(h.busy(), true);
  assert.equal(h.button('Войти').props.disabled, true);
  h.requests[0].resolve(response());
  await first;
  assert.equal(h.accepted.length, 1);
  assert.deepEqual(h.tokenWrites, ['new-token']);
});

test('first transport error releases the lock and a manual second login can succeed', async () => {
  const h = harness();
  fillLogin(h);
  const first = h.form().props.onSubmit(event());
  h.requests[0].reject(h.error('Сервер не ответил вовремя'));
  await first;
  h.render();
  assert.equal(h.busy(), false);
  assert.match(h.text(), /Сервер не ответил вовремя/);
  assert.equal(h.requests.length, 1, 'No automatic password replay');
  const second = h.form().props.onSubmit(event());
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve(response());
  await second;
  assert.equal(h.accepted.length, 1);
  assert.equal(h.token(), 'new-token');
});

test('the lock spans account hydration after the login endpoint has completed', async () => {
  const hydration = deferred();
  const h = harness({ acceptSession: () => hydration.promise });
  fillLogin(h);
  const submit = h.form().props.onSubmit;
  const first = submit(event());
  h.requests[0].resolve(response());
  await Promise.resolve();
  await Promise.resolve();
  await submit(event());
  assert.equal(h.requests.length, 1);
  h.render();
  assert.equal(h.busy(), true);
  hydration.resolve();
  await first;
  h.render();
  assert.equal(h.busy(), false);
});

for (const cleared of [false, true]) {
  test(`failed accepted-session hydration selects ${cleared ? 'login when its token was cleared' : 'session retry while the token is retained'}`, async () => {
    const h = harness({ acceptSession: async () => {
      if (cleared) h.setToken(null);
      throw h.error('Не удалось загрузить аккаунт', cleared ? 401 : 0);
    } });
    fillLogin(h);
    const first = h.form().props.onSubmit(event());
    h.requests[0].resolve(response());
    await first;
    h.render();
    assert.equal(h.title(), cleared ? 'С возвращением' : 'Нет связи с сервером');
    assert.match(h.text(), /Не удалось загрузить аккаунт/);
    assert.equal(h.busy(), false);
    assert.equal(h.token(), cleared ? null : 'new-token');
  });
}

test('tabs and forgot-password navigation cannot clear the pending login lock', async () => {
  const h = harness();
  fillLogin(h);
  const register = h.button('Регистрация').props.onClick;
  const forgot = h.button('Забыли пароль?').props.onClick;
  const submit = h.form().props.onSubmit;
  const first = submit(event());
  register();
  forgot();
  await submit(event());
  h.render();
  assert.equal(h.title(), 'С возвращением');
  assert.equal(h.busy(), true);
  assert.equal(h.button('Регистрация').props.disabled, true);
  assert.equal(h.button('Забыли пароль?').props.disabled, true);
  assert.equal(h.requests.length, 1);
  h.requests[0].reject(h.error('offline'));
  await first;
  h.render();
  h.button('Регистрация').props.onClick();
  h.render();
  assert.equal(h.title(), 'Создайте аккаунт');
});

test('session retry is synchronous single-flight and account switch cannot erase its token', async () => {
  const h = harness({ token: 'saved-token', sessionError: 'offline' });
  const retry = h.button('Повторить').props.onClick;
  const switchAccount = h.button('Войти в другой аккаунт').props.onClick;
  const first = retry();
  await retry();
  switchAccount();
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].method, 'authSession');
  assert.equal(h.token(), 'saved-token');
  assert.deepEqual(h.tokenWrites, []);
  h.render();
  assert.equal(h.title(), 'Нет связи с сервером');
  assert.equal(h.button('Войти в другой аккаунт').props.disabled, true);
  h.requests[0].resolve(response());
  await first;
  assert.equal(h.accepted.length, 1);
});

test('an explicit retry 401 can internally navigate to login while the lock is held', async () => {
  const h = harness({ token: 'invalid-token', sessionError: 'offline' });
  const first = h.button('Повторить').props.onClick();
  h.requests[0].reject(h.error('Сессия истекла', 401));
  await first;
  h.render();
  assert.equal(h.title(), 'С возвращением');
  assert.equal(h.token(), null);
  assert.equal(h.state.sessionError, '');
  assert.equal(h.busy(), false);
  fillLogin(h);
  const second = h.form().props.onSubmit(event());
  assert.equal(h.requests[1].method, 'login');
  h.requests[1].resolve(response());
  await second;
});

test('session-retry network failure permits an explicit account switch after completion', async () => {
  const h = harness({ token: 'saved-token', sessionError: 'offline' });
  const first = h.button('Повторить').props.onClick();
  h.requests[0].reject(h.error('offline'));
  await first;
  h.render();
  assert.equal(h.token(), 'saved-token');
  h.button('Войти в другой аккаунт').props.onClick();
  h.render();
  assert.equal(h.title(), 'С возвращением');
  assert.equal(h.token(), null);
  assert.equal(h.requests.length, 1);
});

test('the retry lock also covers the legacy /me fallback', async () => {
  const h = harness({ token: 'saved-token', sessionError: 'offline' });
  const retry = h.button('Повторить').props.onClick;
  const switchAccount = h.button('Войти в другой аккаунт').props.onClick;
  const first = retry();
  h.requests[0].reject(h.error('not found', 404));
  await settle();
  assert.equal(h.requests[1].method, 'me');
  await retry();
  switchAccount();
  assert.equal(h.token(), 'saved-token');
  assert.equal(h.requests.length, 2);
  h.requests[1].resolve({ user: response().user });
  await first;
  assert.equal(h.accepted.length, 1);
});

test('registration and recovery submit handlers share the synchronous lock', async () => {
  const h = harness();
  h.button('Регистрация').props.onClick(); h.render();
  h.input('auth-register-user', 'alice');
  h.input('auth-register-email', 'alice@example.test');
  h.input('auth-register-password', 'long-test-password');
  h.input('auth-register-invite', 'INVITE');
  const submit = h.form().props.onSubmit;
  const first = submit(event());
  await submit(event());
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].method, 'registerStart');
  h.requests[0].reject(h.error('offline'));
  await first;
  h.render();
  h.button('Вход').props.onClick(); h.render();
  h.button('Забыли пароль?').props.onClick(); h.render();
  h.input('auth-forgot-email', 'alice@example.test');
  const recover = h.form().props.onSubmit;
  const pending = recover(event());
  await recover(event());
  assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].method, 'forgotPassword');
  h.requests[1].resolve({});
  await pending;
  h.render();
  assert.equal(h.title(), 'Проверьте почту');
});

test('pending verification blocks duplicate code/resend and editing registration data', async () => {
  const h = harness({ storage: {
    'relay.auth.registration-flow.v1': JSON.stringify({ id: 'flow', expiresAt: Date.now() + 600_000, resendAt: 0, delivered: true }),
  } });
  h.input('auth-register-code', '1234');
  const submit = h.form().props.onSubmit;
  const edit = h.button('Изменить данные').props.onClick;
  const resend = h.button('Отправить ещё раз').props.onClick;
  const first = submit(event());
  await submit(event());
  await resend();
  edit();
  h.render();
  assert.equal(h.title(), 'Подтвердите почту');
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].method, 'registerVerify');
  h.requests[0].resolve(response());
  await first;
  assert.equal(h.accepted.length, 1);
});
