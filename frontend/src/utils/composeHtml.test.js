import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import {
  buildComposePreviewDocument,
  htmlToPlainText,
  sanitizeComposeHtml,
  seedHtmlFromPlainText,
} from './composeHtml.js'

function createWindow() {
  return new JSDOM('<!doctype html><html><body></body></html>').window
}

test('seedHtmlFromPlainText preserves paragraphs and line breaks', () => {
  const seeded = seedHtmlFromPlainText('hello\nworld\n\nsecond')
  assert.equal(seeded, '<p>hello<br>world</p>\n<p>second</p>')
})

test('sanitizeComposeHtml removes active content and unsafe urls', () => {
  const win = createWindow()
  const sanitized = sanitizeComposeHtml(
    '<p onclick="alert(1)">Hi</p><script>alert(1)</script><img src="javascript:alert(1)"><img src="cid:ok">',
    win,
  )

  assert.equal(sanitized, '<p>Hi</p><img><img src="cid:ok">')
})

test('sanitizeComposeHtml preserves inline styles and remote images', () => {
  const win = createWindow()
  const sanitized = sanitizeComposeHtml(
    '<p style="color:red">Hello</p><img src="https://example.com/image.png">',
    win,
  )

  assert.match(sanitized, /style="color:\s*red;?"/)
  assert.match(sanitized, /src="https:\/\/example\.com\/image\.png"/)
})

test('htmlToPlainText converts sanitized html to text', () => {
  const win = createWindow()
  const plain = htmlToPlainText('<p>Hello<br>World</p>', win)
  assert.equal(plain, 'HelloWorld')
})

test('buildComposePreviewDocument wraps sanitized fragment in an html shell', () => {
  const win = createWindow()
  const preview = buildComposePreviewDocument('<script>x</script><p>Safe</p>', win)
  assert.match(preview, /<!DOCTYPE html>/)
  assert.match(preview, /<p>Safe<\/p>/)
  assert.doesNotMatch(preview, /<script>/)
})
