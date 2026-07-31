import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Docker persists payment task history across rebuilds', () => {
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  assert.match(compose, /\.\/payment-tasks:\/app\/payment-tasks/);
  assert.match(dockerfile, /payment-tasks/);
});
