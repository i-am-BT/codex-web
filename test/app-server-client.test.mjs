import test from 'node:test';
import assert from 'node:assert/strict';

import { CodexAppServerClient } from '../app-server-client.mjs';

test('app-server error notifications do not emit an unhandled EventEmitter error', () => {
  const client = new CodexAppServerClient();
  const params = {
    error: { message: 'Reconnecting... 1/5' },
    willRetry: true,
    threadId: '019f647e-5ce7-7cb3-98d9-c8646fed896d',
    turnId: '019f64c3-8e99-7f90-98b5-11fe25ac82ed',
  };
  let notification;
  let appServerError;
  client.on('notification', (event) => {
    notification = event;
  });
  client.on('appServerError', (eventParams) => {
    appServerError = eventParams;
  });

  assert.doesNotThrow(() => {
    client.handleLine(JSON.stringify({ method: 'error', params }));
  });
  assert.deepEqual(notification, { method: 'error', params });
  assert.deepEqual(appServerError, params);
});
