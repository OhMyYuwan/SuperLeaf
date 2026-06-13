import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { recordCollabServerEvent } from './audit-log.js'

test('recordCollabServerEvent writes main and error JSONL logs', async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), 'ylw-collab-log-test-'))
  try {
    await recordCollabServerEvent(
      'message_handling_failed',
      {
        level: 'warning',
        docId: 'doc-1',
        userId: 'user-1',
        operation: 'message',
        code: 'unknown_message_type',
        message: 'bad message',
        details: { bytes: 4 },
      },
      { logDir },
    )

    const mainPayload = JSON.parse(
      (await readFile(path.join(logDir, 'collaboration-server.log'), 'utf8')).trim(),
    ) as Record<string, unknown>
    const errorPayload = JSON.parse(
      (await readFile(path.join(logDir, 'collaboration-server-errors.log'), 'utf8')).trim(),
    ) as Record<string, unknown>

    assert.equal(mainPayload.event, 'message_handling_failed')
    assert.equal(mainPayload.level, 'warning')
    assert.equal(mainPayload.doc_id, 'doc-1')
    assert.equal(mainPayload.user_id, 'user-1')
    assert.equal(mainPayload.operation, 'message')
    assert.equal(mainPayload.code, 'unknown_message_type')
    assert.deepEqual(mainPayload.details, { bytes: 4 })
    assert.deepEqual(errorPayload, mainPayload)
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
})

test('recordCollabServerEvent keeps info events out of error log', async () => {
  const logDir = await mkdtemp(path.join(tmpdir(), 'ylw-collab-log-test-'))
  try {
    await recordCollabServerEvent(
      'client_connected',
      {
        docId: 'doc-1',
        operation: 'websocket_connect',
      },
      { logDir },
    )

    const mainPayload = JSON.parse(
      (await readFile(path.join(logDir, 'collaboration-server.log'), 'utf8')).trim(),
    ) as Record<string, unknown>

    assert.equal(mainPayload.event, 'client_connected')
    await assert.rejects(readFile(path.join(logDir, 'collaboration-server-errors.log'), 'utf8'))
  } finally {
    await rm(logDir, { recursive: true, force: true })
  }
})
