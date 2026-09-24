import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Given, When, Then } from '@cucumber/cucumber';
import { until } from './common.mjs';

const cli = '/opt/ours/node_modules/.bin/ours-tg-connector';
const run = (...args) => execFileSync(cli, args, { encoding: 'utf8', timeout: 30_000 });

Given('the published Telegram connector is running in its container', function () {
  assert.ok(process.env.OURS_TG_DAEMON_URL);
});
When('I register bot {string} through the CLI', function (name) {
  this.botName = name;
  this.registration = run('add_bot', '--name', name, '--bot-token', '123456:TEST_E2E');
});
Then("the registered bot appears in the connector's list", function () {
  assert.ok(this.registration.includes(this.botName) || /ours_e2e_bot/i.test(this.registration));
  assert.ok(run('list_bots').includes(this.botName));
});
Then('the connector authenticates its bot and polls for updates', async function () {
  await until('Telegram getMe/getUpdates', async () => {
    const { requests } = await fetch('http://telegram-mock:8080/requests').then(response => response.json());
    return requests.some(row => row.path?.endsWith('/getMe')) &&
      requests.some(row => row.path?.endsWith('/getUpdates')) ? true : undefined;
  }, 10_000);
});
When('Telegram delivers an id request from chat {int}', async function (chatId) {
  this.chatId = chatId;
  const response = await fetch('http://telegram-mock:8080/enqueue', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      update_id: Math.floor(Date.now() / 1000),
      message: {
        message_id: 51, date: Math.floor(Date.now() / 1000),
        chat: { id: chatId, type: 'private' },
        from: { id: 42, first_name: 'E2E' }, text: '/id',
      },
    }),
  });
  assert.equal(response.status, 200);
});
Then('the connector sends the chat identifiers back to chat {int}', async function (chatId) {
  assert.equal(chatId, this.chatId);
  await until('Telegram connector reply to /id', async () => {
    const { requests } = await fetch('http://telegram-mock:8080/requests').then(response => response.json());
    return requests.filter(row => row.path?.endsWith('/sendMessage')).some(row => {
      const body = JSON.parse(row.body);
      return Number(body.chat_id) === chatId && body.text?.includes(`chat id: ${chatId}`);
    }) ? true : undefined;
  }, 15_000);
});
