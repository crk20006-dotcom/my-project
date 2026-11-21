import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { isLocalInferenceUrlSafe } from '../ai/interfaces.ts';
import { inspectGenesisCheckpointOnDisk } from '../ai/adapters.ts';
import { closeDb, getDb, runInTransaction } from '../db.ts';
import { createApiRouter } from '../routes/api.ts';
import {
  ArxivSearchAdapter,
  WikipediaSearchAdapter,
  fetchPublicUrlOrFeed,
  parseHtmlDocument,
  parseRssOrAtomFeed,
  validateExternalPublicUrl,
} from '../research/worldIntelligence.ts';
import { clearBufferedLogs, logSystemEvent } from '../system/logger.ts';

describe('Project Genesis Express API & Security Corrections', () => {
  let tmpDir = '';
  let server: http.Server;
  let baseUrl = '';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-test-'));
    process.env.GENESIS_DB_PATH = path.join(tmpDir, 'genesis.test.db');
    closeDb();

    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use('/api', createApiRouter());

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    closeDb();
    delete process.env.GENESIS_DB_PATH;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects 0.0.0.0 and external hosts in local inference SSRF guard', () => {
    assert.equal(isLocalInferenceUrlSafe('http://127.0.0.1:8080').valid, true);
    assert.equal(isLocalInferenceUrlSafe('http://localhost:8080').valid, true);
    assert.equal(isLocalInferenceUrlSafe('http://0.0.0.0:8080').valid, false);
    assert.equal(isLocalInferenceUrlSafe('https://example.com/v1').valid, false);
  });

  it('fixes GET /conversations/:id/messages binding and isolates conversation histories', async () => {
    const convARes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Conv A' }),
    });
    assert.equal(convARes.status, 201);
    const convA = (await convARes.json()) as { id: string };

    const convBRes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Conv B' }),
    });
    assert.equal(convBRes.status, 201);
    const convB = (await convBRes.json()) as { id: string };

    const msgARes = await fetch(`${baseUrl}/api/conversations/${convA.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Alpha specific prompt', attachments: [] }),
    });
    assert.equal(msgARes.status, 201);

    const msgBRes = await fetch(`${baseUrl}/api/conversations/${convB.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Beta specific prompt', attachments: [] }),
    });
    assert.equal(msgBRes.status, 201);

    const listARes = await fetch(`${baseUrl}/api/conversations/${convA.id}/messages`);
    assert.equal(listARes.status, 200);
    const listA = (await listARes.json()) as Array<{ conversation_id: string; content: string }>;
    assert.equal(listA.length, 2);
    assert.ok(listA.every((m) => m.conversation_id === convA.id));
    assert.equal(listA[0].content, 'Alpha specific prompt');

    const listBRes = await fetch(`${baseUrl}/api/conversations/${convB.id}/messages`);
    assert.equal(listBRes.status, 200);
    const listB = (await listBRes.json()) as Array<{ conversation_id: string; content: string }>;
    assert.equal(listB.length, 2);
    assert.ok(listB.every((m) => m.conversation_id === convB.id));
    assert.equal(listB[0].content, 'Beta specific prompt');
  });

  it('validates attachment limits and previewText length bounds', async () => {
    const convRes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Attachment Bounds Test' }),
    });
    const conv = (await convRes.json()) as { id: string };

    // > 10 attachments rejected
    const eleven = Array.from({ length: 11 }, (_, i) => ({
      id: `att-${i}`,
      name: `file-${i}.txt`,
      size: 128,
      mimeType: 'text/plain',
      extension: '.txt',
      validated: true,
    }));
    const tooManyRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'too many', attachments: eleven }),
    });
    assert.equal(tooManyRes.status, 400);

    // previewText > 4000 chars rejected
    const longPreviewRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'long preview',
        attachments: [
          {
            id: 'att-long',
            name: 'notes.md',
            size: 5000,
            mimeType: 'text/markdown',
            extension: '.md',
            previewText: 'x'.repeat(4001),
            validated: true,
          },
        ],
      }),
    });
    assert.equal(longPreviewRes.status, 400);

    // disallowed extension rejected
    const badExtRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'bad ext',
        attachments: [
          {
            id: 'att-bad',
            name: 'malware.exe',
            size: 100,
            mimeType: 'application/octet-stream',
            extension: '.exe',
            validated: true,
          },
        ],
      }),
    });
    assert.equal(badExtRes.status, 400);
  });

  it('returns created_at on PUT /research/:id and atomically increments creator version', async () => {
    const createResearch = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Study 1', summary: 'Initial' }),
    });
    assert.equal(createResearch.status, 201);
    const createdProj = (await createResearch.json()) as { id: string; created_at: string };

    const updateResearch = await fetch(`${baseUrl}/api/research/${createdProj.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Study 1 Updated', summary: 'Updated' }),
    });
    assert.equal(updateResearch.status, 200);
    const updatedProj = (await updateResearch.json()) as { created_at?: string; title: string };
    assert.equal(updatedProj.created_at, createdProj.created_at);
    assert.equal(updatedProj.title, 'Study 1 Updated');

    const createArt = await fetch(`${baseUrl}/api/creator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Spec', artifact_type: 'markdown', language: 'markdown', content: 'v1' }),
    });
    const art = (await createArt.json()) as { id: string; version: number };
    assert.equal(art.version, 1);

    const upd1 = await fetch(`${baseUrl}/api/creator/${art.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Spec', artifact_type: 'markdown', language: 'markdown', content: 'v2' }),
    });
    const art2 = (await upd1.json()) as { version: number };
    assert.equal(art2.version, 2);

    const upd2 = await fetch(`${baseUrl}/api/creator/${art.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Spec', artifact_type: 'markdown', language: 'markdown', content: 'v3' }),
    });
    const art3 = (await upd2.json()) as { version: number };
    assert.equal(art3.version, 3);
  });

  it('rolls back failed multi-step writes cleanly with runInTransaction', () => {
    const db = getDb();
    const convId = 'conv-rollback-test';
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO conversations (id, title, module, model_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(convId, 'Rollback Test', 'chat', 'genesis-core-placeholder', now, now);

    assert.throws(() => {
      runInTransaction(db, () => {
        db.prepare(
          'INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run('msg-fail-1', convId, 'user', 'Should roll back', '[]', '{}', now);
        throw new Error('Simulated write failure');
      });
    }, /Simulated write failure/);

    const countRow = db
      .prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?')
      .get(convId) as { c: number };
    assert.equal(countRow.c, 0);
  });

  it('enforces server-side session auth, passcode verification on changes, logout, expiry, and rate limiting', async () => {
    // Reject short passcode (< 6 chars)
    const shortPassRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_auth_enabled: true, new_passcode: '1234' }),
    });
    assert.equal(shortPassRes.status, 400);

    // Enable auth with valid passcode
    const enableRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local_auth_enabled: true, new_passcode: 'genesis-secret-99' }),
    });
    assert.equal(enableRes.status, 200);
    const enableData = (await enableRes.json()) as { session_token?: string; local_auth_enabled: boolean };
    assert.equal(enableData.local_auth_enabled, true);
    assert.ok(enableData.session_token && enableData.session_token.length >= 32);

    // Public endpoints still respond cleanly without session
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const authStatusUnauth = await fetch(`${baseUrl}/api/auth/status`);
    assert.equal(authStatusUnauth.status, 200);
    const statusBody = (await authStatusUnauth.json()) as { authenticated: boolean; local_auth_enabled: boolean };
    assert.equal(statusBody.local_auth_enabled, true);
    assert.equal(statusBody.authenticated, false);

    // Private endpoints reject unauthenticated access with 401
    for (const [method, url] of [
      ['GET', '/api/conversations'],
      ['GET', '/api/conversations/search?q=test'],
      ['GET', '/api/memory'],
      ['GET', '/api/memory/status'],
      ['GET', '/api/knowledge'],
      ['POST', '/api/retrieval/query'],
      ['GET', '/api/agent-tools'],
      ['GET', '/api/agent-tasks'],
      ['GET', '/api/agent-history'],
      ['GET', '/api/settings'],
      ['GET', '/api/settings/export-db'],
      ['POST', '/api/settings/reset'],
    ] as const) {
      const r = await fetch(`${baseUrl}${url}`, { method });
      assert.equal(r.status, 401, `Expected 401 for unauthenticated ${method} ${url}`);
    }

    // Logout revokes initial session token
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${enableData.session_token}` },
    });
    assert.equal(logoutRes.status, 200);

    const revokedCheck = await fetch(`${baseUrl}/api/conversations`, {
      headers: { Authorization: `Bearer ${enableData.session_token}` },
    });
    assert.equal(revokedCheck.status, 401);

    // Verify passcode establishes a real server session (both cookie and Bearer work)
    const unlockRes = await fetch(`${baseUrl}/api/settings/verify-passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'genesis-secret-99' }),
    });
    assert.equal(unlockRes.status, 200);
    const unlockData = (await unlockRes.json()) as { unlocked: boolean; session_token: string };
    assert.equal(unlockData.unlocked, true);
    const setCookieHeader = unlockRes.headers.get('set-cookie') || '';
    assert.ok(setCookieHeader.includes('genesis_session='));
    assert.ok(setCookieHeader.toLowerCase().includes('httponly'));

    const cookiePair = setCookieHeader.split(';')[0];
    const cookieAuthedRes = await fetch(`${baseUrl}/api/settings`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(cookieAuthedRes.status, 200);

    // Changing/disabling auth without current_passcode is rejected (403)
    const disableNoPassRes = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${unlockData.session_token}`,
      },
      body: JSON.stringify({ local_auth_enabled: false }),
    });
    assert.equal(disableNoPassRes.status, 403);

    // Expired session in SQLite is rejected (401)
    const db = getDb();
    db.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    const expiredRes = await fetch(`${baseUrl}/api/conversations`, {
      headers: { Authorization: `Bearer ${unlockData.session_token}` },
    });
    assert.equal(expiredRes.status, 401);

    // Rate limiter blocks after 5 failed passcode attempts with 429 + Retry-After
    for (let i = 0; i < 5; i++) {
      const failRes = await fetch(`${baseUrl}/api/settings/verify-passcode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: `wrong-attempt-${i}` }),
      });
      assert.equal(failRes.status, 401);
    }

    const throttledRes = await fetch(`${baseUrl}/api/settings/verify-passcode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: 'genesis-secret-99' }),
    });
    assert.equal(throttledRes.status, 429);
    assert.ok(Number(throttledRes.headers.get('retry-after')) >= 1);
  });
});

describe('Project Genesis Step 04 — Inference Engine, Streaming & Mocked Local Server', () => {
  let tmpDir = '';
  let server: http.Server;
  let baseUrl = '';
  let mockLlmServer: http.Server;
  let mockLlmUrl = '';

  let mockMode: 'normal' | 'sse' | 'slow_sse' | 'invalid_json' | 'http_500' = 'normal';
  type CapturedChatRequest = {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  };
  let lastCapturedRequest: CapturedChatRequest | null = null;
  const getCapturedRequest = (): CapturedChatRequest | null => lastCapturedRequest;
  let slowStreamAbortedByServer = false;

  before(async () => {
    // 1. Mocked OpenAI-compatible local inference server on 127.0.0.1:0 (NOT a real AI model)
    mockLlmServer = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', slots_idle: 1 }));
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-local-qwen-7b.gguf' }] }));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        lastCapturedRequest = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof lastCapturedRequest;

        if (mockMode === 'http_500') {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'simulated inference crash' }));
          return;
        }
        if (mockMode === 'invalid_json') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{not-valid-json');
          return;
        }
        if (mockMode === 'sse') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          const tokens = ['Hello ', 'from ', 'mock ', 'local ', 'SSE!'];
          for (const tok of tokens) {
            res.write(
              `data: ${JSON.stringify({
                model: 'mock-local-qwen-7b.gguf',
                choices: [{ delta: { content: tok }, finish_reason: null }],
              })}\n\n`
            );
            await new Promise((r) => setTimeout(r, 10));
          }
          res.write(
            `data: ${JSON.stringify({
              model: 'mock-local-qwen-7b.gguf',
              choices: [{ delta: {}, finish_reason: 'stop' }],
              usage: { prompt_tokens: 12, completion_tokens: 5 },
            })}\n\n`
          );
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        if (mockMode === 'slow_sse') {
          slowStreamAbortedByServer = false;
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          });
          req.on('close', () => {
            slowStreamAbortedByServer = true;
          });
          res.write(
            `data: ${JSON.stringify({
              model: 'mock-local-qwen-7b.gguf',
              choices: [{ delta: { content: 'Partial chunk 1. ' } }],
            })}\n\n`
          );
          await new Promise((r) => setTimeout(r, 40));
          if (!res.destroyed) {
            res.write(
              `data: ${JSON.stringify({
                model: 'mock-local-qwen-7b.gguf',
                choices: [{ delta: { content: 'Partial chunk 2. ' } }],
              })}\n\n`
            );
          }
          // Hold open until caller cancels or test timeout finishes
          for (let i = 0; i < 30; i++) {
            if (slowStreamAbortedByServer || res.destroyed) break;
            await new Promise((r) => setTimeout(r, 50));
          }
          if (!res.destroyed) res.end();
          return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'mock-local-qwen-7b.gguf',
            choices: [{ message: { content: 'Mocked local completion ok.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 4 },
          })
        );
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => {
      mockLlmServer.listen(0, '127.0.0.1', () => resolve());
    });
    const llmAddr = mockLlmServer.address() as { port: number };
    mockLlmUrl = `http://127.0.0.1:${llmAddr.port}`;

    // 2. Fresh Express + isolated SQLite DB
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-step04-'));
    process.env.GENESIS_DB_PATH = path.join(tmpDir, 'genesis.step04.db');
    closeDb();

    const app = express();
    app.use(express.json({ limit: '4mb' }));
    app.use('/api', createApiRouter());

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      mockLlmServer.close((err) => (err ? reject(err) : resolve()));
    });
    closeDb();
    delete process.env.GENESIS_DB_PATH;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('validates loopback SSRF on PUT /api/models/:id and probes mocked local server model identity', async () => {
    const blocked = await fetch(`${baseUrl}/api/models/local-inference-http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_url: 'https://api.openai.com' }),
    });
    assert.equal(blocked.status, 400);

    const zeroBlocked = await fetch(`${baseUrl}/api/models/local-inference-http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_url: 'http://0.0.0.0:8080' }),
    });
    assert.equal(zeroBlocked.status, 400);

    const updated = await fetch(`${baseUrl}/api/models/local-inference-http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_url: mockLlmUrl, context_length: 1024 }),
    });
    assert.equal(updated.status, 200);
    const updatedModel = (await updated.json()) as { endpoint_url: string; context_length: number };
    assert.equal(updatedModel.endpoint_url, mockLlmUrl);
    assert.equal(updatedModel.context_length, 1024);

    const probeRes = await fetch(`${baseUrl}/api/models/local-inference-http/probe`, {
      method: 'POST',
    });
    assert.equal(probeRes.status, 200);
    const probe = (await probeRes.json()) as {
      reachable: boolean;
      status: string;
      server_model: string;
      detected_models: string[];
    };
    assert.equal(probe.reachable, true);
    assert.equal(probe.status, 'connected');
    assert.equal(probe.server_model, 'mock-local-qwen-7b.gguf');
    assert.deepEqual(probe.detected_models, ['mock-local-qwen-7b.gguf']);
  });

  it('rejects unknown model_id (404), packs context history to limit, and forwards inference params', async () => {
    const badConv = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Bad Model', model_id: 'nonexistent-model' }),
    });
    assert.equal(badConv.status, 404);

    const convRes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Mocked Inference Thread', model_id: 'local-inference-http' }),
    });
    assert.equal(convRes.status, 201);
    const conv = (await convRes.json()) as { id: string; model_id: string };
    assert.equal(conv.model_id, 'local-inference-http');

    // Insert long old messages directly to test context truncation against context_length=1024
    const db = getDb();
    const longFiller = 'word '.repeat(280);
    const t0 = new Date(Date.now() - 5000).toISOString();
    const t1 = new Date(Date.now() - 4000).toISOString();
    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('old-1', conv.id, 'user', `OLD_DROPPED_1 ${longFiller}`, '[]', '{}', t0);
    db.prepare(
      'INSERT INTO messages (id, conversation_id, role, content, attachments_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('old-2', conv.id, 'assistant', `OLD_DROPPED_2 ${longFiller}`, '[]', '{}', t1);

    mockMode = 'normal';
    const msgRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Latest short question',
        attachments: [],
        temperature: 0.65,
        max_tokens: 256,
        timeout_ms: 8000,
      }),
    });
    assert.equal(msgRes.status, 201);
    const payload = (await msgRes.json()) as {
      assistant_message: {
        content: string;
        metadata: { mode: string; truncated_messages: number; model_id: string };
      };
    };
    assert.equal(payload.assistant_message.content, 'Mocked local completion ok.');
    assert.equal(payload.assistant_message.metadata.mode, 'local_inference');
    assert.equal(payload.assistant_message.metadata.model_id, 'local-inference-http');
    assert.ok(payload.assistant_message.metadata.truncated_messages >= 1);
    assert.ok(lastCapturedRequest);
    assert.equal(lastCapturedRequest.temperature, 0.65);
    assert.equal(lastCapturedRequest.max_tokens, 256);
    assert.equal(lastCapturedRequest.messages?.some((m) => m.content.includes('OLD_DROPPED_1')), false);
    assert.equal(lastCapturedRequest.messages?.at(-1)?.content, 'Latest short question');

    // Placeholder switch keeps Demo Mode and does not call mocked HTTP server
    const switchRes = await fetch(`${baseUrl}/api/conversations/${conv.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_id: 'genesis-core-placeholder' }),
    });
    assert.equal(switchRes.status, 200);
    lastCapturedRequest = null;
    const demoMsgRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Placeholder check', attachments: [] }),
    });
    assert.equal(demoMsgRes.status, 201);
    const demoMsg = (await demoMsgRes.json()) as {
      assistant_message: { metadata: { mode: string; finish_reason: string; diagnostic: boolean } };
    };
    assert.equal(demoMsg.assistant_message.metadata.mode, 'demo');
    assert.equal(demoMsg.assistant_message.metadata.finish_reason, 'not_connected');
    assert.equal(demoMsg.assistant_message.metadata.diagnostic, true);
    assert.equal(lastCapturedRequest, null);
  });

  it('handles HTTP 500, invalid JSON, and unreachable endpoints without fabricating completions', async () => {
    const convRes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Failure Resilience', model_id: 'local-inference-http' }),
    });
    const conv = (await convRes.json()) as { id: string };

    mockMode = 'http_500';
    const err500 = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Trigger 500', attachments: [] }),
    });
    assert.equal(err500.status, 201);
    const body500 = (await err500.json()) as {
      assistant_message: { content: string; metadata: { mode: string; diagnostic: boolean } };
    };
    assert.equal(body500.assistant_message.metadata.mode, 'demo');
    assert.equal(body500.assistant_message.metadata.diagnostic, true);
    assert.match(body500.assistant_message.content, /HTTP 500/);

    mockMode = 'invalid_json';
    const errJson = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Trigger malformed JSON', attachments: [] }),
    });
    assert.equal(errJson.status, 201);
    const bodyJson = (await errJson.json()) as {
      assistant_message: { content: string; metadata: { mode: string; diagnostic: boolean } };
    };
    assert.equal(bodyJson.assistant_message.metadata.mode, 'demo');
    assert.match(bodyJson.assistant_message.content, /invalid JSON/i);

    // Unreachable local port test
    await fetch(`${baseUrl}/api/models/local-inference-http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_url: 'http://127.0.0.1:59999' }),
    });
    const errConn = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Trigger unreachable', attachments: [] }),
    });
    assert.equal(errConn.status, 201);
    const bodyConn = (await errConn.json()) as {
      assistant_message: { metadata: { mode: string; diagnostic: boolean } };
    };
    assert.equal(bodyConn.assistant_message.metadata.mode, 'demo');
    assert.equal(bodyConn.assistant_message.metadata.diagnostic, true);

    // Restore mockLlmUrl
    await fetch(`${baseUrl}/api/models/local-inference-http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_url: mockLlmUrl }),
    });
  });

  it('streams SSE deltas and persists partial output when cancelled mid-stream', async () => {
    const convRes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'SSE Streaming Thread', model_id: 'local-inference-http' }),
    });
    const conv = (await convRes.json()) as { id: string };

    // 1. Full SSE stream completion
    mockMode = 'sse';
    const streamRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Stream tokens please', attachments: [] }),
    });
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') || '', /text\/event-stream/);
    const rawSse = await streamRes.text();
    assert.match(rawSse, /event: start/);
    assert.match(rawSse, /event: delta/);
    assert.match(rawSse, /event: done/);
    assert.match(rawSse, /Hello from mock local SSE!/);

    // 2. Client abort cancellation persists partial response cleanly
    mockMode = 'slow_sse';
    const ac = new AbortController();
    const cancelRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages/stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'Start and cancel', attachments: [] }),
      signal: ac.signal,
    });
    assert.equal(cancelRes.status, 200);
    const reader = cancelRes.body!.getReader();
    const decoder = new TextDecoder();
    let seenChunk1 = false;
    while (!seenChunk1) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunkText = decoder.decode(value);
      if (chunkText.includes('Partial chunk 1.')) {
        seenChunk1 = true;
        ac.abort();
        break;
      }
    }
    assert.equal(seenChunk1, true);

    // Wait briefly for server on('close') transaction commit
    await new Promise((r) => setTimeout(r, 250));
    const listRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`);
    const msgs = (await listRes.json()) as Array<{
      role: string;
      content: string;
      metadata: { partial?: boolean; finish_reason?: string };
    }>;
    const cancelledAssistant = msgs.at(-1)!;
    assert.equal(cancelledAssistant.role, 'assistant');
    assert.match(cancelledAssistant.content, /Partial chunk 1\./);
    assert.equal(cancelledAssistant.metadata.finish_reason, 'cancelled');
    assert.equal(cancelledAssistant.metadata.partial, true);
  });

  it('reports untrained experimental Genesis Core status and inspects sidecar checkpoint metadata cleanly', async () => {
    const statusRes = await fetch(`${baseUrl}/api/genesis-core/status`);
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      experimental: boolean;
      trained: boolean;
      model_status: string;
      trained_steps: number;
      architecture: { class_name: string; tokenizer_class: string; presets: Record<string, unknown> };
    };
    assert.equal(status.experimental, true);
    assert.equal(status.trained, false);
    assert.equal(status.model_status, 'untrained_experimental');
    assert.equal(status.trained_steps, 0);
    assert.equal(status.architecture.class_name, 'GenesisCoreTransformer');
    assert.equal(status.architecture.tokenizer_class, 'GenesisByteBPETokenizer');
    assert.ok(status.architecture.presets.cpu_nano);

    // Verify local checkpoint + sidecar metadata detection without executing external APIs
    const tempCkptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-ckpt-'));
    try {
      const ptPath = path.join(tempCkptDir, 'latest.pt');
      const metaPath = path.join(tempCkptDir, 'latest.meta.json');
      fs.writeFileSync(ptPath, 'stub-pt');
      fs.writeFileSync(
        metaPath,
        JSON.stringify({
          experimental: true,
          trained_steps: 25,
          train_loss: 2.15,
          val_loss: 2.28,
        })
      );
      const inspected = inspectGenesisCheckpointOnDisk(ptPath, path.join(tempCkptDir, 'tokenizer.json'));
      assert.equal(inspected.experimental, true);
      assert.equal(inspected.checkpoint_exists, true);
      assert.equal(inspected.trained, true);
      assert.equal(inspected.model_status, 'experimental_trained');
      assert.equal(inspected.trained_steps, 25);
    } finally {
      fs.rmSync(tempCkptDir, { recursive: true, force: true });
    }
  });

  it('implements Memory & Knowledge CRUD, secret rejection, FTS5 search, DB restart persistence, auth, and chat inference integration', async () => {
    // 1. Memory create + privacy/secret guards + explicit approval requirement
    const unapproved = await fetch(`${baseUrl}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: 'semantic',
        category: 'fact',
        title: 'Unapproved Attempt',
        content: 'Should not save without approval.',
        tags: [],
        importance: 3,
        approved: false,
      }),
    });
    assert.equal(unapproved.status, 400);

    const secretRejected = await fetch(`${baseUrl}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: 'semantic',
        category: 'fact',
        title: 'Secret Leak Attempt',
        content: 'Use api_key=super_secret_value_12345 for deployment',
        tags: [],
        importance: 3,
        approved: true,
      }),
    });
    assert.equal(secretRejected.status, 400);

    const createdMemRes = await fetch(`${baseUrl}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: 'project',
        category: 'constraint',
        title: 'Genesis Runtime Constraint',
        content: 'Genesis platform targets Windows desktop hardware with 16 GB RAM budget.',
        tags: ['windows', 'hardware'],
        importance: 5,
        approved: true,
      }),
    });
    assert.equal(createdMemRes.status, 201);
    const createdMem = (await createdMemRes.json()) as { id: string; category: string; title: string };
    assert.equal(createdMem.category, 'constraint');

    // Update memory
    const updatedMemRes = await fetch(`${baseUrl}/api/memory/${createdMem.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Genesis Desktop RAM Constraint',
        content: 'Genesis runs CPU-first workflows cleanly within 16 GB Windows RAM.',
        importance: 5,
      }),
    });
    assert.equal(updatedMemRes.status, 200);
    const updatedMem = (await updatedMemRes.json()) as { title: string; content: string };
    assert.equal(updatedMem.title, 'Genesis Desktop RAM Constraint');

    // 2. Knowledge Base create (chunking) + secret guard + search + update + delete
    const kbSecret = await fetch(`${baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Bad Credentials Note',
        source_type: 'note',
        content: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA',
        tags: [],
      }),
    });
    assert.equal(kbSecret.status, 400);

    const longGuide = [
      'Project Genesis runs FastAPI on loopback port 8000 and Express on port 3000.',
      'SQLite FTS5 provides lightweight keyword search over local knowledge documents without cloud vector databases.',
      'Additional operational notes: checkpoint artifacts live under data/checkpoints/genesis_core.',
    ].join('\n\n') + '\n\n' + 'Background details about Genesis modular adapters. '.repeat(25);

    const createdDocRes = await fetch(`${baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Genesis Architecture Handbook',
        source_type: 'markdown',
        source_name: 'handbook.md',
        content: longGuide,
        tags: ['architecture', 'sqlite'],
      }),
    });
    assert.equal(createdDocRes.status, 201);
    const createdDoc = (await createdDocRes.json()) as { id: string; chunk_count: number };
    assert.ok(createdDoc.chunk_count >= 2);

    // 3. Retrieval Query returns matching User Memory & Knowledge chunks, and returns empty on unrelated query
    const queryMatchRes = await fetch(`${baseUrl}/api/retrieval/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Windows RAM budget and FastAPI port 8000' }),
    });
    assert.equal(queryMatchRes.status, 200);
    const queryMatch = (await queryMatchRes.json()) as {
      memories: Array<{ id: string; title: string }>;
      knowledge: Array<{ document_id: string; document_title: string }>;
      formatted_context: string | null;
    };
    assert.ok(queryMatch.memories.some((m) => m.id === createdMem.id));
    assert.ok(queryMatch.knowledge.some((k) => k.document_id === createdDoc.id));
    assert.match(queryMatch.formatted_context || '', /\[Approved User Memory\]/);
    assert.match(queryMatch.formatted_context || '', /\[Knowledge Base Excerpts\]/);

    const noMatchRes = await fetch(`${baseUrl}/api/retrieval/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'xylophone nebula quasar' }),
    });
    const noMatch = (await noMatchRes.json()) as {
      memories: unknown[];
      knowledge: unknown[];
      formatted_context: string | null;
    };
    assert.equal(noMatch.memories.length, 0);
    assert.equal(noMatch.knowledge.length, 0);
    assert.equal(noMatch.formatted_context, null);

    // 4. Restart / DB close-and-reopen persistence verification
    closeDb();
    const reopenedMemRes = await fetch(`${baseUrl}/api/memory?q=Desktop`);
    assert.equal(reopenedMemRes.status, 200);
    const reopenedMems = (await reopenedMemRes.json()) as Array<{ id: string }>;
    assert.ok(reopenedMems.some((m) => m.id === createdMem.id));

    // 5. Chat inference integration + strict separation from Conversation History
    const convRes = await fetch(`${baseUrl}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Memory Context Injection Test', model_id: 'local-inference-http' }),
    });
    const conv = (await convRes.json()) as { id: string };

    mockMode = 'normal';
    lastCapturedRequest = null;
    const chatRes = await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'What RAM limit applies on Windows and which port does FastAPI use?',
        attachments: [],
        use_memory: true,
        use_knowledge: true,
      }),
    });
    assert.equal(chatRes.status, 201);
    const chatPayload = (await chatRes.json()) as {
      assistant_message: {
        metadata: {
          memory_retrieval?: {
            queried: boolean;
            memories_used: Array<{ id: string }>;
            knowledge_used: Array<{ document_id: string }>;
          };
        };
      };
    };
    assert.equal(chatPayload.assistant_message.metadata.memory_retrieval?.queried, true);
    assert.ok(
      chatPayload.assistant_message.metadata.memory_retrieval?.memories_used.some(
        (m) => m.id === createdMem.id
      )
    );
    assert.ok(
      chatPayload.assistant_message.metadata.memory_retrieval?.knowledge_used.some(
        (k) => k.document_id === createdDoc.id
      )
    );
    assert.ok(
      getCapturedRequest()?.messages?.some(
        (m) =>
          m.role === 'system' &&
          m.content.includes('Genesis Desktop RAM Constraint') &&
          m.content.includes('FastAPI on loopback port 8000')
      )
    );

    // Ensure regular chat turn was NOT auto-saved into User Memory, yet IS searchable in Conversation History
    const allMemoriesAfterChat = (await (await fetch(`${baseUrl}/api/memory`)).json()) as Array<{
      content: string;
    }>;
    assert.equal(
      allMemoriesAfterChat.some((m) => m.content.includes('What RAM limit applies on Windows')),
      false
    );

    const convSearchRes = await fetch(
      `${baseUrl}/api/conversations/search?q=${encodeURIComponent('RAM limit applies')}`
    );
    assert.equal(convSearchRes.status, 200);
    const convSearchBody = (await convSearchRes.json()) as {
      matches: Array<{ conversation_id: string; snippet: string }>;
    };
    assert.ok(convSearchBody.matches.some((m) => m.conversation_id === conv.id));

    // Toggle use_memory/use_knowledge off prevents system injection
    lastCapturedRequest = null;
    await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: 'Windows RAM budget and FastAPI port 8000 again',
        attachments: [],
        use_memory: false,
        use_knowledge: false,
      }),
    });
    assert.equal(getCapturedRequest()?.messages?.some((m) => m.role === 'system'), false);

    // 6. Status endpoint + Knowledge/Memory delete cleans up FTS indexes
    const statusRes = await fetch(`${baseUrl}/api/memory/status`);
    assert.equal(statusRes.status, 200);
    const memStatus = (await statusRes.json()) as {
      total_memories: number;
      total_knowledge_docs: number;
      auto_save_disabled: boolean;
    };
    assert.ok(memStatus.total_memories >= 1);
    assert.ok(memStatus.total_knowledge_docs >= 1);
    assert.equal(memStatus.auto_save_disabled, true);

    assert.equal((await fetch(`${baseUrl}/api/knowledge/${createdDoc.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await fetch(`${baseUrl}/api/memory/${createdMem.id}`, { method: 'DELETE' })).status, 200);

    const afterDelete = (await (
      await fetch(`${baseUrl}/api/retrieval/query`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'Windows RAM budget and FastAPI port 8000' }),
      })
    ).json()) as { memories: unknown[]; knowledge: unknown[] };
    assert.equal(afterDelete.memories.length, 0);
    assert.equal(afterDelete.knowledge.length, 0);
  });

  it('orchestrates Step 07 Agent OS (planning, memory context, approval gating, sandbox security, history, and chat settings)', async () => {
    const { AgentToolRegistry } = await import('../agent/toolRegistry.ts');
    const { TaskExecutionEngine } = await import('../agent/taskExecutor.ts');
    const { TaskStateManager } = await import('../agent/taskStateManager.ts');
    const { AgentResultReporter } = await import('../agent/resultReporter.ts');

    // 1. Tool registry lists operational tools and reserved future stubs
    const toolsRes = await fetch(`${baseUrl}/api/agent-tools`);
    assert.equal(toolsRes.status, 200);
    const tools = (await toolsRes.json()) as Array<{
      id: string;
      operational: boolean;
      requires_approval: boolean;
      risk_level: string;
    }>;
    assert.ok(tools.some((t) => t.id === 'read_workspace_file' && t.operational && !t.requires_approval));
    assert.ok(tools.some((t) => t.id === 'create_document' && t.operational && t.requires_approval));
    assert.ok(tools.some((t) => t.id === 'run_restricted_code' && t.operational && t.requires_approval));
    assert.ok(tools.some((t) => t.id === 'web_search_future' && !t.operational && t.risk_level === 'reserved_stub'));
    assert.ok(tools.some((t) => t.id === 'world_intelligence_future' && !t.operational));

    // 2. Agent registration strips reserved future stubs and enforces sandbox policy
    const createAgentRes = await fetch(`${baseUrl}/api/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Step 07 Test Orchestrator',
        role: 'Verification Operator',
        description: 'Automated Step 07 test agent.',
        allowed_tools: [
          'retrieve_memory',
          'retrieve_knowledge',
          'read_workspace_file',
          'local_workspace_ops',
          'run_restricted_code',
          'create_document',
          'web_search_future',
        ],
        sandbox_policy: { max_steps: 6 },
      }),
    });
    assert.equal(createAgentRes.status, 201);
    const agent = (await createAgentRes.json()) as {
      id: string;
      allowed_tools: string[];
      sandbox_policy: { allow_network: boolean; allow_shell_execution: boolean; allow_filesystem_write: boolean };
    };
    assert.equal(agent.allowed_tools.includes('web_search_future'), false);
    assert.equal(agent.sandbox_policy.allow_network, false);
    assert.equal(agent.sandbox_policy.allow_shell_execution, false);
    assert.equal(agent.sandbox_policy.allow_filesystem_write, true);

    // 3. Seed approved memory + knowledge document for Agent planning integration
    const memRes = await fetch(`${baseUrl}/api/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        namespace: 'project',
        category: 'instruction',
        title: 'Agent Output Verification Format',
        content: 'Agent task reports should reference workspace validation metrics clearly.',
        tags: ['agent', 'verification'],
        importance: 5,
        approved: true,
      }),
    });
    assert.equal(memRes.status, 201);
    const mem = (await memRes.json()) as { id: string };

    const kbRes = await fetch(`${baseUrl}/api/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Agent Sandbox Architecture Spec',
        source_type: 'markdown',
        source_name: 'agent_spec.md',
        content: 'Genesis Agent OS workspace metrics and verification report guidelines require operator approval before document creation or code evaluation.',
        tags: ['agent', 'sandbox'],
      }),
    });
    assert.equal(kbRes.status, 201);
    const kb = (await kbRes.json()) as { id: string };

    // Secret detection on task creation
    const secretTaskRes = await fetch(`${baseUrl}/api/agent-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: agent.id,
        goal: 'Write api_key=sk-proj-secret1234567890abcdef into file',
      }),
    });
    assert.equal(secretTaskRes.status, 400);

    const uniqueReportName = `step07_test_report_${process.pid}.md`;
    const createdDocDiskPath = path.resolve(process.cwd(), 'data', 'agent_workspace', 'documents', uniqueReportName);

    try {
      // 4. Create & plan task
      const planRes = await fetch(`${baseUrl}/api/agent-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agent.id,
          title: 'Workspace Validation & Report Brief',
          goal: 'Inspect workspace validation metrics, compute total units, and create a verification report.',
          target_file_path: 'workspace_readme.txt',
          document_filename: uniqueReportName,
          code_snippet: 'const units = 6 * 7; console.log("computed", units); ({ total_units: units });',
          auto_run: false,
        }),
      });
      if (planRes.status !== 201) {
        console.error('PLAN RES ERROR:', await planRes.text());
      }
      assert.equal(planRes.status, 201);
      const planned = (await planRes.json()) as {
        task: {
          id: string;
          status: string;
          memory_context: { memories: Array<{ id: string }>; knowledge: Array<{ document_id: string }> };
        };
        steps: Array<{ id: string; tool_name: string; status: string; requires_approval: boolean }>;
      };
      assert.equal(planned.task.status, 'planned');
      assert.ok(planned.steps.length >= 4);
      assert.ok(planned.task.memory_context.memories.some((m) => m.id === mem.id));
      assert.ok(planned.task.memory_context.knowledge.some((k) => k.document_id === kb.id));

      // 5. Run task sequentially -> pauses at first consequential step (run_restricted_code)
      const firstRunRes = await fetch(`${baseUrl}/api/agent-tasks/${planned.task.id}/run`, { method: 'POST' });
      assert.equal(firstRunRes.status, 200);
      const afterFirstRun = (await firstRunRes.json()) as {
        task: { status: string };
        steps: Array<{ id: string; tool_name: string; status: string; approval_status: string }>;
      };
      if (afterFirstRun.task.status === 'failed') {
        const failTask = afterFirstRun as unknown as { task: { error_message: string }; steps: Array<{ error_message: string }> };
        console.error('NODE TASK FAILED:', failTask.task.error_message, failTask.steps.map(s => s.error_message));
      }
      assert.equal(afterFirstRun.task.status, 'awaiting_approval');
      const codeStep = afterFirstRun.steps.find((s) => s.tool_name === 'run_restricted_code')!;
      assert.equal(codeStep.status, 'awaiting_approval');
      assert.equal(codeStep.approval_status, 'pending');
      assert.equal(afterFirstRun.steps.find((s) => s.tool_name === 'read_workspace_file')?.status, 'completed');

      // 6. Approve code step -> executes VM snippet & pauses at create_document
      const approveCodeRes = await fetch(
        `${baseUrl}/api/agent-tasks/${planned.task.id}/steps/${codeStep.id}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true, note: 'Verified deterministic snippet', resume: true }),
        }
      );
      assert.equal(approveCodeRes.status, 200);
      const afterCodeApprove = (await approveCodeRes.json()) as {
        task: { status: string };
        steps: Array<{
          id: string;
          tool_name: string;
          status: string;
          output: { data?: { result?: string; stdout?: string[] } };
        }>;
      };
      const doneCodeStep = afterCodeApprove.steps.find((s) => s.id === codeStep.id)!;
      assert.equal(doneCodeStep.status, 'completed');
      assert.match(doneCodeStep.output.data?.result || '', /42/);
      assert.equal(afterCodeApprove.task.status, 'awaiting_approval');
      const docStep = afterCodeApprove.steps.find((s) => s.tool_name === 'create_document')!;
      assert.equal(docStep.status, 'awaiting_approval');

      // 7. Approve document creation -> writes document inside ./data/agent_workspace/documents & completes task
      const approveDocRes = await fetch(
        `${baseUrl}/api/agent-tasks/${planned.task.id}/steps/${docStep.id}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: true, note: 'Approved report file creation', resume: true }),
        }
      );
      assert.equal(approveDocRes.status, 200);
      const completedDetail = (await approveDocRes.json()) as {
        task: { status: string };
        report: {
          status: string;
          completed_steps: number;
          total_steps: number;
          artifacts_created: Array<{ path: string; bytes: number }>;
        };
        history: Array<{ event_type: string }>;
      };
      assert.equal(completedDetail.task.status, 'completed');
      assert.equal(completedDetail.report.completed_steps, completedDetail.report.total_steps);
      assert.ok(completedDetail.report.artifacts_created.some((art) => art.path.includes(uniqueReportName)));
      assert.equal(fs.existsSync(createdDocDiskPath), true);
      assert.ok(completedDetail.history.some((h) => h.event_type === 'plan_generated'));
      assert.ok(completedDetail.history.some((h) => h.event_type === 'approval_granted'));
      assert.ok(completedDetail.history.some((h) => h.event_type === 'task_completed'));

      // 8. Save task result to User Memory requires explicit approved: true
      const unapprovedMemSave = await fetch(`${baseUrl}/api/agent-tasks/${planned.task.id}/save-memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved: false, title: 'Blocked' }),
      });
      assert.equal(unapprovedMemSave.status, 400);

      const approvedMemSave = await fetch(`${baseUrl}/api/agent-tasks/${planned.task.id}/save-memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved: true,
          title: 'Step 07 Verification Outcome',
          category: 'fact',
          tags: ['agent-result', 'step-07'],
        }),
      });
      assert.equal(approvedMemSave.status, 201);
      const savedAgentMem = (await approvedMemSave.json()) as { id: string; title: string };
      assert.equal(savedAgentMem.title, 'Step 07 Verification Outcome');

      // 9. History endpoint lists audit entries
      const histRes = await fetch(`${baseUrl}/api/agent-history?task_id=${planned.task.id}`);
      assert.equal(histRes.status, 200);
      const histItems = (await histRes.json()) as Array<{ event_type: string }>;
      assert.ok(histItems.some((h) => h.event_type === 'memory_saved'));

      // 10. Rejection halts consequential execution cleanly & cancellation works
      const rejTaskRes = await fetch(`${baseUrl}/api/agent-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent_id: agent.id,
          goal: 'Evaluate expression',
          code_snippet: '2 + 2',
          auto_run: true,
        }),
      });
      assert.equal(rejTaskRes.status, 201);
      const rejDetail = (await rejTaskRes.json()) as {
        task: { id: string; status: string };
        steps: Array<{ id: string; status: string }>;
      };
      assert.equal(rejDetail.task.status, 'awaiting_approval');
      const awaitingStep = rejDetail.steps.find((s) => s.status === 'awaiting_approval')!;
      const rejectedRes = await fetch(
        `${baseUrl}/api/agent-tasks/${rejDetail.task.id}/steps/${awaitingStep.id}/approve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ approved: false, note: 'Declined by test' }),
        }
      );
      assert.equal(rejectedRes.status, 200);
      const afterReject = (await rejectedRes.json()) as { task: { status: string } };
      assert.equal(afterReject.task.status, 'failed');

      const cancelPlanRes = await fetch(`${baseUrl}/api/agent-tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agent.id, goal: 'Summarize workspace status', auto_run: false }),
      });
      const cancelPlanned = (await cancelPlanRes.json()) as { task: { id: string } };
      const cancelRes = await fetch(`${baseUrl}/api/agent-tasks/${cancelPlanned.task.id}/cancel`, { method: 'POST' });
      assert.equal(cancelRes.status, 200);
      assert.equal(((await cancelRes.json()) as { task: { status: string } }).task.status, 'cancelled');

      assert.equal(
        (await fetch(`${baseUrl}/api/agent-tasks/${cancelPlanned.task.id}`, { method: 'DELETE' })).status,
        200
      );

      // Clean up test memory & KB records
      await fetch(`${baseUrl}/api/memory/${savedAgentMem.id}`, { method: 'DELETE' });
      await fetch(`${baseUrl}/api/memory/${mem.id}`, { method: 'DELETE' });
      await fetch(`${baseUrl}/api/knowledge/${kb.id}`, { method: 'DELETE' });
    } finally {
      if (fs.existsSync(createdDocDiskPath)) {
        fs.unlinkSync(createdDocDiskPath);
      }
    }

    // 11. Unit checks for tool sandbox guards & safe retry logic using isolated workspace
    const sandboxTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-agent-sandbox-'));
    try {
      const registry = new AgentToolRegistry();
      const db = getDb();
      const allowedAll = registry.getOperationalToolIds();
      const ctx = { db, agentId: agent.id, taskId: 'task-unit', workspaceRoot: sandboxTmp };

      // Block traversal, .db, .env
      const trav = await registry.invoke('read_workspace_file', { path: '../../package.json' }, allowedAll, ctx);
      assert.equal(trav.ok, false);
      const dbBlock = await registry.invoke('read_workspace_file', { path: 'genesis.db' }, allowedAll, ctx);
      assert.equal(dbBlock.ok, false);
      const envBlock = await registry.invoke('read_workspace_file', { path: '.env' }, allowedAll, ctx);
      assert.equal(envBlock.ok, false);

      // Block require/process/fs/eval in restricted VM
      const requireBlock = await registry.invoke(
        'run_restricted_code',
        { code: 'require("fs").readFileSync("/etc/passwd")' },
        allowedAll,
        ctx
      );
      assert.equal(requireBlock.ok, false);
      const evalBlock = await registry.invoke(
        'run_restricted_code',
        { code: 'eval("1 + 1")' },
        allowedAll,
        ctx
      );
      assert.equal(evalBlock.ok, false);

      // Allowlist enforcement & reserved stub refusal
      const notAllowed = await registry.invoke('read_workspace_file', { path: 'workspace_readme.txt' }, ['health_check'], ctx);
      assert.equal(notAllowed.ok, false);
      const futureStub = await registry.invoke('web_search_future', { query: 'test' }, ['web_search_future'], ctx);
      assert.equal(futureStub.ok, false);

      // Safe retry execution engine check
      let flakyCalls = 0;
      registry.register({
        id: 'test_retryable_tool',
        name: 'Test Retryable Tool',
        category: 'local_app',
        description: 'Fails once transiently then succeeds.',
        risk_level: 'read_only',
        requires_approval: false,
        safe_retryable: true,
        operational: true,
        input_schema: { type: 'object', properties: {} },
        execute: () => {
          flakyCalls += 1;
          if (flakyCalls === 1) {
            return { ok: false, summary: 'Transient glitch', data: {}, error: 'Temporary busy', retryable: true };
          }
          return { ok: true, summary: 'Recovered on retry', data: { attempts: flakyCalls } };
        },
      });
      const stateMgr = new TaskStateManager();
      const executor = new TaskExecutionEngine(registry, stateMgr, new AgentResultReporter());
      const prevToolsRow = db.prepare('SELECT allowed_tools_json FROM agents WHERE id = ?').get(agent.id) as {
        allowed_tools_json: string;
      };
      db.prepare('UPDATE agents SET allowed_tools_json = ? WHERE id = ?').run(
        JSON.stringify([...agent.allowed_tools, 'test_retryable_tool']),
        agent.id
      );
      try {
        const retryTask = stateMgr.createTask(db, {
          agentId: agent.id,
          title: 'Retry Test',
          goal: 'Verify safe retry',
          planSteps: [
            {
              step_index: 0,
              title: 'Flaky Safe Op',
              description: 'Retries once',
              tool_name: 'test_retryable_tool',
              tool_input: {},
              requires_approval: false,
              safe_retryable: true,
            },
          ],
          memoryContext: { memories: [], knowledge: [] },
          maxRetries: 2,
        });
        const retryDone = await executor.executeTask(db, retryTask.task.id, { workspaceRoot: sandboxTmp });
        assert.equal(retryDone.task.status, 'completed');
        assert.equal(retryDone.steps[0].attempts, 2);
        const retryHist = stateMgr.listHistory(db, { taskId: retryTask.task.id });
        assert.ok(retryHist.some((h) => h.event_type === 'step_retried'));
      } finally {
        db.prepare('UPDATE agents SET allowed_tools_json = ? WHERE id = ?').run(
          prevToolsRow.allowed_tools_json,
          agent.id
        );
      }
    } finally {
      fs.rmSync(sandboxTmp, { recursive: true, force: true });
    }

    // 12. Chat settings (active_model_id, chat_use_memory, chat_use_knowledge) persist cleanly in Settings
    const updChatSettings = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        active_model_id: 'local-inference-http',
        chat_use_memory: false,
        chat_use_knowledge: true,
      }),
    });
    assert.equal(updChatSettings.status, 200);
    const savedChatSettings = (await updChatSettings.json()) as {
      active_model_id: string;
      chat_use_memory: boolean;
      chat_use_knowledge: boolean;
    };
    assert.equal(savedChatSettings.active_model_id, 'local-inference-http');
    assert.equal(savedChatSettings.chat_use_memory, false);
    assert.equal(savedChatSettings.chat_use_knowledge, true);
  });
});

describe('Project Genesis Step 09 — Creator Studio, Exports, Security & Integrations', () => {
  let tmpDir = '';
  let server: http.Server;
  let baseUrl = '';
  let mockLlmServer: http.Server;
  let mockLlmUrl = '';
  let lastAssistPrompt = '';
  const createdProjectIds: string[] = [];

  before(async () => {
    mockLlmServer = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          messages?: Array<{ role: string; content: string }>;
        };
        lastAssistPrompt = body.messages?.map((m) => `${m.role}:${m.content}`).join('\n') || '';
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            model: 'mock-creator-model.gguf',
            choices: [
              {
                message: { content: 'Local Creator Assist completion verified.' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 18, completion_tokens: 6 },
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });

    await new Promise<void>((resolve) => {
      mockLlmServer.listen(0, '127.0.0.1', () => resolve());
    });
    mockLlmUrl = `http://127.0.0.1:${(mockLlmServer.address() as { port: number }).port}`;

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-step09-'));
    process.env.GENESIS_DB_PATH = path.join(tmpDir, 'genesis.step09.db');
    closeDb();

    const app = express();
    app.use(express.json({ limit: '12mb' }));
    app.use('/api', createApiRouter());

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    for (const pid of createdProjectIds) {
      const dir = path.resolve(process.cwd(), 'data', 'creator_workspace', pid);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      mockLlmServer.close((err) => (err ? reject(err) : resolve()));
    });
    closeDb();
    delete process.env.GENESIS_DB_PATH;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('manages projects, files, overwrite protection (409), and revision restore', async () => {
    const seededRes = await fetch(`${baseUrl}/api/creator/projects`);
    assert.equal(seededRes.status, 200);
    const seededProjects = (await seededRes.json()) as Array<{ id: string; name: string }>;
    assert.ok(seededProjects.some((p) => p.id === 'proj-genesis-studio'));

    const resProj = (await (
      await fetch(`${baseUrl}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Zero-Copy Token Buffering Study',
          summary: 'Research notes on ring buffers for Windows CPU inference.',
          status: 'active',
          tags: ['windows', 'buffers'],
          notes: 'Prefer fixed capacity circular queues to avoid heap fragmentation.',
        }),
      })
    ).json()) as { id: string };

    const createProjRes = await fetch(`${baseUrl}/api/creator/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Creator Verification Project',
        description: 'End-to-end Step 09 test project',
        workspace_type: 'mixed',
        linked_research_id: resProj.id,
      }),
    });
    assert.equal(createProjRes.status, 201);
    const project = (await createProjRes.json()) as { id: string; linked_research_id: string };
    createdProjectIds.push(project.id);
    assert.equal(project.linked_research_id, resProj.id);

    // Create initial file
    const f1Res = await fetch(`${baseUrl}/api/creator/projects/${project.id}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'buffer_worker.py',
        kind: 'code',
        format: 'python',
        content: 'def version():\n    return 1\n',
      }),
    });
    assert.equal(f1Res.status, 201);
    const f1 = (await f1Res.json()) as { id: string; version: number };
    assert.equal(f1.version, 1);

    // Duplicate create without overwrite must fail with 409 OVERWRITE_CONFIRMATION_REQUIRED
    const dupRes = await fetch(`${baseUrl}/api/creator/projects/${project.id}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'buffer_worker.py',
        content: 'def version():\n    return 2\n',
      }),
    });
    assert.equal(dupRes.status, 409);
    const dupBody = (await dupRes.json()) as { code: string };
    assert.equal(dupBody.code, 'OVERWRITE_CONFIRMATION_REQUIRED');

    // Explicit overwrite succeeds & creates v2 revision
    const overwriteRes = await fetch(`${baseUrl}/api/creator/projects/${project.id}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'buffer_worker.py',
        content: 'def version():\n    return 2\n',
        overwrite: true,
      }),
    });
    assert.equal(overwriteRes.status, 200);
    const f1v2 = (await overwriteRes.json()) as { version: number };
    assert.equal(f1v2.version, 2);

    const revs = (await (
      await fetch(`${baseUrl}/api/creator/files/${f1.id}/revisions`)
    ).json()) as Array<{ id: string; version: number; content: string }>;
    assert.equal(revs.length, 2);
    const rev1 = revs.find((r) => r.version === 1)!;

    const restoreRes = await fetch(`${baseUrl}/api/creator/files/${f1.id}/restore/${rev1.id}`, {
      method: 'POST',
    });
    assert.equal(restoreRes.status, 200);
    const restored = (await restoreRes.json()) as { version: number; content: string };
    assert.equal(restored.version, 3);
    assert.match(restored.content, /return 1/);
  });

  it('analyzes multi-language code statically and runs approval-gated JS sandbox securely', async () => {
    const pyAnalysis = (await (
      await fetch(`${baseUrl}/api/creator/code/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: 'python',
          code: 'def load_cfg():\n \tpass\ntry:\n    load_cfg()\nexcept:\n    pass\n',
        }),
      })
    ).json()) as { diagnostics: Array<{ rule: string }>; sandbox_runnable: boolean };
    assert.equal(pyAnalysis.sandbox_runnable, false);
    assert.ok(pyAnalysis.diagnostics.some((d) => d.rule === 'py-indentation'));
    assert.ok(pyAnalysis.diagnostics.some((d) => d.rule === 'py-bare-except'));

    const tsAnalysis = (await (
      await fetch(`${baseUrl}/api/creator/code/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: 'typescript',
          code: 'export function parse(val: any) { return val; }',
        }),
      })
    ).json()) as { diagnostics: Array<{ rule: string }> };
    assert.ok(tsAnalysis.diagnostics.some((d) => d.rule === 'ts-no-any'));

    const cAnalysis = (await (
      await fetch(`${baseUrl}/api/creator/code/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: 'c',
          code: '#include <stdlib.h>\nint main() { char *b = malloc(16); strcpy(b, "hi"); return 0; }',
        }),
      })
    ).json()) as { diagnostics: Array<{ rule: string }> };
    assert.ok(cAnalysis.diagnostics.some((d) => d.rule === 'c-bounded-buffers'));
    assert.ok(cAnalysis.diagnostics.some((d) => d.rule === 'c-memory-lifecycle'));

    for (const [lang, sample] of [
      ['cpp', '#include <iostream>\nint main() { std::cout << 1; return 0; }'],
      ['html', '<main><h1>Hi</h1></main>'],
      ['css', '.panel { color: #fff; }'],
    ] as const) {
      const r = await fetch(`${baseUrl}/api/creator/code/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: lang, code: sample }),
      });
      assert.equal(r.status, 200);
    }

    const jsErr = (await (
      await fetch(`${baseUrl}/api/creator/code/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'javascript', code: 'const x = (;' }),
      })
    ).json()) as { diagnostics: Array<{ rule: string }>; sandbox_runnable: boolean };
    assert.equal(jsErr.sandbox_runnable, true);
    assert.ok(jsErr.diagnostics.some((d) => d.rule === 'js-vm-parse'));

    const unapproved = await fetch(`${baseUrl}/api/creator/code/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'javascript', code: '1 + 2', approved: false }),
    });
    assert.equal(unapproved.status, 400);

    const blockedPythonRun = await fetch(`${baseUrl}/api/creator/code/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ language: 'python', code: 'print(1)', approved: true }),
    });
    assert.equal(blockedPythonRun.status, 400);

    const blockedProcess = (await (
      await fetch(`${baseUrl}/api/creator/code/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: 'javascript', code: 'process.exit(1)', approved: true }),
      })
    ).json()) as { ok: boolean; error?: string };
    assert.equal(blockedProcess.ok, false);

    const validRun = (await (
      await fetch(`${baseUrl}/api/creator/code/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          language: 'javascript',
          code: 'const sum = [2, 4, 6].reduce((a, b) => a + b, 0); console.log("total", sum); sum;',
          approved: true,
        }),
      })
    ).json()) as { ok: boolean; stdout: string[]; result: string };
    assert.equal(validRun.ok, true);
    assert.deepEqual(validRun.stdout, ['total 12']);
    assert.equal(validRun.result, '12');
  });

  it('exports real DOCX, PDF, MD, TXT, and PPTX binaries and round-trips DOCX/PPTX uploads', async () => {
    const JSZip = (await import('jszip')).default;
    const proj = (await (
      await fetch(`${baseUrl}/api/creator/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Export & Upload Suite', workspace_type: 'documents' }),
      })
    ).json()) as { id: string };
    createdProjectIds.push(proj.id);

    const sampleMd = [
      '# Genesis Architecture Report',
      '',
      '## System Summary',
      '',
      '- Offline SQLite persistence',
      '- Bounded JS VM execution',
      '',
      '1. Validate input schema',
      '2. Stream binary export',
      '',
      '| Component | Format | Status |',
      '| --- | --- | --- |',
      '| Document Studio | DOCX & PDF | Operational |',
      '',
      '```python',
      'print("ok")',
      '```',
    ].join('\n');

    const docxRes = await fetch(`${baseUrl}/api/creator/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        title: 'Genesis Architecture Report',
        export_format: 'docx',
        content: sampleMd,
        save_to_workspace: true,
      }),
    });
    assert.equal(docxRes.status, 200);
    const docxBuf = Buffer.from(await docxRes.arrayBuffer());
    assert.equal(docxBuf[0], 0x50);
    assert.equal(docxBuf[1], 0x4b);
    const docxZip = await JSZip.loadAsync(docxBuf);
    const docXml = await docxZip.file('word/document.xml')!.async('string');
    assert.match(docXml, /Genesis Architecture Report/);
    assert.match(docXml, /Document Studio/);

    const docxConflictRes = await fetch(`${baseUrl}/api/creator/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        title: 'Genesis Architecture Report',
        export_format: 'docx',
        content: sampleMd,
        save_to_workspace: true,
      }),
    });
    assert.equal(docxConflictRes.status, 409);

    const uploadDocxRes = await fetch(`${baseUrl}/api/creator/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        filename: 'reimported_brief.docx',
        encoding: 'base64',
        data: docxBuf.toString('base64'),
      }),
    });
    assert.equal(uploadDocxRes.status, 201);
    const uploadedDocx = (await uploadDocxRes.json()) as {
      type: string;
      file: { filename: string; content: string };
    };
    assert.equal(uploadedDocx.type, 'project_file');
    assert.equal(uploadedDocx.file.filename, 'reimported_brief.md');
    assert.match(uploadedDocx.file.content, /Genesis Architecture Report/);

    const pdfRes = await fetch(`${baseUrl}/api/creator/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Genesis Architecture Report',
        export_format: 'pdf',
        content: sampleMd,
      }),
    });
    assert.equal(pdfRes.status, 200);
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    assert.equal(pdfBuf.subarray(0, 5).toString('utf8'), '%PDF-');

    const mdText = await (
      await fetch(`${baseUrl}/api/creator/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Note', export_format: 'md', content: sampleMd }),
      })
    ).text();
    assert.match(mdText, /# Genesis Architecture Report/);

    const txtText = await (
      await fetch(`${baseUrl}/api/creator/export`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Note', export_format: 'txt', content: sampleMd }),
      })
    ).text();
    assert.match(txtText, /Document Studio \| DOCX & PDF \| Operational/);

    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const imgUploadRes = await fetch(`${baseUrl}/api/creator/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        filename: 'diagram_badge.png',
        encoding: 'base64',
        data: tinyPngBase64,
      }),
    });
    assert.equal(imgUploadRes.status, 200);
    const imgAsset = (await imgUploadRes.json()) as { type: string; dataUrl: string };
    assert.equal(imgAsset.type, 'image_asset');

    const pptxRes = await fetch(`${baseUrl}/api/creator/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Genesis Roadmap Deck',
        export_format: 'pptx',
        deck: {
          title: 'Genesis Roadmap Deck',
          subtitle: 'Step 09 Studio',
          author: 'Local Operator',
          theme: 'blueprint_blue',
          slides: [
            {
              id: 's1',
              layout: 'title',
              title: 'Project Genesis Deck',
              subtitle: 'Local Presentation Engine',
              bullets: ['Offline OpenXML export'],
            },
            {
              id: 's2',
              layout: 'diagram',
              title: 'Studio Data Flow',
              bullets: ['Deterministic layout'],
              diagram: {
                kind: 'architecture',
                nodes: [
                  { id: 'n1', label: 'Editor', role: 'React' },
                  { id: 'n2', label: 'Exporter', role: 'PptxGenJS' },
                ],
                edges: [{ from: 'n1', to: 'n2' }],
              },
            },
            {
              id: 's3',
              layout: 'title_content',
              title: 'Verified Visual Asset',
              bullets: ['PNG signature checked before embed'],
              image: { name: 'badge.png', mimeType: 'image/png', dataUrl: imgAsset.dataUrl },
            },
          ],
        },
      }),
    });
    assert.equal(pptxRes.status, 200);
    const pptxBuf = Buffer.from(await pptxRes.arrayBuffer());
    assert.equal(pptxBuf[0], 0x50);
    assert.equal(pptxBuf[1], 0x4b);
    const pptxZip = await JSZip.loadAsync(pptxBuf);
    assert.ok(pptxZip.file('ppt/slides/slide1.xml'));
    assert.ok(pptxZip.file('ppt/slides/slide2.xml'));
    assert.ok(pptxZip.file('ppt/slides/slide3.xml'));
    assert.ok(Object.keys(pptxZip.files).some((k) => k.startsWith('ppt/media/')));

    const importPptxRes = await fetch(`${baseUrl}/api/creator/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        filename: 'imported_deck.pptx',
        encoding: 'base64',
        data: pptxBuf.toString('base64'),
      }),
    });
    assert.equal(importPptxRes.status, 201);
    const importedPptx = (await importPptxRes.json()) as {
      file: { kind: string; content: string };
    };
    assert.equal(importedPptx.file.kind, 'presentation');
    assert.match(importedPptx.file.content, /Project Genesis Deck/);
  });

  it('enforces upload safety, authentication, and Genesis Memory/KB/Research/Lab/Agent integrations', async () => {
    const proj = (await (
      await fetch(`${baseUrl}/api/creator/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Integration & Security Project', workspace_type: 'mixed' }),
      })
    ).json()) as { id: string };
    createdProjectIds.push(proj.id);

    const blockedExt = await fetch(`${baseUrl}/api/creator/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        filename: 'payload.exe',
        encoding: 'utf8',
        data: 'MZ',
      }),
    });
    assert.equal(blockedExt.status, 400);

    const traversal = await fetch(`${baseUrl}/api/creator/projects/${proj.id}/files`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '../../evil.py', content: 'print(1)' }),
    });
    assert.equal(traversal.status, 400);

    const fakePng = await fetch(`${baseUrl}/api/creator/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        filename: 'spoofed.png',
        encoding: 'base64',
        data: Buffer.from('not-a-real-png').toString('base64'),
      }),
    });
    assert.equal(fakePng.status, 400);

    const mem = (await (
      await fetch(`${baseUrl}/api/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          namespace: 'project',
          category: 'constraint',
          title: 'Creator Memory Constraint',
          content: 'Keep Windows Step 09 Creator Studio modules memory-efficient under 16 GB RAM.',
          tags: ['creator', 'windows'],
          importance: 5,
          approved: true,
        }),
      })
    ).json()) as { id: string };

    const kb = (await (
      await fetch(`${baseUrl}/api/knowledge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Creator Module Architecture',
          source_type: 'markdown',
          source_name: 'creator_arch.md',
          content: 'Creator Studio connects Code, Document, and Presentation builders to local SQLite persistence.',
          tags: ['creator'],
        }),
      })
    ).json()) as { id: string };

    const research = (await (
      await fetch(`${baseUrl}/api/research`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: 'Creator Offline Export Benchmarks',
          summary: 'Benchmarks for docx, pdf-lib, and pptxgenjs on Windows desktop CPUs.',
          status: 'active',
          tags: ['benchmarks'],
          notes: 'Pure JS OpenXML packing takes < 80ms.',
        }),
      })
    ).json()) as { id: string };

    const lab = (await (
      await fetch(`${baseUrl}/api/laboratory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'prompt_template',
          name: 'Creator Technical Review Template',
          content: 'Evaluate architecture invariants, error handling, and memory bounds.',
          schema_json: '{}',
          metrics: {},
        }),
      })
    ).json()) as { id: string };

    const demoAssist = (await (
      await fetch(`${baseUrl}/api/creator/assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace: 'coding',
          action: 'explain',
          language: 'python',
          title: 'Creator Benchmark',
          goal: 'Windows Creator Studio memory architecture',
          content: 'def run():\n    return True\n',
          research_id: research.id,
          laboratory_item_id: lab.id,
        }),
      })
    ).json()) as {
      mode: string;
      context_used: {
        memories: Array<{ id: string }>;
        knowledge: Array<{ document_id: string }>;
        research_title: string;
        laboratory_template: string;
      };
    };
    assert.equal(demoAssist.mode, 'demo');
    assert.ok(demoAssist.context_used.memories.some((m) => m.id === mem.id));
    assert.ok(demoAssist.context_used.knowledge.some((k) => k.document_id === kb.id));
    assert.equal(demoAssist.context_used.research_title, 'Creator Offline Export Benchmarks');
    assert.equal(demoAssist.context_used.laboratory_template, 'Creator Technical Review Template');

    await fetch(`${baseUrl}/api/models/local-inference-http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_url: mockLlmUrl }),
    });
    const localAssist = (await (
      await fetch(`${baseUrl}/api/creator/assist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workspace: 'documents',
          action: 'draft',
          title: 'Creator Windows Brief',
          goal: 'Windows Creator Studio architecture',
          model_id: 'local-inference-http',
          research_id: research.id,
          laboratory_item_id: lab.id,
        }),
      })
    ).json()) as { mode: string; inference_output: string };
    assert.equal(localAssist.mode, 'local_inference');
    assert.equal(localAssist.inference_output, 'Local Creator Assist completion verified.');
    assert.match(lastAssistPrompt, /Creator Memory Constraint/);
    assert.match(lastAssistPrompt, /Creator Offline Export Benchmarks/);

    const cFile = (await (
      await fetch(`${baseUrl}/api/creator/projects/${proj.id}/files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'metrics_helper.js',
          kind: 'code',
          format: 'javascript',
          content: 'const total = 10 + 5;\nconsole.log(total);\ntotal;\n',
        }),
      })
    ).json()) as { id: string };

    const unapprovedSave = await fetch(`${baseUrl}/api/creator/files/${cFile.id}/save-memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false }),
    });
    assert.equal(unapprovedSave.status, 400);

    const memSaveRes = await fetch(`${baseUrl}/api/creator/files/${cFile.id}/save-memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, title: 'Creator Metrics Helper' }),
    });
    assert.equal(memSaveRes.status, 201);

    const kbSaveRes = await fetch(`${baseUrl}/api/creator/files/${cFile.id}/save-knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Creator Metrics Spec' }),
    });
    assert.equal(kbSaveRes.status, 201);

    const dispatchRes = await fetch(`${baseUrl}/api/creator/files/${cFile.id}/dispatch-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Verify metrics helper inside Agent OS' }),
    });
    assert.equal(dispatchRes.status, 201);
    const dispatchedTask = (await dispatchRes.json()) as {
      task: { status: string; title: string };
      steps: Array<{ tool_name: string }>;
    };
    assert.equal(dispatchedTask.task.status, 'planned');
    assert.match(dispatchedTask.task.title, /metrics_helper\.js/);
    assert.ok(dispatchedTask.steps.length >= 2);

    const enableAuth = (await (
      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_auth_enabled: true, new_passcode: 'creator-pass-99' }),
      })
    ).json()) as { session_token: string };

    const unauthProj = await fetch(`${baseUrl}/api/creator/projects`);
    assert.equal(unauthProj.status, 401);

    const unauthExport = await fetch(`${baseUrl}/api/creator/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Locked', export_format: 'txt', content: 'hi' }),
    });
    assert.equal(unauthExport.status, 401);

    const authedProj = await fetch(`${baseUrl}/api/creator/projects`, {
      headers: { Authorization: `Bearer ${enableAuth.session_token}` },
    });
    assert.equal(authedProj.status, 200);
  });
});

function createValidPcmWavBuffer(durationSec = 1, sampleRate = 16000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = Math.floor(sampleRate * durationSec) * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

function createValidWebpVp8Buffer(width: number, height: number): Buffer {
  const buf = Buffer.alloc(32, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(24, 4);
  buf.write('WEBP', 8, 'ascii');
  buf.write('VP8 ', 12, 'ascii');
  buf.writeUInt32LE(12, 16);
  buf[23] = 0x9d;
  buf[24] = 0x01;
  buf[25] = 0x2a;
  buf.writeUInt16LE(width & 0x3fff, 26);
  buf.writeUInt16LE(height & 0x3fff, 28);
  return buf;
}

describe('Project Genesis Step 10 — Voice, Vision & Multimodal Intelligence', () => {
  let tmpDir = '';
  let server: http.Server;
  let baseUrl = '';
  let mockMultimodalServer: http.Server;
  let mockMultimodalUrl = '';
  let lastVisionPromptText = '';
  let lastLlmChatPrompt = '';
  let sttReceivedMultipart = false;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-step10-'));
    process.env.GENESIS_DB_PATH = path.join(tmpDir, 'genesis-step10.test.db');
    closeDb();

    mockMultimodalServer = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        if (req.url === '/v1/audio/transcriptions') {
          sttReceivedMultipart = bodyBuf.toString('utf-8').includes('RIFF');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              text: 'Local Whisper verified spoken transcript for Step 10.',
              language: 'en',
              segments: [{ start: 0, end: 1.0, text: 'Local Whisper verified spoken transcript for Step 10.' }],
            })
          );
          return;
        }

        if (req.url === '/tts') {
          const wav = createValidPcmWavBuffer(0.5, 16000);
          res.writeHead(200, { 'Content-Type': 'audio/wav' });
          res.end(wav);
          return;
        }

        if (req.url === '/v1/chat/completions') {
          const payload = JSON.parse(bodyBuf.toString('utf-8')) as {
            messages?: Array<{ content: unknown }>;
          };
          const firstMsgContent = payload.messages?.[0]?.content;
          if (Array.isArray(firstMsgContent)) {
            const textPart = firstMsgContent.find((p: { type?: string }) => p.type === 'text') as
              | { text?: string }
              | undefined;
            lastVisionPromptText = textPart?.text || '';
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                model: 'local-qwen-vl-mock',
                choices: [
                  {
                    message: {
                      content: 'Local Vision VQA detected a high-contrast schematic grid on light canvas.',
                    },
                  },
                ],
              })
            );
            return;
          }

          lastLlmChatPrompt = JSON.stringify(payload.messages || []);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              model: 'local-llm-multimodal',
              choices: [{ message: { content: 'Chat model synthesized multimodal PDF & PNG context.' } }],
            })
          );
          return;
        }

        res.writeHead(404);
        res.end();
      });
    });

    await new Promise<void>((resolve) => {
      mockMultimodalServer.listen(0, '127.0.0.1', () => resolve());
    });
    const mmAddr = mockMultimodalServer.address() as { port: number };
    mockMultimodalUrl = `http://127.0.0.1:${mmAddr.port}`;

    const app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api', createApiRouter());

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      mockMultimodalServer.close((err) => (err ? reject(err) : resolve()));
    });
    closeDb();
    delete process.env.GENESIS_DB_PATH;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports multimodal capabilities, extracts PDF, DOCX, TXT, and MD accurately, and enforces media validation', async () => {
    const statusRes = await fetch(`${baseUrl}/api/multimodal/status`);
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      ffmpeg_available: boolean;
      ocr_enabled: boolean;
      temp_files_pending: number;
      supported_formats: { images: string[]; documents: string[]; audio: string[] };
    };
    assert.equal(typeof status.ffmpeg_available, 'boolean');
    assert.equal(status.ocr_enabled, true);
    assert.equal(status.temp_files_pending, 0);
    assert.ok(status.supported_formats.documents.includes('.pdf'));
    assert.ok(status.supported_formats.documents.includes('.docx'));
    assert.ok(status.supported_formats.images.includes('.webp'));
    assert.ok(status.supported_formats.audio.includes('.wav'));

    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const page1 = pdfDoc.addPage([600, 400]);
    page1.drawText('Project Genesis Step 10 PDF Intelligence Verification', { x: 40, y: 340, size: 14, font });
    page1.drawText('Thermal efficiency rating 94.2 percent on local telemetry.', { x: 40, y: 300, size: 12, font });
    const pdfBytes = Buffer.from(await pdfDoc.save());

    const pdfProcRes = await fetch(`${baseUrl}/api/multimodal/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'telemetry_brief.pdf',
        mimeType: 'application/pdf',
        encoding: 'base64',
        data: pdfBytes.toString('base64'),
        save_asset: true,
      }),
    });
    assert.equal(pdfProcRes.status, 200);
    const pdfOut = (await pdfProcRes.json()) as {
      ok: boolean;
      asset_kind: string;
      asset_id: string;
      extracted_text: string;
      attachment: { previewText: string; mediaKind: string; validated: boolean };
    };
    assert.equal(pdfOut.ok, true);
    assert.equal(pdfOut.asset_kind, 'document');
    assert.ok(pdfOut.asset_id.startsWith('mm-'));
    assert.match(pdfOut.extracted_text, /Step 10 PDF Intelligence/);
    assert.match(pdfOut.extracted_text, /Thermal efficiency rating 94\.2/);
    assert.equal(pdfOut.attachment.mediaKind, 'document');
    assert.equal(pdfOut.attachment.validated, true);

    const { Document, Packer, Paragraph } = await import('docx');
    const wordDoc = new Document({
      sections: [
        {
          children: [
            new Paragraph({ text: 'Genesis Multimodal Specification' }),
            new Paragraph({ text: 'Supports DOCX extraction alongside PDF, TXT, and Markdown.' }),
          ],
        },
      ],
    });
    const docxBytes = await Packer.toBuffer(wordDoc);
    const docxOut = (await (
      await fetch(`${baseUrl}/api/multimodal/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'spec_sheet.docx',
          encoding: 'base64',
          data: docxBytes.toString('base64'),
        }),
      })
    ).json()) as { extracted_text: string; document_extraction: { format: string } };
    assert.equal(docxOut.document_extraction.format, 'docx');
    assert.match(docxOut.extracted_text, /Genesis Multimodal Specification/);

    const mdOut = (await (
      await fetch(`${baseUrl}/api/multimodal/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'notes.md',
          encoding: 'utf8',
          data: '# Sensor Architecture\n\n- Acoustic WAV pipeline\n- Tesseract WASM OCR\n',
        }),
      })
    ).json()) as { document_extraction: { metrics: { headings: number; lists: number } } };
    assert.equal(mdOut.document_extraction.metrics.headings, 1);
    assert.equal(mdOut.document_extraction.metrics.lists, 1);

    const traversalRes = await fetch(`${baseUrl}/api/multimodal/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: '../secret.txt', encoding: 'utf8', data: 'hi' }),
    });
    assert.equal(traversalRes.status, 400);

    const blockedExtRes = await fetch(`${baseUrl}/api/multimodal/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'runner.exe', encoding: 'base64', data: Buffer.from('MZ').toString('base64') }),
    });
    assert.equal(blockedExtRes.status, 400);

    const spoofedPdfRes = await fetch(`${baseUrl}/api/multimodal/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'fake.pdf',
        encoding: 'base64',
        data: Buffer.from('NOT_A_PDF_HEADER').toString('base64'),
      }),
    });
    assert.equal(spoofedPdfRes.status, 400);

    const assetsRes = await fetch(`${baseUrl}/api/multimodal/assets`);
    assert.equal(assetsRes.status, 200);
    const assets = (await assetsRes.json()) as Array<{ filename: string }>;
    assert.ok(assets.some((a) => a.filename === 'telemetry_brief.pdf'));
  });

  it('analyzes PNG & WEBP visuals, invokes Tesseract OCR gracefully, validates SSRF guards, and queries local Vision HTTP', async () => {
    const { PNG } = await import('pngjs');
    const png = new PNG({ width: 120, height: 80 });
    for (let y = 0; y < png.height; y += 1) {
      for (let x = 0; x < png.width; x += 1) {
        const idx = (png.width * y + x) << 2;
        const isGrid = x % 24 === 0 || y % 20 === 0;
        const val = isGrid ? 25 : 245;
        png.data[idx] = val;
        png.data[idx + 1] = val;
        png.data[idx + 2] = val;
        png.data[idx + 3] = 255;
      }
    }
    const pngBuf = PNG.sync.write(png);

    const imgRes = await fetch(`${baseUrl}/api/multimodal/analyze-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'schematic_grid.png',
        mimeType: 'image/png',
        dataBase64: pngBuf.toString('base64'),
        question: 'What kind of image structure is shown?',
        ocr_enabled: true,
        ocr_language: 'en-US',
      }),
    });
    assert.equal(imgRes.status, 200);
    const imgOut = (await imgRes.json()) as {
      ok: boolean;
      mode: string;
      metrics: { width: number; height: number; aspect_ratio: string; classification: string };
      ocr: { engine: string; ok: boolean };
      description: string;
    };
    assert.equal(imgOut.ok, true);
    assert.equal(imgOut.metrics.width, 120);
    assert.equal(imgOut.metrics.height, 80);
    assert.equal(imgOut.metrics.aspect_ratio, '3:2');
    assert.match(imgOut.description, /120x80 PNG/);
    assert.equal(imgOut.ocr.engine, 'tesseract.js');

    const webpBuf = createValidWebpVp8Buffer(64, 48);
    const webpOut = (await (
      await fetch(`${baseUrl}/api/multimodal/analyze-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'preview_card.webp',
          mimeType: 'image/webp',
          dataBase64: webpBuf.toString('base64'),
          ocr_enabled: true,
        }),
      })
    ).json()) as { metrics: { width: number; height: number; format: string }; ocr: { error?: string } };
    assert.equal(webpOut.metrics.format, 'webp');
    assert.equal(webpOut.metrics.width, 64);
    assert.equal(webpOut.metrics.height, 48);
    assert.match(webpOut.ocr.error || '', /Convert WEBP to PNG\/JPEG/);

    const badImg = await fetch(`${baseUrl}/api/multimodal/analyze-image`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'corrupt.png',
        dataBase64: Buffer.from('not-png').toString('base64'),
      }),
    });
    assert.equal(badImg.status, 400);

    for (const field of ['voice_stt_endpoint_url', 'voice_tts_endpoint_url', 'vision_endpoint_url']) {
      const badSettings = await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: 'https://remote-paid-cloud.example.com/api' }),
      });
      assert.equal(badSettings.status, 400);
    }

    const saveSettings = await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice_stt_language: 'es-ES',
        voice_tts_rate: 1.25,
        voice_auto_speak: true,
        ocr_enabled: false,
        vision_endpoint_url: mockMultimodalUrl,
        voice_stt_endpoint_url: mockMultimodalUrl,
        voice_tts_endpoint_url: `${mockMultimodalUrl}/tts`,
      }),
    });
    assert.equal(saveSettings.status, 200);
    const saved = (await saveSettings.json()) as {
      voice_stt_language: string;
      voice_tts_rate: number;
      voice_auto_speak: boolean;
      ocr_enabled: boolean;
    };
    assert.equal(saved.voice_stt_language, 'es-ES');
    assert.equal(saved.voice_tts_rate, 1.25);
    assert.equal(saved.voice_auto_speak, true);
    assert.equal(saved.ocr_enabled, false);

    const vqaOut = (await (
      await fetch(`${baseUrl}/api/multimodal/analyze-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'schematic_grid.png',
          mimeType: 'image/png',
          dataBase64: pngBuf.toString('base64'),
          question: 'Describe the grid layout.',
          ocr_enabled: false,
        }),
      })
    ).json()) as { mode: string; vqa_answer: string; vqa_model_name: string };
    assert.equal(vqaOut.mode, 'local_vision_http');
    assert.equal(vqaOut.vqa_model_name, 'local-qwen-vl-mock');
    assert.match(vqaOut.vqa_answer, /high-contrast schematic grid/);
    assert.match(lastVisionPromptText, /Describe the grid layout/);
  });

  it('processes WAV audio, verifies Whisper STT + Piper TTS loopback & fallbacks, and cleans up temp files', async () => {
    const wavBuf = createValidPcmWavBuffer(1, 16000);

    const sttOut = (await (
      await fetch(`${baseUrl}/api/multimodal/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'voice_memo.wav',
          mimeType: 'audio/wav',
          dataBase64: wavBuf.toString('base64'),
          language: 'en-US',
        }),
      })
    ).json()) as {
      ok: boolean;
      mode: string;
      transcript: string;
      acoustic: { sample_rate: number; channels: number; duration_sec: number };
    };
    assert.equal(sttOut.ok, true);
    assert.equal(sttOut.mode, 'local_whisper_http');
    assert.equal(sttReceivedMultipart, true);
    assert.equal(sttOut.transcript, 'Local Whisper verified spoken transcript for Step 10.');
    assert.equal(sttOut.acoustic.sample_rate, 16000);
    assert.equal(sttOut.acoustic.channels, 1);
    assert.equal(sttOut.acoustic.duration_sec, 1);

    const ttsOut = (await (
      await fetch(`${baseUrl}/api/multimodal/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Speak verification', speed: 1.1 }),
      })
    ).json()) as { ok: boolean; mode: string; mimeType: string; audioBase64: string };
    assert.equal(ttsOut.ok, true);
    assert.equal(ttsOut.mode, 'local_piper_http');
    assert.equal(ttsOut.mimeType, 'audio/wav');
    assert.equal(Buffer.from(ttsOut.audioBase64, 'base64').subarray(0, 4).toString('ascii'), 'RIFF');

    await fetch(`${baseUrl}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voice_stt_endpoint_url: '',
        voice_tts_endpoint_url: '',
        vision_endpoint_url: '',
      }),
    });

    const fallbackStt = (await (
      await fetch(`${baseUrl}/api/multimodal/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'voice_memo.wav',
          dataBase64: wavBuf.toString('base64'),
        }),
      })
    ).json()) as { ok: boolean; mode: string; acoustic: { sample_rate: number } };
    assert.equal(fallbackStt.ok, false);
    assert.equal(fallbackStt.mode, 'acoustic_only_no_stt_server');
    assert.equal(fallbackStt.acoustic.sample_rate, 16000);

    const fallbackTts = (await (
      await fetch(`${baseUrl}/api/multimodal/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Fallback voice check' }),
      })
    ).json()) as { ok: boolean; mode: string };
    assert.equal(fallbackTts.ok, false);
    assert.equal(fallbackTts.mode, 'browser_tts_fallback');

    const badWav = await fetch(`${baseUrl}/api/multimodal/transcribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: 'spoof.wav',
        dataBase64: Buffer.from('NOT_RIFF_DATA').toString('base64'),
      }),
    });
    assert.equal(badWav.status, 400);

    const statusAfter = (await (await fetch(`${baseUrl}/api/multimodal/status`)).json()) as {
      temp_files_pending: number;
    };
    assert.equal(statusAfter.temp_files_pending, 0);
  });

  it('integrates extracted media into Chat, Research, and Creator Studio (with overwrite confirmation) and enforces auth', async () => {
    const tinyPngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

    const procImg = (await (
      await fetch(`${baseUrl}/api/multimodal/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: 'chart_snapshot.png',
          mimeType: 'image/png',
          encoding: 'base64',
          data: tinyPngBase64,
          ocr_enabled: false,
        }),
      })
    ).json()) as {
      attachment: {
        id: string;
        name: string;
        size: number;
        mimeType: string;
        extension: string;
        previewText: string;
        imageDataUrl: string;
        mediaKind: string;
        validated: boolean;
      };
    };

    const conv = (await (
      await fetch(`${baseUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Multimodal Chat Context Test' }),
      })
    ).json()) as { id: string };

    const demoMsg = (await (
      await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Summarize the attached chart.',
          attachments: [procImg.attachment],
        }),
      })
    ).json()) as { assistant_message: { content: string } };
    assert.match(demoMsg.assistant_message.content, /Extracted Attachment & Media Context/);
    assert.match(demoMsg.assistant_message.content, /chart_snapshot\.png/);

    await fetch(`${baseUrl}/api/models/local-inference-http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_url: mockMultimodalUrl }),
    });
    const llmMsg = (await (
      await fetch(`${baseUrl}/api/conversations/${conv.id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: 'Analyze details in this attachment.',
          model_id: 'local-inference-http',
          attachments: [procImg.attachment],
        }),
      })
    ).json()) as { assistant_message: { content: string } };
    assert.equal(llmMsg.assistant_message.content, 'Chat model synthesized multimodal PDF & PNG context.');
    assert.match(lastLlmChatPrompt, /Attached Media & Document Extracts/);
    assert.match(lastLlmChatPrompt, /chart_snapshot\.png/);
    assert.match(lastLlmChatPrompt, /1x1 PNG/);

    const researchCreate = await fetch(`${baseUrl}/api/multimodal/send-to-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Multimodal Acoustic Findings',
        summary: 'Step 10 extraction test',
        source_name: 'chart_snapshot.png',
        content: 'Observed 1x1 calibration pixel fixture.',
      }),
    });
    assert.equal(researchCreate.status, 201);
    const createdStudy = (await researchCreate.json()) as { action: string; id: string; sources_count: number };
    assert.equal(createdStudy.action, 'created');
    assert.equal(createdStudy.sources_count, 1);

    const researchAppend = await fetch(`${baseUrl}/api/multimodal/send-to-research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        research_id: createdStudy.id,
        source_name: 'second_note.pdf',
        summary: 'Appended extraction',
        content: 'Second extracted technical paragraph.',
      }),
    });
    assert.equal(researchAppend.status, 200);
    const appendedStudy = (await researchAppend.json()) as { action: string; sources_count: number };
    assert.equal(appendedStudy.action, 'appended');
    assert.equal(appendedStudy.sources_count, 2);

    const projRes = await fetch(`${baseUrl}/api/creator/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Step 10 Media Handoff', workspace_type: 'documents' }),
    });
    const proj = (await projRes.json()) as { id: string };

    const creatorSave = await fetch(`${baseUrl}/api/multimodal/send-to-creator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        filename: 'extracted_brief.md',
        content: '# Extracted Brief\n\nInitial version.',
      }),
    });
    assert.equal(creatorSave.status, 201);
    const createdFile = (await creatorSave.json()) as { file: { id: string; version: number } };
    assert.equal(createdFile.file.version, 1);

    const creatorConflict = await fetch(`${baseUrl}/api/multimodal/send-to-creator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        filename: 'extracted_brief.md',
        content: '# Extracted Brief\n\nUpdated version.',
      }),
    });
    assert.equal(creatorConflict.status, 409);

    const creatorOverwrite = await fetch(`${baseUrl}/api/multimodal/send-to-creator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        project_id: proj.id,
        filename: 'extracted_brief.md',
        content: '# Extracted Brief\n\nUpdated version.',
        overwrite: true,
      }),
    });
    assert.equal(creatorOverwrite.status, 200);
    const updatedFile = (await creatorOverwrite.json()) as { file: { version: number } };
    assert.equal(updatedFile.file.version, 2);

    fs.rmSync(path.resolve(process.cwd(), 'data', 'creator_workspaces', proj.id), {
      recursive: true,
      force: true,
    });

    const authRes = (await (
      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_auth_enabled: true, new_passcode: 'mm-lock-2026' }),
      })
    ).json()) as { session_token: string };

    assert.equal((await fetch(`${baseUrl}/api/multimodal/status`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/multimodal/synthesize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'Unauthorized speak' }),
        })
      ).status,
      401
    );

    const authedStatus = await fetch(`${baseUrl}/api/multimodal/status`, {
      headers: { Authorization: `Bearer ${authRes.session_token}` },
    });
    assert.equal(authedStatus.status, 200);
  });
});

describe('Project Genesis Step 11 — Engineering & Scientific Intelligence', () => {
  let tmpDir = '';
  let server: http.Server;
  let baseUrl = '';
  let mockEngServer: http.Server;
  let mockEngModelUrl = '';
  let lastEngPrompt = '';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-step11-'));
    process.env.GENESIS_DB_PATH = path.join(tmpDir, 'genesis.test.db');
    closeDb();

    mockEngServer = http.createServer((req, res) => {
      const urlPath = req.url || '/';
      if (req.method === 'GET' && urlPath.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'eng-local-7b' }] }));
        return;
      }
      if (req.method === 'POST' && urlPath.startsWith('/v1/chat/completions')) {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', () => {
          lastEngPrompt = body;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              model: 'eng-local-7b',
              choices: [
                {
                  message: { role: 'assistant', content: 'Local engineering explanation grounded in ASME/Euler beam theory.' },
                  finish_reason: 'stop',
                },
              ],
            })
          );
        });
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
      mockEngServer.listen(0, '127.0.0.1', () => {
        const addr = mockEngServer.address() as { port: number };
        mockEngModelUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    const app = express();
    app.use(express.json({ limit: '16mb' }));
    app.use('/api', createApiRouter());

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      mockEngServer.close((err) => (err ? reject(err) : resolve()));
    });
    closeDb();
    delete process.env.GENESIS_DB_PATH;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exposes engineering status, 8 disciplines, material catalog, and unit conversions with bounds checks', async () => {
    const statusRes = await fetch(`${baseUrl}/api/engineering/status`);
    assert.equal(statusRes.status, 200);
    const status = (await statusRes.json()) as {
      operational: boolean;
      calculators: string[];
      disciplines_count: number;
      materials_count: number;
      simulation_tools: Array<{ id: string; available: boolean }>;
    };
    assert.equal(status.operational, true);
    assert.equal(status.calculators.length, 8);
    assert.equal(status.disciplines_count, 8);
    assert.ok(status.materials_count >= 8);
    const pyTool = status.simulation_tools.find((t) => t.id === 'python_stdlib');
    assert.ok(pyTool && pyTool.available === true);

    const discRes = (await (await fetch(`${baseUrl}/api/engineering/disciplines`)).json()) as {
      disciplines: Array<{ id: string; key_formulas: unknown[]; assumptions: string[] }>;
      materials: Array<{ id: string; yield_strength_mpa: number }>;
    };
    assert.equal(discRes.disciplines.length, 8);
    assert.ok(discRes.disciplines.every((d) => d.key_formulas.length >= 2 && d.assumptions.length >= 1));

    // Deterministic reference explanation when no external local server active
    const refExplain = (await (
      await fetch(`${baseUrl}/api/engineering/disciplines/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discipline_id: 'mechanical',
          question: 'When does Euler buckling formula apply?',
        }),
      })
    ).json()) as { mode: string; explanation: string };
    assert.equal(refExplain.mode, 'deterministic_reference');
    assert.match(refExplain.explanation, /Axial Normal Stress/);

    // Unit conversions
    const psiToMpa = (await (
      await fetch(`${baseUrl}/api/engineering/convert-units`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 100, from_unit: 'psi', to_unit: 'MPa' }),
      })
    ).json()) as { output_value: number };
    assert.ok(Math.abs(psiToMpa.output_value - 0.689476) < 1e-4);

    const rpmToRad = (await (
      await fetch(`${baseUrl}/api/engineering/convert-units`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 1200, from_unit: 'rpm', to_unit: 'rad/s' }),
      })
    ).json()) as { output_value: number };
    assert.ok(Math.abs(rpmToRad.output_value - 40 * Math.PI) < 1e-4);

    const degCToK = (await (
      await fetch(`${baseUrl}/api/engineering/convert-units`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: 100, from_unit: 'degC', to_unit: 'K' }),
      })
    ).json()) as { output_value: number };
    assert.ok(Math.abs(degCToK.output_value - 373.15) < 1e-6);

    const mismatch = await fetch(`${baseUrl}/api/engineering/convert-units`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: 10, from_unit: 'psi', to_unit: 'kW' }),
    });
    assert.equal(mismatch.status, 400);

    const absZeroErr = await fetch(`${baseUrl}/api/engineering/convert-units`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: -300, from_unit: 'degC', to_unit: 'K' }),
    });
    assert.equal(absZeroErr.status, 400);
  });

  it('runs all 8 engineering calculators with unit validation and independent conservation checks', async () => {
    const cases: Array<{
      calculator: string;
      inputs: Record<string, { value: number; unit?: string } | number>;
      assertFn: (res: {
        outputs: Array<{ key: string; value: number }>;
        independent_check: { passed: boolean };
        warnings: Array<{ code: string }>;
      }) => void;
    }> = [
      {
        calculator: 'stress_strain',
        inputs: {
          force: { value: 100, unit: 'kN' },
          area: { value: 250, unit: 'mm^2' },
          length: { value: 1, unit: 'm' },
          modulus: { value: 200, unit: 'GPa' },
          yield_strength: { value: 310, unit: 'MPa' },
        },
        assertFn: (r) => {
          const sigma = r.outputs.find((o) => o.key === 'stress_mpa')!;
          assert.ok(Math.abs(sigma.value - 400) < 1e-6); // 100e3 / 250e-6 = 400 MPa
          assert.ok(r.warnings.some((w) => w.code === 'YIELD_EXCEEDED'));
        },
      },
      {
        calculator: 'force_torque_power',
        inputs: {
          force: { value: 500, unit: 'N' },
          radius: { value: 0.2, unit: 'm' },
          speed: { value: 1500, unit: 'rpm' },
          efficiency: 0.9,
        },
        assertFn: (r) => {
          const torque = r.outputs.find((o) => o.key === 'torque_nm')!;
          assert.ok(Math.abs(torque.value - 100) < 1e-6);
          const pKw = r.outputs.find((o) => o.key === 'mech_power_kw')!;
          assert.ok(Math.abs(pKw.value - (100 * 50 * Math.PI) / 1000) < 1e-4);
        },
      },
      {
        calculator: 'motion_kinematics',
        inputs: {
          initial_velocity: { value: 10, unit: 'm/s' },
          acceleration: 2,
          time: { value: 5, unit: 's' },
          mass: { value: 10, unit: 'kg' },
        },
        assertFn: (r) => {
          const vf = r.outputs.find((o) => o.key === 'final_velocity')!;
          const dx = r.outputs.find((o) => o.key === 'displacement')!;
          assert.ok(Math.abs(vf.value - 20) < 1e-6);
          assert.ok(Math.abs(dx.value - 75) < 1e-6);
        },
      },
      {
        calculator: 'thermodynamics',
        inputs: {
          t_hot: { value: 600, unit: 'K' },
          t_cold: { value: 300, unit: 'K' },
          pressure: { value: 101.325, unit: 'kPa' },
          volume: { value: 0.05, unit: 'm^3' },
          moles: 2,
        },
        assertFn: (r) => {
          const eff = r.outputs.find((o) => o.key === 'carnot_efficiency_pct')!;
          assert.ok(Math.abs(eff.value - 50) < 1e-6);
        },
      },
      {
        calculator: 'fluid_flow_pressure',
        inputs: {
          diameter: { value: 50, unit: 'mm' },
          length: { value: 25, unit: 'm' },
          flow_rate: { value: 4, unit: 'L/s' },
          density: 998,
          viscosity: 0.001,
          roughness: { value: 0.045, unit: 'mm' },
        },
        assertFn: (r) => {
          const vel = r.outputs.find((o) => o.key === 'velocity')!;
          const re = r.outputs.find((o) => o.key === 'reynolds')!;
          assert.ok(Math.abs(vel.value - 0.004 / ((Math.PI * 0.05 * 0.05) / 4)) < 1e-5);
          assert.ok(re.value > 90000);
        },
      },
      {
        calculator: 'pump_compressor',
        inputs: {
          flow_rate: { value: 0.02, unit: 'm^3/s' },
          head: { value: 25, unit: 'm' },
          density: 1000,
          efficiency: 0.8,
        },
        assertFn: (r) => {
          const ph = r.outputs.find((o) => o.key === 'hydraulic_power_kw')!;
          const ps = r.outputs.find((o) => o.key === 'shaft_power_kw')!;
          assert.ok(Math.abs(ph.value - (1000 * 9.80665 * 0.02 * 25) / 1000) < 1e-5);
          assert.ok(Math.abs(ps.value - ph.value / 0.8) < 1e-5);
        },
      },
      {
        calculator: 'gear_shaft_design',
        inputs: {
          module_mm: 3,
          teeth_pinion: 20,
          teeth_gear: 60,
          torque: { value: 180, unit: 'N*m' },
          bending_moment: { value: 220, unit: 'N*m' },
          yield_strength: { value: 310, unit: 'MPa' },
          target_fos: 2.0,
        },
        assertFn: (r) => {
          const cd = r.outputs.find((o) => o.key === 'center_distance_mm')!;
          const dMin = r.outputs.find((o) => o.key === 'min_shaft_diameter_mm')!;
          assert.ok(Math.abs(cd.value - 120) < 1e-6);
          assert.ok(dMin.value > 25 && dMin.value < 60);
        },
      },
      {
        calculator: 'electrical_circuits',
        inputs: {
          voltage: { value: 120, unit: 'V' },
          frequency: { value: 50, unit: 'Hz' },
          resistance: { value: 24, unit: 'ohm' },
          inductance: { value: 20, unit: 'mH' },
          capacitance: { value: 100, unit: 'uF' },
        },
        assertFn: (r) => {
          const f0 = r.outputs.find((o) => o.key === 'resonant_hz')!;
          const expectedF0 = 1 / (2 * Math.PI * Math.sqrt(0.02 * 1e-4));
          assert.ok(Math.abs(f0.value - expectedF0) < 1e-4);
        },
      },
    ];

    for (const c of cases) {
      const res = await fetch(`${baseUrl}/api/engineering/calculate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ calculator: c.calculator, inputs: c.inputs }),
      });
      assert.equal(res.status, 200, `${c.calculator} failed`);
      const json = (await res.json()) as {
        outputs: Array<{ key: string; value: number }>;
        independent_check: { passed: boolean };
        warnings: Array<{ code: string }>;
        safety_notice: string;
      };
      assert.equal(json.independent_check.passed, true, `${c.calculator} independent check failed`);
      assert.match(json.safety_notice, /Professional Engineer/);
      c.assertFn(json);
    }

    // Invalid physical bounds
    const badThermo = await fetch(`${baseUrl}/api/engineering/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        calculator: 'thermodynamics',
        inputs: { t_hot: { value: 300, unit: 'K' }, t_cold: { value: 400, unit: 'K' } },
      }),
    });
    assert.equal(badThermo.status, 400);

    const history = (await (await fetch(`${baseUrl}/api/engineering/calculations`)).json()) as Array<{ id: string }>;
    assert.equal(history.length, 8);
  });

  it('computes verified symbolic calculus, numerical ODE/integration, linear algebra, root finding, and regression', async () => {
    const evalRes = (await (
      await fetch(`${baseUrl}/api/engineering/math`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'evaluate', params: { expression: '2 * sin(pi / 6) + 3^2' } }),
      })
    ).json()) as { result_value: number };
    assert.ok(Math.abs(evalRes.result_value - 10) < 1e-9);

    const derivRes = (await (
      await fetch(`${baseUrl}/api/engineering/math`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'derivative', params: { expression: 'x^3', variable: 'x', at: 2 } }),
      })
    ).json()) as {
      result_value: { value_at_point: number };
      verification: { passed: boolean };
      chart: { series: unknown[] };
    };
    assert.ok(Math.abs(derivRes.result_value.value_at_point - 12) < 1e-9);
    assert.equal(derivRes.verification.passed, true);
    assert.equal(derivRes.chart.series.length, 2);

    const intRes = (await (
      await fetch(`${baseUrl}/api/engineering/math`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'integral', params: { expression: 'x^2', variable: 'x', lower: 0, upper: 3 } }),
      })
    ).json()) as { result_value: number; verification: { passed: boolean } };
    assert.ok(Math.abs(intRes.result_value - 9) < 1e-6);
    assert.equal(intRes.verification.passed, true);

    const matRes = (await (
      await fetch(`${baseUrl}/api/engineering/math`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'matrix_solve',
          params: {
            A: [
              [3, 2, -1],
              [2, -2, 4],
              [-1, 0.5, -1],
            ],
            b: [1, -2, 0],
          },
        }),
      })
    ).json()) as { result_value: { solution_x: number[] }; verification: { passed: boolean } };
    assert.equal(matRes.verification.passed, true);
    assert.ok(Math.abs(matRes.result_value.solution_x[0] - 1) < 1e-6);
    assert.ok(Math.abs(matRes.result_value.solution_x[1] + 2) < 1e-6);
    assert.ok(Math.abs(matRes.result_value.solution_x[2] + 2) < 1e-6);

    const matAnalyze = (await (
      await fetch(`${baseUrl}/api/engineering/math`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'matrix_analyze',
          params: { A: [[4, 1], [2, 3]] },
        }),
      })
    ).json()) as { result_value: { determinant: number; trace: number; eigenvalues: number[] } };
    assert.ok(Math.abs(matAnalyze.result_value.determinant - 10) < 1e-6);
    assert.equal(matAnalyze.result_value.trace, 7);

    const odeRes = (await (
      await fetch(`${baseUrl}/api/engineering/math`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'ode_rk4', params: { rhs: 'y', t0: 0, y0: 1, t_end: 1, steps: 100 } }),
      })
    ).json()) as { result_value: { y_end: number }; verification: { passed: boolean }; chart: { series: Array<{ points: unknown[] }> } };
    assert.ok(Math.abs(odeRes.result_value.y_end - Math.E) < 1e-5);
    assert.equal(odeRes.verification.passed, true);
    assert.equal(odeRes.chart.series[0].points.length, 101);

    const rootRes = (await (
      await fetch(`${baseUrl}/api/engineering/math`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operation: 'root_find', params: { expression: 'x^2 - 2', variable: 'x', x_low: 1, x_high: 2 } }),
      })
    ).json()) as { result_value: number; verification: { passed: boolean } };
    assert.ok(Math.abs(rootRes.result_value - Math.SQRT2) < 1e-7);
    assert.equal(rootRes.verification.passed, true);

    const regRes = (await (
      await fetch(`${baseUrl}/api/engineering/math`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          operation: 'statistics_regression',
          params: { points: [{ x: 1, y: 3 }, { x: 2, y: 5 }, { x: 3, y: 7 }, { x: 4, y: 9 }] },
        }),
      })
    ).json()) as { result_value: { slope: number; intercept: number; r_squared: number } };
    assert.ok(Math.abs(regRes.result_value.slope - 2) < 1e-9);
    assert.ok(Math.abs(regRes.result_value.intercept - 1) < 1e-9);
    assert.ok(Math.abs(regRes.result_value.r_squared - 1) < 1e-9);
  });

  it('generates parametric SVGs, interprets drawing notes, runs sandboxed Python, and tracks research experiments', async () => {
    for (const kind of ['beam_load', 'shaft_step', 'pressure_vessel', 'rlc_circuit', 'pipe_system']) {
      const res = await fetch(`${baseUrl}/api/engineering/design/diagram`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind,
          params: { span_m: 6, load_kn: 18 },
          drawing_notes: 'ASME Y14.5 Third Angle Projection; Ø25 mm H7/g6 fit ±0.05 mm',
        }),
      });
      assert.equal(res.status, 200);
      const data = (await res.json()) as {
        svg: string;
        interpretation: { detected_standards: string[]; detected_tolerances: string[]; detected_dimensions: string[] };
      };
      assert.ok(data.svg.startsWith('<svg'));
      assert.equal(/<script/i.test(data.svg), false);
      assert.ok(data.interpretation.detected_standards.some((s) => s.includes('ASME Y14.5')));
      assert.ok(data.interpretation.detected_tolerances.some((t) => t.includes('H7/g6')));
    }

    // Python sandbox security checks
    const unapprovedSim = await fetch(`${baseUrl}/api/engineering/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: false, code: 'import math\nprint(math.pi)' }),
    });
    assert.equal(unapprovedSim.status, 400);

    const maliciousSim = await fetch(`${baseUrl}/api/engineering/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, code: 'import os\nprint(os.listdir("."))' }),
    });
    assert.equal(maliciousSim.status, 400);

    const presetsRes = (await (await fetch(`${baseUrl}/api/engineering/simulate/presets`)).json()) as {
      presets: Array<{ id: string; code: string }>;
    };
    const oscPreset = presetsRes.presets.find((p) => p.id === 'damped_oscillator')!;
    const okSimRes = await fetch(`${baseUrl}/api/engineering/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approved: true, code: oscPreset.code }),
    });
    assert.equal(okSimRes.status, 200);
    const simJson = (await okSimRes.json()) as {
      ok: boolean;
      chart: { series: Array<{ points: unknown[] }> };
    };
    assert.equal(simJson.ok, true);
    assert.equal(simJson.chart.series[0].points.length, 101);

    // Experiments CRUD & theoretical vs experimental error calculation
    const createExp = await fetch(`${baseUrl}/api/engineering/experiments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Cantilever Beam Deflection Lab',
        discipline: 'mechanical',
        objective: 'Validate Euler-Bernoulli deflection against dial indicator readings',
        established_facts: ['E_steel = 205 GPa (nominal)'],
        assumptions: ['Perfectly clamped root support'],
        hypothesis: 'Tip deflection scales linearly within 5% of PL^3 / 3EI',
        experimental_plan: 'Load tip from 50 N to 100 N in 2 steps',
        observations: [
          { label: '50 N Load', theoretical_value: 2.0, experimental_value: 2.1, unit: 'mm' },
          { label: '100 N Load', theoretical_value: 4.0, experimental_value: 4.2, unit: 'mm' },
        ],
        sources: [{ title: 'Shigley Mechanical Design', reference: 'Ch. 4 Beam Deflection' }],
      }),
    });
    assert.equal(createExp.status, 201);
    const createdExp = (await createExp.json()) as {
      id: string;
      comparison: { count: number; mean_pct_error: number };
    };
    assert.equal(createdExp.comparison.count, 2);
    assert.ok(Math.abs(createdExp.comparison.mean_pct_error - 5.0) < 1e-3);

    const updateExp = await fetch(`${baseUrl}/api/engineering/experiments/${createdExp.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hypothesis: 'Updated refined hypothesis' }),
    });
    assert.equal(updateExp.status, 200);

    const delExp = await fetch(`${baseUrl}/api/engineering/experiments/${createdExp.id}`, {
      method: 'DELETE',
    });
    assert.equal(delExp.status, 200);
  });

  it('exports reports (PDF/DOCX/MD/SVG), integrates all Genesis subsystems, and enforces auth lock', async () => {
    // Exports
    const pdfBuf = Buffer.from(
      await (
        await fetch(`${baseUrl}/api/engineering/export-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Beam Calc', format: 'pdf', markdown_content: '# Summary\n\nAll checks passed.' }),
        })
      ).arrayBuffer()
    );
    assert.equal(pdfBuf.subarray(0, 5).toString('ascii'), '%PDF-');

    const docxBuf = Buffer.from(
      await (
        await fetch(`${baseUrl}/api/engineering/export-report`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'Beam Calc', format: 'docx', markdown_content: '# Summary\n\nAll checks passed.' }),
        })
      ).arrayBuffer()
    );
    assert.equal(docxBuf.subarray(0, 2).toString('ascii'), 'PK');

    const svgText = await (
      await fetch(`${baseUrl}/api/engineering/export-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Beam Diagram', format: 'svg', svg_content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }),
      })
    ).text();
    assert.ok(svgText.startsWith('<svg'));

    // Memory integration (approval + secret guard)
    const memUnapproved = await fetch(`${baseUrl}/api/engineering/integrate/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Test', content: 'Value = 42', approved: false }),
    });
    assert.equal(memUnapproved.status, 400);

    const memOk = await fetch(`${baseUrl}/api/engineering/integrate/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Euler Buckling Constant',
        content: 'Critical buckling verified with K = 1.0 pinned-pinned.',
        approved: true,
      }),
    });
    assert.equal(memOk.status, 201);

    const kbOk = await fetch(`${baseUrl}/api/engineering/integrate/knowledge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'ASME Shaft Reference',
        content: 'Euler beam and ASME distortion energy shaft sizing specification note.',
      }),
    });
    assert.equal(kbOk.status, 201);

    // Local inference model explain with retrieved KB & Memory
    await fetch(`${baseUrl}/api/models/local-inference-http`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint_url: mockEngModelUrl }),
    });
    const localExplain = (await (
      await fetch(`${baseUrl}/api/engineering/disciplines/explain`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discipline_id: 'mechanical',
          model_id: 'local-inference-http',
          question: 'Review ASME distortion energy shaft and Euler buckling',
        }),
      })
    ).json()) as { mode: string; context_used: { memories: number; knowledge: number }; explanation: string };
    assert.equal(localExplain.mode, 'local_inference');
    assert.ok(localExplain.context_used.memories >= 1 || localExplain.context_used.knowledge >= 1);
    assert.match(lastEngPrompt, /ASME distortion energy|Euler/);

    // Research, Lab, Agent OS integrations
    const resInt = await fetch(`${baseUrl}/api/engineering/integrate/research`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Shaft Validation Study', notes: 'Static & fatigue checks.' }),
    });
    assert.equal(resInt.status, 201);

    const labInt = await fetch(`${baseUrl}/api/engineering/integrate/laboratory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Pipe Flow Benchmark', content: 'Re=101,800 Haaland verified.' }),
    });
    assert.equal(labInt.status, 201);

    const agentInt = await fetch(`${baseUrl}/api/engineering/integrate/agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ goal: 'Cross check RLC resonance memo', report_summary: 'f0 = 112.5 Hz' }),
    });
    assert.equal(agentInt.status, 201);

    // Creator overwrite protection
    const projRes = await fetch(`${baseUrl}/api/creator/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Step 11 Creator Integration', workspace_type: 'documents' }),
    });
    const proj = (await projRes.json()) as { id: string };

    const cSave1 = await fetch(`${baseUrl}/api/engineering/integrate/creator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: proj.id, filename: 'calc.md', content: '# V1' }),
    });
    assert.equal(cSave1.status, 201);

    const cConflict = await fetch(`${baseUrl}/api/engineering/integrate/creator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: proj.id, filename: 'calc.md', content: '# V2' }),
    });
    assert.equal(cConflict.status, 409);

    const cOverwrite = await fetch(`${baseUrl}/api/engineering/integrate/creator`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: proj.id, filename: 'calc.md', content: '# V2', overwrite: true }),
    });
    assert.equal(cOverwrite.status, 200);
    const cOverJson = (await cOverwrite.json()) as { file: { version: number } };
    assert.equal(cOverJson.file.version, 2);

    fs.rmSync(path.resolve(process.cwd(), 'data', 'creator_workspaces', proj.id), {
      recursive: true,
      force: true,
    });

    // Passcode auth enforcement
    const authRes = (await (
      await fetch(`${baseUrl}/api/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ local_auth_enabled: true, new_passcode: 'eng-lock-2026' }),
      })
    ).json()) as { session_token: string };

    assert.equal((await fetch(`${baseUrl}/api/engineering/status`)).status, 401);
    assert.equal(
      (
        await fetch(`${baseUrl}/api/engineering/status`, {
          headers: { Authorization: `Bearer ${authRes.session_token}` },
        })
      ).status,
      200
    );
  });
});

