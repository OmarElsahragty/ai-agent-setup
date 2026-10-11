import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEXTAREA_SELECTORS,
  locateChatInput,
  readInputText,
  appendTranscript,
  setTextareaValue,
  findSubmitButton,
  chooseSubmitStrategy,
  submitChatInput,
  planMount,
  isMounted,
  applyMount,
  detachAll,
} from '../lib/chat-input.mjs';

// --- minimal fake DOM (tag, .class, [attr="value"], comma lists) ------------

function parseSimple(selector) {
  const match = selector.trim().match(/^([a-z0-9]+)?((?:\.[\w-]+)*)((?:\[[\w-]+(?:="[^"]*")?\])*)$/i);
  if (!match) throw new Error(`unsupported selector ${selector}`);
  const classes = (match[2] || '').split('.').filter(Boolean);
  const attrs = [...(match[3] || '').matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((m) => [m[1], m[2]]);
  return { tag: match[1] ? match[1].toLowerCase() : null, classes, attrs };
}

class FakeElement {
  constructor(tag, { cls = '', attrs = {}, visible = true } = {}) {
    this.tagName = tag.toUpperCase();
    this.classes = new Set(cls.split(/\s+/).filter(Boolean));
    this.attrs = { ...attrs };
    this.children = [];
    this.parentElement = null;
    this.visible = visible;
    this.events = [];
    this.clicks = 0;
    this.disabled = false;
  }
  get offsetWidth() {
    return this.visible ? 100 : 0;
  }
  get offsetHeight() {
    return this.visible ? 20 : 0;
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  get type() {
    return this.attrs.type;
  }
  set type(value) {
    this.attrs.type = value;
  }
  get nextElementSibling() {
    if (!this.parentElement) return null;
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get isConnected() {
    let node = this;
    while (node.parentElement) node = node.parentElement;
    return node.tagName === 'BODY';
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      const { tag, classes, attrs } = parseSimple(part);
      if (tag && this.tagName.toLowerCase() !== tag) return false;
      if (!classes.every((c) => this.classes.has(c))) return false;
      return attrs.every(([name, value]) => (value === undefined ? name in this.attrs : this.attrs[name] === value));
    });
  }
  append(...nodes) {
    for (const node of nodes) this.appendChild(node);
    return this;
  }
  appendChild(node) {
    if (node.parentElement) node.parentElement.removeChild(node);
    node.parentElement = this;
    this.children.push(node);
    return node;
  }
  insertBefore(node, before) {
    if (node.parentElement) node.parentElement.removeChild(node);
    const index = this.children.indexOf(before);
    if (index === -1) throw new Error('reference node is not a child');
    node.parentElement = this;
    this.children.splice(index, 0, node);
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index === -1) throw new Error('not a child');
    this.children.splice(index, 1);
    node.parentElement = null;
    return node;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches(selector)) return node;
      node = node.parentElement;
    }
    return null;
  }
  dispatchEvent(event) {
    this.events.push(event);
    return true;
  }
  click() {
    this.clicks += 1;
  }
}

class FakeTextArea extends FakeElement {
  constructor(opts) {
    super('textarea', opts);
    this._value = '';
    this.protoSets = 0;
  }
}
Object.defineProperty(FakeTextArea.prototype, 'value', {
  configurable: true,
  get() {
    return this._value;
  },
  set(value) {
    this.protoSets += 1;
    this._value = value;
  },
});

class FakeForm extends FakeElement {
  constructor(opts) {
    super('form', opts);
    this.submits = 0;
  }
  requestSubmit() {
    this.submits += 1;
  }
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    Object.assign(this, init);
  }
}

const fakeWin = { HTMLTextAreaElement: FakeTextArea, InputEvent: FakeEvent, Event: FakeEvent, KeyboardEvent: FakeEvent };

/** CloudCLI 1.37.3 composer: shell > container > form > body(overlay div + textarea) + footer(submit). */
function buildComposer({ running = false, withOverlay = true } = {}) {
  const body = new FakeElement('body');
  const shell = new FakeElement('div', { cls: 'chat-composer-shell' });
  const container = new FakeElement('div', { cls: 'relative mx-auto' });
  const form = new FakeForm({ attrs: { 'data-slot': 'prompt-input' } });
  const inputBody = new FakeElement('div', { attrs: { 'data-slot': 'prompt-input-body' } });
  const overlay = new FakeElement('div', { cls: 'chat-input-placeholder block', attrs: { 'aria-hidden': 'true' } });
  const textarea = new FakeTextArea({ cls: 'chat-input-placeholder block', attrs: { 'data-slot': 'prompt-input-textarea' } });
  const footer = new FakeElement('div', { attrs: { 'data-slot': 'prompt-input-footer' } });
  const attach = new FakeElement('button', { attrs: { type: 'button', 'aria-label': 'Attach files' } });
  const send = new FakeElement('button', { attrs: { type: running ? 'button' : 'submit', 'aria-label': running ? 'Stop' : 'Send' } });
  if (withOverlay) inputBody.append(overlay);
  inputBody.append(textarea);
  footer.append(attach, send);
  form.append(inputBody, footer);
  container.append(form);
  shell.append(container);
  body.append(shell);
  return { body, shell, container, form, textarea, overlay, send, attach };
}

// --- locator -----------------------------------------------------------------

test('D1: textarea selector wins and the aria-hidden overlay div is never picked', () => {
  const { body, textarea, form } = buildComposer();
  assert.equal(TEXTAREA_SELECTORS[0], 'textarea[data-slot="prompt-input-textarea"]');
  const found = locateChatInput(body);
  assert.equal(found.kind, 'textarea');
  assert.equal(found.element, textarea);
  assert.equal(found.form, form);
  assert.equal(found.anchor, form);
});

test('D1: class-only textarea (no data-slot) is still found', () => {
  const body = new FakeElement('body');
  const form = new FakeForm();
  const textarea = new FakeTextArea({ cls: 'chat-input-placeholder' });
  form.append(textarea);
  body.append(form);
  assert.equal(locateChatInput(body).element, textarea);
});

test('D1: any textarea inside the prompt-input form is the next fallback', () => {
  const body = new FakeElement('body');
  const form = new FakeForm({ attrs: { 'data-slot': 'prompt-input' } });
  const textarea = new FakeTextArea({ cls: 'renamed-class' });
  form.append(textarea);
  body.append(form);
  const found = locateChatInput(body);
  assert.equal(found.kind, 'textarea');
  assert.equal(found.element, textarea);
  assert.equal(found.anchor, form);
});

test('D1: legacy CodeMirror editor is the last fallback', () => {
  const body = new FakeElement('body');
  const wrap = new FakeElement('div');
  const editor = new FakeElement('div', { cls: 'cm-editor' });
  const content = new FakeElement('div', { cls: 'cm-content' });
  content.textContent = 'draft';
  editor.append(content);
  wrap.append(editor);
  body.append(wrap);
  const found = locateChatInput(body);
  assert.equal(found.kind, 'codemirror');
  assert.equal(found.content, content);
  assert.equal(found.anchor, editor);
  assert.equal(readInputText(found), 'draft');
});

test('D1: the last visible composer is used when several exist', () => {
  const body = new FakeElement('body');
  const first = new FakeTextArea({ cls: 'chat-input-placeholder', visible: true });
  const visible = new FakeTextArea({ cls: 'chat-input-placeholder', visible: true });
  const offscreen = new FakeTextArea({ cls: 'chat-input-placeholder', visible: false });
  body.append(first, visible, offscreen);
  assert.equal(locateChatInput(body).element, visible);
});

test('no composer (sign-in screen) -> null; bad input -> null', () => {
  const body = new FakeElement('body');
  body.append(new FakeElement('div', { cls: 'chat-input-placeholder' }));
  assert.equal(locateChatInput(body), null);
  assert.equal(locateChatInput(null), null);
  assert.equal(readInputText(null), '');
});

// --- insert -------------------------------------------------------------------

test('appendTranscript mirrors the app voice handler (trimmed draft + space + text)', () => {
  assert.equal(appendTranscript('', 'hello world'), 'hello world');
  assert.equal(appendTranscript('  draft  ', ' more '), 'draft more');
  assert.equal(appendTranscript('draft', '   '), 'draft');
  assert.equal(appendTranscript(undefined, 'x'), 'x');
});

test('D1: setTextareaValue uses the native prototype setter and a bubbling input event', () => {
  const { textarea } = buildComposer();
  // React's value tracker shadows `value` on the instance; a plain assignment
  // would only hit the tracker and React would ignore the change.
  let trackerSets = 0;
  Object.defineProperty(textarea, 'value', {
    configurable: true,
    get() {
      return this._value;
    },
    set(value) {
      trackerSets += 1;
      this._value = value;
    },
  });
  assert.equal(setTextareaValue(textarea, 'run the tests', fakeWin), true);
  assert.equal(textarea.protoSets, 1);
  assert.equal(trackerSets, 0);
  assert.equal(textarea.value, 'run the tests');
  assert.equal(textarea.events.length, 1);
  assert.equal(textarea.events[0].type, 'input');
  assert.equal(textarea.events[0].bubbles, true);
  assert.equal(readInputText(locateChatInput(textarea.closest('body'))), 'run the tests');
});

// --- send ---------------------------------------------------------------------

test('D1: idle composer submits through the enabled type=submit send button', () => {
  const { body, send } = buildComposer();
  const found = locateChatInput(body);
  assert.equal(findSubmitButton(found.form), send);
  assert.equal(chooseSubmitStrategy(found), 'button');
  assert.equal(submitChatInput(found, 'button', fakeWin), true);
  assert.equal(send.clicks, 1);
  assert.equal(found.form.submits, 0);
});

test('D1: run active (send button is type=button: queue OR abort) -> form.requestSubmit, never a click', () => {
  const { body, send, form } = buildComposer({ running: true });
  const found = locateChatInput(body);
  assert.equal(findSubmitButton(form), null);
  assert.equal(chooseSubmitStrategy(found), 'requestSubmit');
  assert.equal(submitChatInput(found, 'requestSubmit', fakeWin), true);
  assert.equal(form.submits, 1);
  assert.equal(send.clicks, 0);
});

test('D1: disabled send button (React not committed yet) falls back to requestSubmit', () => {
  const { body, send } = buildComposer();
  send.disabled = true;
  assert.equal(chooseSubmitStrategy(locateChatInput(body)), 'requestSubmit');
  assert.equal(submitChatInput(locateChatInput(body), 'button', fakeWin), false);
});

test('D1: no form -> Ctrl+Enter keydown on the textarea (always submits in the app)', () => {
  const body = new FakeElement('body');
  const textarea = new FakeTextArea({ cls: 'chat-input-placeholder' });
  body.append(textarea);
  const found = locateChatInput(body);
  assert.equal(chooseSubmitStrategy(found), 'enter');
  assert.equal(submitChatInput(found, 'enter', fakeWin), true);
  const [event] = textarea.events;
  assert.equal(event.type, 'keydown');
  assert.equal(event.key, 'Enter');
  assert.equal(event.ctrlKey, true);
  assert.equal(event.bubbles, true);
});

test('legacy CodeMirror send clicks the last enabled icon button of its form', () => {
  const body = new FakeElement('body');
  const form = new FakeForm();
  const editor = new FakeElement('div', { cls: 'cm-editor' });
  editor.append(new FakeElement('div', { cls: 'cm-content' }));
  const iconButton = new FakeElement('button');
  iconButton.append(new FakeElement('svg'));
  form.append(editor, iconButton);
  body.append(form);
  const found = locateChatInput(body);
  assert.equal(chooseSubmitStrategy(found), 'legacy');
  assert.equal(submitChatInput(found, 'legacy', fakeWin), true);
  assert.equal(iconButton.clicks, 1);
  assert.equal(chooseSubmitStrategy(null), null);
  assert.equal(submitChatInput(null, 'button', fakeWin), false);
});

// --- mount (D1 placement + D8 hide) -------------------------------------------

test('D1: both bars mount in flow directly above the chat form (activity, voice, form)', () => {
  const { body, container, form } = buildComposer();
  const abar = new FakeElement('div', { cls: 'ccv-abar' });
  const vbar = new FakeElement('div', { cls: 'ccv-bar' });
  const plan = planMount(locateChatInput(body));
  assert.equal(plan.parent, container);
  assert.equal(plan.before, form);
  assert.equal(applyMount(plan, [abar, vbar]), true);
  assert.deepEqual(container.children, [abar, vbar, form]);
  assert.equal(abar.parentElement === body, false);
  assert.equal(isMounted(plan, [abar, vbar]), true);
  // idempotent: a second pass moves nothing
  assert.equal(applyMount(plan, [abar, vbar]), false);
});

test('D1: SPA re-render (new form) re-mounts the bars above the new form', () => {
  const first = buildComposer();
  const abar = new FakeElement('div', { cls: 'ccv-abar' });
  const vbar = new FakeElement('div', { cls: 'ccv-bar' });
  applyMount(planMount(locateChatInput(first.body)), [abar, vbar]);
  // React replaces the whole composer container (session switch)
  first.shell.removeChild(first.container);
  const container2 = new FakeElement('div', { cls: 'relative mx-auto' });
  const form2 = new FakeForm({ attrs: { 'data-slot': 'prompt-input' } });
  form2.append(new FakeTextArea({ cls: 'chat-input-placeholder', attrs: { 'data-slot': 'prompt-input-textarea' } }));
  container2.append(form2);
  first.shell.append(container2);
  const plan = planMount(locateChatInput(first.body));
  assert.equal(isMounted(plan, [abar, vbar]), false);
  assert.equal(applyMount(plan, [abar, vbar]), true);
  assert.deepEqual(container2.children, [abar, vbar, form2]);
});

test('D1: an app node inserted between the bars and the form is detected and fixed', () => {
  const { body, container, form } = buildComposer();
  const abar = new FakeElement('div');
  const vbar = new FakeElement('div');
  const plan = planMount(locateChatInput(body));
  applyMount(plan, [abar, vbar]);
  const dropdown = new FakeElement('div', { cls: 'absolute bottom-full' });
  container.insertBefore(dropdown, form);
  assert.equal(isMounted(plan, [abar, vbar]), false);
  applyMount(plan, [abar, vbar]);
  assert.deepEqual(container.children, [dropdown, abar, vbar, form]);
});

test('D8: no chat form (sign-in screen) -> no mount plan, bars detached, never parked on <body>', () => {
  const composer = buildComposer();
  const abar = new FakeElement('div');
  const vbar = new FakeElement('div');
  applyMount(planMount(locateChatInput(composer.body)), [abar, vbar]);
  // navigate to a screen without a composer
  composer.shell.removeChild(composer.container);
  const signIn = new FakeElement('body');
  signIn.append(new FakeElement('form', { attrs: { 'data-slot': 'login' } }));
  assert.equal(planMount(locateChatInput(signIn)), null);
  assert.equal(planMount(null), null);
  assert.equal(applyMount(null, [abar, vbar]), false);
  // bars still attached to the detached container -> detachAll removes them
  assert.equal(detachAll([abar, vbar]), true);
  assert.equal(abar.parentElement, null);
  assert.equal(vbar.parentElement, null);
  assert.equal(detachAll([abar, vbar]), false);
  assert.equal(signIn.children.includes(abar) || signIn.children.includes(vbar), false);
});
