const { test, expect } = require('@playwright/test');

const WEBVIEW_URL = process.env.WEBVIEW_URL ?? 'http://localhost:8080';

const TIMEOUTS = {
  UI_POLL: 5_000,
  ASSISTANT_RESPONSE: 10_000,
  DOUBLE_CLICK_DELAY_MS: 50,
};

const TIMESTAMP_OFFSET = {
  SMALL: 100,
  MEDIUM: 500,
};

let chatStore;
let chatManager;
let panel;

function createGate() {
  const { promise, resolve } = Promise.withResolvers();
  return { gate: promise, open: resolve };
}

test.beforeEach(async () => {
  chatStore = new InMemoryChatStore({ yieldBeforeWrite: true });
  chatManager = new ChatManager(chatStore);
  panel = createMockPanel();
});

test.afterEach(async () => {
  await chatStore.clear();
});

function createMessage(overrides) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: 'Hello' }],
    isInternal: false,
    createdAt: Date.now(),
    ...overrides,
  };
}

async function createEmptyChat(prefix = 'test-chat') {
  const chatId = `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
  await chatStore.saveChat({ id: chatId, title: '', messages: [], updatedAt: Date.now() });
  return chatId;
}

async function createChatWithMessages(prefix, messages) {
  const chatId = `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
  await chatStore.saveChat({ id: chatId, title: '', messages, updatedAt: Date.now() });
  return chatId;
}

function assertNoDuplicateIds(messages) {
  const ids = messages.map((m) => m.id);
  expect(new Set(ids).size).toBe(ids.length);
}

function assertAllSettledFulfilled(results) {
  for (const result of results) {
    expect(result.status).toBe('fulfilled');
  }
}

test.describe('API-level race condition tests', () => {
  test('concurrent addMessageToChat does not produce duplicate messages', async () => {
    const chatId = await createEmptyChat();

    const msg1 = createMessage({ id: 'msg-1' });
    const msg2 = createMessage({ id: 'msg-2', createdAt: Date.now() + TIMESTAMP_OFFSET.SMALL });

    const { gate, open } = createGate();

    const p1 = gate.then(() => chatManager.addMessageToChat({ chatId, message: msg1, panel }));
    const p2 = gate.then(() => chatManager.addMessageToChat({ chatId, message: msg2, panel }));

    open();

    const results = await Promise.allSettled([p1, p2]);

    assertAllSettledFulfilled(results);

    const chat = await chatStore.loadChat(chatId);
    assertNoDuplicateIds(chat.messages);
    expect(chat.messages).toHaveLength(2);

    const ids = chat.messages.map((m) => m.id);
    expect(ids).toContain('msg-1');
    expect(ids).toContain('msg-2');
    expect(ids.indexOf('msg-1')).toBeLessThan(ids.indexOf('msg-2'));
  });

  test('concurrent modifyMessage + addMessage do not corrupt state', async () => {
    const assistantMsg = createMessage({
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
    });
    const chatId = await createChatWithMessages('test-chat-concurrent', [assistantMsg]);

    const { gate, open } = createGate();

    const modifyPromise = gate.then(() =>
      chatManager.modifyChatMessageById('assistant-1', {
        chatId,
        update: (msg) => ({
          ...msg,
          content: [{ type: 'text', text: 'Streaming chunk appended' }],
        }),
        panel,
      })
    );

    const addPromise = gate.then(() => {
      const userMsg = createMessage({
        id: 'user-2',
        content: [{ type: 'text', text: 'Follow-up' }],
        createdAt: Date.now() + TIMESTAMP_OFFSET.MEDIUM,
      });
      return chatManager.addMessageToChat({ chatId, message: userMsg, panel });
    });

    open();

    const results = await Promise.allSettled([modifyPromise, addPromise]);
    assertAllSettledFulfilled(results);

    const chat = await chatStore.loadChat(chatId);

    assertNoDuplicateIds(chat.messages);
    expect(chat.messages).toHaveLength(2);

    const assistant = chat.messages.find((m) => m.id === 'assistant-1');
    expect(assistant).toBeDefined();
    expect(assistant.content[0].text).toBe('Streaming chunk appended');

    const user = chat.messages.find((m) => m.id === 'user-2');
    expect(user).toBeDefined();

    const assistantIdx = chat.messages.findIndex((m) => m.id === 'assistant-1');
    const userIdx = chat.messages.findIndex((m) => m.id === 'user-2');
    expect(assistantIdx).toBeLessThan(userIdx);
  });
});

test.describe('UI-level race condition tests', () => {
  test('concurrent addMessageToChat — UI reflects correct state', async ({ page }) => {
    const chatId = await createEmptyChat('test-chat-ui');

    const msg1 = createMessage({ id: 'msg-1' });
    const msg2 = createMessage({ id: 'msg-2', createdAt: Date.now() + TIMESTAMP_OFFSET.SMALL });

    await Promise.allSettled([
      chatManager.addMessageToChat({ chatId, message: msg1, panel }),
      chatManager.addMessageToChat({ chatId, message: msg2, panel }),
    ]);

    await page.goto(`${WEBVIEW_URL}/chat/${chatId}`);

    const messageLocator = page.locator('[data-testid="chat-message"]');
    await expect(messageLocator).toHaveCount(2, { timeout: TIMEOUTS.UI_POLL });

    const renderedIds = await messageLocator.evaluateAll(
      (nodes) => nodes.map((n) => n.getAttribute('data-message-id'))
    );

    expect(new Set(renderedIds).size).toBe(renderedIds.length);
    expect(renderedIds).toContain('msg-1');
    expect(renderedIds).toContain('msg-2');
  });

  test('rapid double-submit does not create duplicate user messages', async ({ page }) => {
    await page.goto(`${WEBVIEW_URL}/chat/new`);

    const input = page.locator('[data-testid="chat-input"]');
    await input.fill('Test message');

    const sendBtn = page.locator('[data-testid="send-button"]');

    await sendBtn.click();
    await page.waitForTimeout(TIMEOUTS.DOUBLE_CLICK_DELAY_MS);
    await sendBtn.click().catch(() => {});

    await expect.poll(
      async () => await page.locator('[data-testid="chat-message"][data-role="assistant"]').count(),
      { timeout: TIMEOUTS.ASSISTANT_RESPONSE }
    ).toBeGreaterThanOrEqual(1);

    const userMessages = page.locator('[data-testid="chat-message"][data-role="user"]');
    await expect(userMessages).toHaveCount(1);

    const messageText = await userMessages.first().textContent();
    expect(messageText).toContain('Test message');
  });
});
