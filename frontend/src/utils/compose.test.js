import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

globalThis.window = new JSDOM('<!doctype html><html><body></body></html>').window

const {
  buildDraftSavePayload,
  composeRecipientsToString,
  ensureHtmlDraftSeed,
  isComposeDraftDirty,
  normalizeComposeDraft,
  normalizeComposeRecipients,
  parseComposeBody,
} = await import('./compose.js')

test('normalizeComposeDraft hydrates recipient arrays from legacy strings', () => {
  const draft = normalizeComposeDraft({
    to: 'a@example.com; b@example.com',
    cc: 'Name <c@example.com>',
    body: 'legacy',
  })

  assert.deepEqual(draft.toRecipients, ['a@example.com', 'b@example.com'])
  assert.deepEqual(draft.ccRecipients, ['c@example.com'])
  assert.equal(draft.to, 'a@example.com, b@example.com')
  assert.equal(draft.plainBody, 'legacy')
})

test('recipient helpers dedupe and serialize values', () => {
  const recipients = normalizeComposeRecipients(['a@example.com', 'A@example.com', ' Name <b@example.com> '])
  assert.deepEqual(recipients, ['a@example.com', 'b@example.com'])
  assert.equal(composeRecipientsToString(recipients), 'a@example.com, b@example.com')
})

test('ensureHtmlDraftSeed seeds html only when html is empty', () => {
  const seeded = ensureHtmlDraftSeed({ plainBody: 'hello\nworld' })
  assert.equal(seeded.htmlBody, '<p>hello<br>world</p>')

  const preserved = ensureHtmlDraftSeed({ plainBody: 'ignored', htmlBody: '<p>kept</p>' })
  assert.equal(preserved.htmlBody, '<p>kept</p>')
})

test('parseComposeBody builds html payload with plain fallback and attachments', () => {
  const payload = parseComposeBody({
    from: 'sender@example.com',
    toRecipients: ['to@example.com'],
    ccRecipients: ['cc@example.com'],
    subject: 'Hello',
    format: 'html',
    htmlBody: '<p>Hello<script>alert(1)</script></p><img src="cid:test">',
    attachments: [
      {
        id: '1',
        name: 'image.png',
        mimeType: 'image/png',
        size: 10,
        base64: 'SGVsbG8=',
        disposition: 'inline',
        contentId: 'test',
        source: 'html-inline',
      },
    ],
  })

  assert.equal(payload.format, 'html')
  assert.equal(payload.from, 'sender@example.com')
  assert.deepEqual(payload.to, ['to@example.com'])
  assert.deepEqual(payload.cc, ['cc@example.com'])
  assert.equal(payload.body_html, '<p>Hello</p><img src="cid:test">')
  assert.equal(payload.attachments[0].content_id, 'test')
})

test('parseComposeBody rejects malformed recipients with precise message', () => {
  assert.throws(
    () => parseComposeBody({ toRecipients: ['foo@'], plainBody: 'x' }),
    /Invalid recipient: foo@/,
  )
})

test('buildDraftSavePayload preserves draft id and serializes recipients', () => {
  const payload = buildDraftSavePayload({
    draftId: 'draft-1',
    toRecipients: ['a@example.com'],
    ccRecipients: ['cc@example.com'],
    plainBody: 'hello',
  }, 'from@example.com')

  assert.equal(payload.draft_id, 'draft-1')
  assert.deepEqual(payload.to, ['a@example.com'])
  assert.deepEqual(payload.cc, ['cc@example.com'])
  assert.equal(payload.from, 'from@example.com')
})

test('isComposeDraftDirty ignores empty mode-only changes and detects content', () => {
  assert.equal(isComposeDraftDirty({ format: 'html', htmlMode: 'preview' }), false)
  assert.equal(isComposeDraftDirty({ subject: 'Hello' }), true)
  assert.equal(isComposeDraftDirty({ attachments: [{ filename: 'a.txt', data_base64: 'QQ==' }] }), true)
})
