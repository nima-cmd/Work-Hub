import test from 'node:test'
import assert from 'node:assert/strict'
import { stripMissingSslRootCert } from '../src/model/connectionString.js'

// ⚠️ THIS TOOK THE FIRST DIGITALOCEAN DEPLOY DOWN. `.env.local` carries
// sslrootcert=/Users/nimaerfani/.config/workhub/do-ca-certificate.crt because psql
// needs it locally. Pasted into the deploy's environment, the path is not in the
// container — and pg-connection-string reads the file WHILE PARSING, so every
// connection threw ENOENT from inside BoundPool.newClient. The app logged "Tracker
// running" and then 504'd on anything touching the database, which reads as a routing
// or memory fault and is neither.

const HOST = 'postgres://u:p@workhub-db-do-user-1.k.db.ondigitalocean.com:25060/defaultdb'

test('the shape of the failing URL: a missing cert path is dropped', () => {
  // ⚠️ NOT the literal production path. Writing this test with
  // /Users/nimaerfani/.config/workhub/do-ca-certificate.crt failed on Nima's own Mac
  // — because that file IS there, so the function correctly kept it. The bug only
  // exists where the file is absent, which is the container, so the test has to name
  // a path that is absent everywhere. (It did usefully prove the keep-it branch.)
  const out = stripMissingSslRootCert(
    `${HOST}?sslmode=verify-full&sslrootcert=/Users/someone/.config/workhub/do-ca-certificate.crt`)
  assert.ok(!/sslrootcert/.test(out), 'the parameter is gone')
  assert.match(out, /sslmode=require/, 'and verify-full becomes require, since no file backs it')
})

test('⚠️ a cert file that EXISTS is left alone — local psql parity is untouched', () => {
  // Any real file will do; the rule is about presence, not this repo's own CA.
  const real = new URL('../db/do-ca-certificate.crt', import.meta.url).pathname
  const url = `${HOST}?sslmode=verify-full&sslrootcert=${real}`
  assert.equal(stripMissingSslRootCert(url), url, 'unchanged')
})

test('a URL with no sslrootcert is returned untouched', () => {
  const url = `${HOST}?uselibpqcompat=true&sslmode=require`
  assert.equal(stripMissingSslRootCert(url), url)
})

test('sslmode is only rewritten when it was verify-full', () => {
  const out = stripMissingSslRootCert(`${HOST}?sslmode=require&sslrootcert=/nope/missing.crt`)
  assert.match(out, /sslmode=require/)
  assert.ok(!/sslrootcert/.test(out))
})

test('an unparseable string is handed back as-is, for pg to complain in its own words', () => {
  assert.equal(stripMissingSslRootCert('not a url at all sslrootcert=/x'), 'not a url at all sslrootcert=/x')
})

test('null and undefined are safe', () => {
  assert.equal(stripMissingSslRootCert(null), null)
  assert.equal(stripMissingSslRootCert(undefined), undefined)
})

test('a ~ path is expanded before the existence check, not treated as literal', () => {
  // CLAUDE.md documents the local value as ~/.config/workhub/... — a literal '~'
  // directory never exists, so without expansion this would strip a cert that IS there.
  const out = stripMissingSslRootCert(`${HOST}?sslrootcert=~/definitely/not/here.crt`)
  assert.ok(!/sslrootcert/.test(out))
})