describe('Project Genesis Step 12 — Security, Reliability, World Intelligence & Deployment', () => {
  let tmpDir = '';
  let server: http.Server;
  let mockWorldServer: http.Server;
  let baseUrl = '';
  let mockWorldUrl = '';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-step12-test-'));
    process.env.GENESIS_DB_PATH = path.join(tmpDir, 'genesis.step12.db');
    closeDb();

    const app = express();
    app.disable('x-powered-by');
    app.use(express.json({ limit: '12mb' }));
    app.use('/api', createApiRouter());

    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const addr = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${addr.port}`;

    // Local HTTP fixture server simulating public Wikipedia, arXiv, RSS, and HTML responses
    const worldApp = express();
    worldApp.get('/w/api.php', (_req, res) => {
      res.json({
        query: {
          search: [
            {
              title: 'Thermofluid Mechanics',
              pageid: 9012,
              snippet: '<span>Conservation laws in fluid systems</span>',
              timestamp: '2026-03-15T10:30:00Z',
            },
          ],
        },
      });
    });
    worldApp.get('/arxiv/query', (_req, res) => {
      res.setHeader('Content-Type', 'application/atom+xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>arXiv Query: all:thermofluid</title>
  <entry>
    <id>http://arxiv.org/abs/2601.00042v1</id>
    <published>2026-01-05T08:00:00Z</published>
    <title>Compact Solver Benchmark on 16GB CPU Hosts</title>
    <summary>Deterministic fluid approximations with bounded memory footprint.</summary>
    <link href="https://arxiv.org/abs/2601.00042v1" rel="alternate" type="text/html"/>
  </entry>
</feed>`);
    });
    worldApp.get('/feed.rss', (_req, res) => {
      res.setHeader('Content-Type', 'application/rss+xml');
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Open Engineering Bulletin</title>
  <item>
    <title>ISO Tolerance Update</title>
    <link>https://standards.example.org/iso-286</link>
    <pubDate>Tue, 10 Feb 2026 12:00:00 GMT</pubDate>
    <description>Updated shaft and hole fit reference tables.</description>
  </item>
</channel></rss>`);
    });
    worldApp.get('/article.html', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.send(`<!doctype html><html><head>
        <title>Open Source Thermal Analysis</title>
        <meta property="article:published_time" content="2026-04-02T09:15:00Z" />
        <meta name="description" content="Benchmark reference for CPU-only heat conduction models." />
      </head><body><main><p>Verified finite-difference stencil on single workstation.</p></main></body></html>`);
    });

    mockWorldServer = await new Promise<http.Server>((resolve) => {
      const s = worldApp.listen(0, '127.0.0.1', () => resolve(s));
    });
    const wAddr = mockWorldServer.address() as { port: number };
    mockWorldUrl = `http://127.0.0.1:${wAddr.port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      mockWorldServer.close((err) => (err ? reject(err) : resolve()));
    });
    closeDb();
    delete process.env.GENESIS_DB_PATH;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('enforces defensive headers, CSRF Origin validation, and auth protection on Step 12 routes', async () => {
    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('cache-control'), 'no-store');
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('x-powered-by'), null);

    const healthJson = (await healthRes.json()) as {
      status: string;
      uptime_sec: number;
      hardware: { process_rss_mb: number };
      deployment: { lan_exposed: boolean };
      reliability: { error_count: number; warn_count: number };
    };
    assert.equal(healthJson.status, 'ok');
    assert.ok(healthJson.hardware.process_rss_mb > 0);
    assert.equal(typeof healthJson.deployment.lan_exposed, 'boolean');
    assert.equal(typeof healthJson.reliability.error_count, 'number');

    // Cross-origin mutation must be rejected with 403 CSRF_ORIGIN_MISMATCH
    const csrfBlocked = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://malicious.attacker.invalid',
      },
      body: JSON.stringify({ title: 'Untrusted Cross Origin Write' }),
    });
    assert.equal(csrfBlocked.status, 403);
    const csrfJson = (await csrfBlocked.json()) as { code: string };
    assert.equal(csrfJson.code, 'CSRF_ORIGIN_MISMATCH');

    // Complete first-run wizard enabling passcode protection
    const firstRunRes = await fetch(`${baseUrl}/api/settings/first-run`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operator_name: 'Step 12 Operator',
        prefer_local_inference: false,
        enable_local_auth: true,
        new_passcode: 'step12-vault-99',
      }),
    });
    assert.equal(firstRunRes.status, 200);
    const firstRunData = (await firstRunRes.json()) as {
      first_run_completed: boolean;
      local_auth_enabled: boolean;
      session_token?: string;
    };
    assert.equal(firstRunData.first_run_completed, true);
    assert.equal(firstRunData.local_auth_enabled, true);
    assert.ok(firstRunData.session_token && firstRunData.session_token.length >= 32);

    // Every new Step 12 private route must reject unauthenticated requests with 401
    for (const [method, endpoint] of [
      ['POST', '/api/system/integrity-check'],
      ['GET', '/api/system/logs'],
      ['GET', '/api/settings/export-sqlite'],
      ['POST', '/api/settings/restore-db'],
      ['GET', '/api/genesis-core/status'],
      ['GET', '/api/research/world/providers'],
      ['POST', '/api/research/world/search'],
      ['POST', '/api/research/world/fetch-url'],
    ] as const) {
      const r = await fetch(`${baseUrl}${endpoint}`, { method });
      assert.equal(r.status, 401, `Expected 401 on ${method} ${endpoint}`);
    }

    // Authenticated health probe & settings check
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${firstRunData.session_token}`,
    };
    const settingsRes = await fetch(`${baseUrl}/api/settings`, { headers: authHeaders });
    assert.equal(settingsRes.status, 200);
    const settingsJson = (await settingsRes.json()) as {
      operator_name: string;
      first_run_completed: boolean;
      passcode_hash?: string;
      passcode_salt?: string;
    };
    assert.equal(settingsJson.operator_name, 'Step 12 Operator');
    assert.equal(settingsJson.first_run_completed, true);
    assert.equal(settingsJson.passcode_hash, undefined);
    assert.equal(settingsJson.passcode_salt, undefined);
  });

  it('verifies SQLite integrity, schema migrations, binary .db export, atomic JSON restore, and redacted logs', async () => {
    const unlock = (await (
      await fetch(`${baseUrl}/api/settings/verify-passcode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: 'step12-vault-99' }),
      })
    ).json()) as { session_token: string };
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${unlock.session_token}`,
    };

    // Run integrity check & inspect migrations
    const integrityRes = await fetch(`${baseUrl}/api/system/integrity-check`, {
      method: 'POST',
      headers: authHeaders,
    });
    assert.equal(integrityRes.status, 200);
    const integrity = (await integrityRes.json()) as {
      ok: boolean;
      integrity_check: string[];
      foreign_key_violations: number;
      journal_mode: string;
      migrations_applied: Array<{ version: string; description: string }>;
    };
    assert.equal(integrity.ok, true);
    assert.deepEqual(integrity.integrity_check, ['ok']);
    assert.equal(integrity.foreign_key_violations, 0);
    assert.ok(integrity.migrations_applied.length >= 4);

    // Create a recoverable research project
    const createdProjRes = await fetch(`${baseUrl}/api/research`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        title: 'Recovery Validation Project',
        summary: 'Must survive delete + restore cycle',
        tags: ['recovery', 'step12'],
      }),
    });
    assert.equal(createdProjRes.status, 201);
    const createdProj = (await createdProjRes.json()) as { id: string; title: string };

    // Export binary SQLite .db snapshot (VACUUM INTO) & validate SQLite 3 magic header
    const sqliteBinRes = await fetch(`${baseUrl}/api/settings/export-sqlite`, { headers: authHeaders });
    assert.equal(sqliteBinRes.status, 200);
    assert.ok((sqliteBinRes.headers.get('content-disposition') || '').includes('.db'));
    const sqliteBytes = Buffer.from(await sqliteBinRes.arrayBuffer());
    assert.equal(sqliteBytes.subarray(0, 15).toString('ascii'), 'SQLite format 3');

    // Export JSON snapshot before deleting record
    const jsonBackupRes = await fetch(`${baseUrl}/api/settings/export-db`, { headers: authHeaders });
    assert.equal(jsonBackupRes.status, 200);
    const jsonSnapshot = (await jsonBackupRes.json()) as {
      research_projects: Array<{ id: string }>;
    };
    assert.ok(jsonSnapshot.research_projects.some((r) => r.id === createdProj.id));

    // Delete research project
    const delRes = await fetch(`${baseUrl}/api/research/${createdProj.id}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    assert.equal(delRes.status, 200);

    // Reject malformed restore payload safely with 400
    const badRestore = await fetch(`${baseUrl}/api/settings/restore-db`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ platform: 'invalid' }),
    });
    assert.equal(badRestore.status, 400);

    // Restore valid JSON snapshot & confirm project is recovered
    const restoreRes = await fetch(`${baseUrl}/api/settings/restore-db`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(jsonSnapshot),
    });
    assert.equal(restoreRes.status, 200);
    const restoreData = (await restoreRes.json()) as { restored: boolean; restored_tables: Record<string, number> };
    assert.equal(restoreData.restored, true);
    assert.ok(restoreData.restored_tables.research_projects >= 1);

    const listedResearch = (await (
      await fetch(`${baseUrl}/api/research`, { headers: authHeaders })
    ).json()) as Array<{ id: string; title: string }>;
    assert.ok(listedResearch.some((r) => r.id === createdProj.id && r.title === 'Recovery Validation Project'));

    // Structured logger redacts secrets & tokens cleanly
    clearBufferedLogs();
    logSystemEvent('info', 'security_audit', 'Bearer token check', {
      token: 'super-secret-value-999',
      authorization: 'Bearer abcdef1234567890abcdef',
      passcode: 'my-private-pass',
      safe_note: 'diagnostic-ok',
    });
    const logsRes = await fetch(`${baseUrl}/api/system/logs?limit=20`, { headers: authHeaders });
    assert.equal(logsRes.status, 200);
    const logsJson = (await logsRes.json()) as {
      logs: Array<{ category: string; message: string; detail?: string }>;
      summary: { total_buffered: number };
    };
    assert.ok(logsJson.summary.total_buffered >= 1);
    const serialized = JSON.stringify(logsJson.logs);
    assert.ok(!serialized.includes('super-secret-value-999'));
    assert.ok(!serialized.includes('my-private-pass'));
    assert.match(serialized, /\[REDACTED\]/);
  });

  it('reports Genesis Core independence diagnostics and enforces World Intelligence SSRF & attribution rules', async () => {
    const unlock = (await (
      await fetch(`${baseUrl}/api/settings/verify-passcode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: 'step12-vault-99' }),
      })
    ).json()) as { session_token: string };
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${unlock.session_token}`,
    };

    // Genesis Core status distinguishes operational vs untrained capabilities + 16GB RAM budget
    const coreRes = await fetch(`${baseUrl}/api/genesis-core/status`, { headers: authHeaders });
    assert.equal(coreRes.status, 200);
    const core = (await coreRes.json()) as {
      ram_budget_note: string;
      capabilities: { operational: string[]; experimental_untrained: string[] };
      architecture: { presets: Record<string, unknown> };
    };
    assert.match(core.ram_budget_note, /16 GB/);
    assert.ok(core.capabilities.operational.length >= 3);
    assert.ok(core.capabilities.experimental_untrained.length >= 2);
    assert.ok(Boolean(core.architecture.presets.cpu_nano));

    // World Intelligence providers endpoint
    const provRes = await fetch(`${baseUrl}/api/research/world/providers`, { headers: authHeaders });
    assert.equal(provRes.status, 200);
    const prov = (await provRes.json()) as {
      providers: Array<{ id: string; requires_api_key: boolean }>;
      ssrf_protection: boolean;
      rate_limit_per_minute: number;
    };
    assert.equal(prov.ssrf_protection, true);
    assert.equal(prov.rate_limit_per_minute, 20);
    assert.ok(prov.providers.every((p) => p.requires_api_key === false));

    // SSRF guard rejects private, loopback, metadata, internal DNS, and non-HTTP URLs
    for (const blockedUrl of [
      'http://127.0.0.1:3000/api/health',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.1/admin',
      'http://192.168.1.10/',
      'http://localhost:8080/',
      'file:///etc/passwd',
      'http://user:pass@example.com/',
    ]) {
      assert.equal(validateExternalPublicUrl(blockedUrl).valid, false, `Should reject ${blockedUrl}`);
    }
    assert.equal(validateExternalPublicUrl('https://arxiv.org/abs/2601.00042').valid, true);

    const ssrfRes = await fetch(`${baseUrl}/api/research/world/fetch-url`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });
    assert.equal(ssrfRes.status, 400);
    const ssrfJson = (await ssrfRes.json()) as { ok: boolean; error: string };
    assert.equal(ssrfJson.ok, false);
    assert.match(ssrfJson.error, /SSRF protection/);

    // Adapter tests against local HTTP fixture endpoints preserving publication dates & attribution
    const wikiAdapter = new WikipediaSearchAdapter({
      baseUrl: `${mockWorldUrl}/w/api.php`,
      bypassSsrfForTest: true,
    });
    const wikiOut = await wikiAdapter.search('thermofluid', 3);
    assert.equal(wikiOut.ok, true);
    assert.equal(wikiOut.results.length, 1);
    assert.equal(wikiOut.results[0].title, 'Thermofluid Mechanics');
    assert.equal(wikiOut.results[0].published_at, '2026-03-15T10:30:00.000Z');
    assert.ok(wikiOut.results[0].retrieved_at.length > 10);

    const arxivAdapter = new ArxivSearchAdapter({
      baseUrl: `${mockWorldUrl}/arxiv/query`,
      bypassSsrfForTest: true,
    });
    const arxivOut = await arxivAdapter.search('thermofluid', 3);
    assert.equal(arxivOut.ok, true);
    assert.equal(arxivOut.results[0].provider, 'arxiv');
    assert.equal(arxivOut.results[0].attribution, 'arXiv.org Open Access Archive');
    assert.equal(arxivOut.results[0].published_at, '2026-01-05T08:00:00.000Z');

    // RSS, HTML, and graceful offline error handling
    const rssOut = await fetchPublicUrlOrFeed(`${mockWorldUrl}/feed.rss`, { bypassSsrfForTest: true });
    assert.equal(rssOut.ok, true);
    assert.equal(rssOut.source_kind, 'rss');
    assert.equal(rssOut.items[0].title, 'ISO Tolerance Update');
    assert.equal(rssOut.items[0].published_at, '2026-02-10T12:00:00.000Z');

    const htmlOut = await fetchPublicUrlOrFeed(`${mockWorldUrl}/article.html`, { bypassSsrfForTest: true });
    assert.equal(htmlOut.ok, true);
    assert.equal(htmlOut.source_kind, 'html');
    assert.equal(htmlOut.title, 'Open Source Thermal Analysis');
    assert.equal(htmlOut.published_at, '2026-04-02T09:15:00.000Z');
    assert.match(htmlOut.text_excerpt, /finite-difference stencil/);

    const offlineAdapter = new WikipediaSearchAdapter({
      baseUrl: 'https://offline.invalid/w/api.php',
      fetcher: async () => {
        throw new Error('Network unreachable');
      },
    });
    const offlineOut = await offlineAdapter.search('test', 2);
    assert.equal(offlineOut.ok, false);
    assert.equal(offlineOut.network_available, false);
    assert.match(offlineOut.error || '', /Network unreachable/);

    // Direct unit checks for standalone RSS & HTML parsers
    const rssParsed = parseRssOrAtomFeed(
      '<rss><channel><title>Unit Feed</title><item><title>Doc 1</title><link>https://example.org/1</link></item></channel></rss>',
      'https://example.org/rss',
      '2026-05-01T00:00:00.000Z'
    );
    assert.equal(rssParsed.items[0].title, 'Doc 1');
    const htmlParsed = parseHtmlDocument(
      '<html><head><title>Unit Page</title></head><body><main>Hello Body</main></body></html>',
      'https://example.org/p',
      '2026-05-01T00:00:00.000Z'
    );
    assert.equal(htmlParsed.title, 'Unit Page');
    assert.equal(htmlParsed.excerpt, 'Hello Body');
  });

  it('meets fast local response latency targets across core, engineering, retrieval, and backup endpoints', async () => {
    const unlock = (await (
      await fetch(`${baseUrl}/api/settings/verify-passcode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: 'step12-vault-99' }),
      })
    ).json()) as { session_token: string };
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${unlock.session_token}`,
    };

    const timedCheck = async (label: string, fn: () => Promise<Response>) => {
      const t0 = performance.now();
      const res = await fn();
      const elapsedMs = performance.now() - t0;
      assert.equal(res.status, 200, `${label} returned non-200`);
      assert.ok(elapsedMs < 500, `${label} exceeded 500ms budget (${elapsedMs.toFixed(1)}ms)`);
    };

    await timedCheck('GET /api/health', () => fetch(`${baseUrl}/api/health`));
    await timedCheck('POST /api/engineering/calculate', () =>
      fetch(`${baseUrl}/api/engineering/calculate`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          calculator: 'stress_strain',
          inputs: { force: { value: 50, unit: 'kN' }, area: { value: 250, unit: 'mm^2' } },
        }),
      })
    );
    await timedCheck('POST /api/retrieval/query', () =>
      fetch(`${baseUrl}/api/retrieval/query`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ query: 'Project Genesis', max_memory_items: 3, max_knowledge_chunks: 3 }),
      })
    );
    await timedCheck('GET /api/settings/export-db', () =>
      fetch(`${baseUrl}/api/settings/export-db`, { headers: authHeaders })
    );
  });
});






