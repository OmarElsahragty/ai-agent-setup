// Chat composer locator (D1) — the one place that knows how to find the
// CloudCLI chat input, its form and its send button, how to write text into
// it so React sees the change, and where the add-on bars mount.
//
// CloudCLI 1.37.3 (dist/assets/index-sFfz8iBR.js, grep-verified):
//   PromptInput         -> <form data-slot="prompt-input" onSubmit={handleSubmit}>
//   PromptInputTextarea -> <textarea data-slot="prompt-input-textarea"
//                            class="chat-input-placeholder …" value={input} onChange=…>
//                          (an aria-hidden overlay <div class="chat-input-placeholder">
//                           shares the class, so only textarea.* selectors are safe)
//   PromptInputSubmit   -> <button type="submit"> while idle; type="button" while a
//                          run streams (its onClick is then queue-next OR abort —
//                          never click it in that state, use form.requestSubmit()).
//   handleSubmit reads the input from a ref updated synchronously by onChange
//   and calls preventDefault() first; Ctrl/Cmd+Enter always submits.
// Older builds used a CodeMirror 6 editor (.cm-editor/.cm-content): kept as the
// fallback so the add-on still works if the markup flips back.

export const TEXTAREA_SELECTORS = [
  'textarea[data-slot="prompt-input-textarea"]',
  'textarea.chat-input-placeholder',
];
export const FORM_SELECTORS = ['form[data-slot="prompt-input"]'];
export const LEGACY_EDITOR_SELECTOR = '.cm-editor';
export const LEGACY_CONTENT_SELECTOR = '.cm-content';

function isVisible(element) {
  try {
    if (element.offsetWidth > 0 || element.offsetHeight > 0) return true;
    return typeof element.getClientRects === 'function' && element.getClientRects().length > 0;
  } catch {
    return false;
  }
}

function query(root, selector) {
  try {
    return Array.from(root.querySelectorAll(selector) || []);
  } catch {
    return [];
  }
}

/** Last visible match (the composer sits at the bottom), else the last match. */
function lastVisible(elements) {
  if (!elements.length) return null;
  const visible = elements.filter(isVisible);
  const pool = visible.length ? visible : elements;
  return pool[pool.length - 1];
}

function closestForm(element) {
  try {
    return typeof element.closest === 'function' ? element.closest('form') : null;
  } catch {
    return null;
  }
}

/**
 * Locate the chat composer. Textarea selectors first (1.37.3), then any
 * textarea inside the prompt-input form, then the legacy CodeMirror editor.
 * Returns {kind:'textarea'|'codemirror', element, content, form, anchor} or null.
 * `anchor` is the node the bars mount directly above (the form when present).
 */
export function locateChatInput(doc) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return null;
  for (const selector of TEXTAREA_SELECTORS) {
    const element = lastVisible(query(doc, selector));
    if (element) {
      const form = closestForm(element);
      return { kind: 'textarea', element, content: element, form, anchor: form || element };
    }
  }
  for (const selector of FORM_SELECTORS) {
    const form = lastVisible(query(doc, selector));
    if (!form) continue;
    const element = lastVisible(query(form, 'textarea'));
    if (element) return { kind: 'textarea', element, content: element, form, anchor: form };
  }
  const editor = lastVisible(query(doc, LEGACY_EDITOR_SELECTOR));
  if (editor) {
    const content = (() => {
      try {
        return editor.querySelector(LEGACY_CONTENT_SELECTOR);
      } catch {
        return null;
      }
    })();
    const form = closestForm(editor);
    return { kind: 'codemirror', element: editor, content, form, anchor: form || editor };
  }
  return null;
}

/** Current composer text ('' when there is no composer) — rule 2 + send checks. */
export function readInputText(found) {
  if (!found) return '';
  try {
    if (found.kind === 'textarea') return typeof found.element.value === 'string' ? found.element.value : '';
    const content = found.content;
    return content && typeof content.textContent === 'string' ? content.textContent : '';
  } catch {
    return '';
  }
}

/** Same rule as the app's own voice transcript handler: trimmed draft + space + text. */
export function appendTranscript(existing, text) {
  const base = String(existing ?? '').trim();
  const addition = String(text ?? '').trim();
  if (!addition) return base;
  return base ? `${base} ${addition}` : addition;
}

/**
 * Write `value` into a React-controlled textarea: the native prototype value
 * setter (bypasses React's value tracker) + a bubbling `input` event, so the
 * app's onChange runs and its state/ref pick the text up.
 */
