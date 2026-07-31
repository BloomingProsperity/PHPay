import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Docker persists payment task history across rebuilds', () => {
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
  assert.match(compose, /\.\/payment-tasks:\/app\/payment-tasks/);
  assert.match(dockerfile, /payment-tasks/);
});

test('Docker proxy is portable and never hardcodes the developer machine', () => {
  const compose = fs.readFileSync('docker-compose.yml', 'utf8');
  assert.doesNotMatch(compose, /192\.168\.65\.254|10808/);
  assert.match(compose, /HTTP_PROXY:\s*\$\{PHPAY_PROXY:-\}/);
  assert.match(compose, /HTTPS_PROXY:\s*\$\{PHPAY_PROXY:-\}/);
  assert.match(compose, /CF_PROXY:\s*\$\{PHPAY_PROXY:-\}/);
  assert.match(compose, /host\.docker\.internal:host-gateway/);
});

test('Windows one-click launcher auto-detects and maps a local proxy for Docker', () => {
  const launcher = fs.readFileSync('deploy.ps1', 'utf8');
  const wrapper = fs.readFileSync('start.bat', 'utf8');
  assert.match(launcher, /Internet Settings/);
  assert.match(launcher, /HTTPS_PROXY/);
  assert.match(launcher, /HTTP_PROXY/);
  assert.match(launcher, /ALL_PROXY/);
  assert.match(launcher, /host\.docker\.internal/);
  assert.match(launcher, /docker compose up -d --build/);
  assert.match(wrapper, /deploy\.ps1/);
});

test('Unix launcher preserves direct mode when no proxy is configured', () => {
  const launcher = fs.readFileSync('deploy.sh', 'utf8');
  assert.match(launcher, /PHPAY_PROXY/);
  assert.match(launcher, /host\.docker\.internal/);
  assert.match(launcher, /Direct connection/);
  assert.match(launcher, /docker compose up -d --build/);
});