export function setTextareaValue(textarea, value, win = globalThis) {
  if (!textarea) return false;
  const text = String(value ?? '');
  let proto = null;
  try {
    proto = win && win.HTMLTextAreaElement ? win.HTMLTextAreaElement.prototype : Object.getPrototypeOf(textarea);
  } catch {
    proto = null;
  }
  const descriptor = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
  if (descriptor && typeof descriptor.set === 'function') descriptor.set.call(textarea, text);
  else textarea.value = text;
  try {
    if (typeof textarea.setSelectionRange === 'function') textarea.setSelectionRange(text.length, text.length);
  } catch {
    // selection is cosmetic
  }
  let event = null;
  try {
    event =
      win && typeof win.InputEvent === 'function'
        ? new win.InputEvent('input', { bubbles: true, inputType: 'insertText' })
        : new (win && win.Event ? win.Event : Event)('input', { bubbles: true });
  } catch {
    event = new Event('input', { bubbles: true });
  }
  textarea.dispatchEvent(event);
  return textarea.value === text;
}

/** The form's submit button while it is in submit mode (idle app), else null. */
export function findSubmitButton(form) {
  if (!form) return null;
  const buttons = query(form, 'button[type="submit"]');
  return buttons.length ? buttons[buttons.length - 1] : null;
}

/**
 * How to submit (pure decision):
 *  'button'        enabled type=submit button (the app's send button, idle state)
 *  'requestSubmit' form present but the button is not in submit mode (run active:
 *                  the button would queue OR abort) — fire the form's own submit
 *  'enter'         no form: Ctrl+Enter keydown on the textarea (always submits)
 *  'legacy'        CodeMirror fallback (icon-button heuristic)
 *  null            nothing to submit to
 */
export function chooseSubmitStrategy(found) {
  if (!found) return null;
  if (found.kind === 'codemirror') return 'legacy';
  const button = findSubmitButton(found.form);
  if (button && !button.disabled) return 'button';
  if (found.form && typeof found.form.requestSubmit === 'function') return 'requestSubmit';
  if (found.element) return 'enter';
  return null;
}

/** Execute a strategy chosen by chooseSubmitStrategy. Returns true if dispatched. */
export function submitChatInput(found, strategy, win = globalThis) {
  if (!found || !strategy) return false;
  try {
    if (strategy === 'button') {
      const button = findSubmitButton(found.form);
      if (!button || button.disabled) return false;
      button.click();
      return true;
    }
    if (strategy === 'requestSubmit') {
      found.form.requestSubmit();
      return true;
    }
    if (strategy === 'enter') {
      const KeyboardEventCtor = win && win.KeyboardEvent ? win.KeyboardEvent : KeyboardEvent;
      found.element.dispatchEvent(
        new KeyboardEventCtor('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }),
      );
      return true;
    }
    if (strategy === 'legacy') {
      const editor = found.element;
      const container = found.form || editor.parentElement?.parentElement?.parentElement || null;
      if (!container) return false;
      const buttons = query(container, 'button');
      const target = [...buttons].reverse().find((button) => !button.disabled && button.querySelector('svg, img'));
      if (!target) return false;
      target.click();
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * D1/D8 mount plan: the bars sit in the page flow directly above the chat
 * form (legacy: above the editor). No composer -> null (bars are detached,
 * never parked on <body>).
 */
export function planMount(found) {
  if (!found || !found.anchor || !found.anchor.parentElement) return null;
  return { parent: found.anchor.parentElement, before: found.anchor };
}

/** True when `nodes` already sit, in order, directly before plan.before. */
export function isMounted(plan, nodes) {
  if (!plan) return false;
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    const next = i + 1 < nodes.length ? nodes[i + 1] : plan.before;
    if (!node || node.parentElement !== plan.parent || node.nextElementSibling !== next) return false;
  }
  return true;
}

/** Place `nodes` (in order) directly above plan.before; no-op when already there. */
export function applyMount(plan, nodes) {
  if (!plan || isMounted(plan, nodes)) return false;
  for (const node of nodes) plan.parent.insertBefore(node, plan.before);
  return true;
}

/** Remove `nodes` from the DOM (no composer on this screen). */
export function detachAll(nodes) {
  let changed = false;
  for (const node of nodes) {
    if (node && node.parentElement) {
      node.parentElement.removeChild(node);
      changed = true;
    }
  }
  return changed;
}
