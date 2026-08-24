// src/model/connectionString.js — rules about the DATABASE_URL itself.
//
// ⚠️ A MODEL, NOT src/db.js, AND FOR A CONCRETE REASON. Importing src/db.js throws
// unless DATABASE_URL is set and then opens a real pool, so nothing can unit-test it —
// the same reason server/queries.js has `node --check` as its only guard. A rule that
// can take the deploy down has to live somewhere a test can reach it.

import { existsSync } from 'node:fs'

/**
 * Drop `sslrootcert` from a connection string when the file it names is not there.
 *
 * ⚠️ THIS TOOK THE FIRST DIGITALOCEAN DEPLOY DOWN, and the failure was nowhere near
 * where it looked. `.env.local`'s DATABASE_URL carries
 * `sslmode=verify-full&sslrootcert=/Users/nimaerfani/.config/workhub/do-ca-certificate.crt`
 * because that is what psql needs locally. Pasted into the deploy's environment, the
 * path does not exist in the container — and pg-connection-string reads the file
 * EAGERLY, WHILE PARSING, so every connection threw ENOENT from inside
 * BoundPool.newClient before any of our own code ran:
 *
 *     Error: ENOENT ... open '/Users/nimaerfani/.config/workhub/do-ca-certificate.crt'
 *
 * The app started, logged "Tracker running", then 504'd on every request that touched
 * the database — which reads as a routing or memory problem and is neither.
 *
 * ⚠️ NOTHING IS LOST BY STRIPPING IT. sslFor() already supplies the committed CA
 * (db/do-ca-certificate.crt) with rejectUnauthorized and the right servername, which
 * IS verify-full behaviour — see its comment above. The parameter was only ever for
 * psql's benefit, and the comment there already promised "the deploy needs no env
 * change to gain verification". This makes that true instead of aspirational.
 *
 * ⚠️ It is stripped only when the file is MISSING. A machine that has the file keeps
 * using it, so local psql-parity behaviour is untouched — and a silent difference
 * between what the URL says and what the connection does is exactly what this repo
 * keeps paying for.
 */
export function stripMissingSslRootCert(u) {
  if (!u || !/[?&]sslrootcert=/i.test(u)) return u
  try {
    const parsed = new URL(u)
    const p = parsed.searchParams.get('sslrootcert')
    if (p && existsSync(p.replace(/^~/, process.env.HOME || '~'))) return u   // it's there — leave it
    parsed.searchParams.delete('sslrootcert')
    // ⚠️ verify-full with no CA file would fail differently; sslFor() is doing the
    // verifying, so say what is true rather than leaving a mode nothing honours.
    if (parsed.searchParams.get('sslmode') === 'verify-full') parsed.searchParams.set('sslmode', 'require')
    console.warn('▲ DATABASE_URL named an sslrootcert file that is not on this machine ' +
      `(${p}) — dropped it. The committed CA in db/do-ca-certificate.crt is used instead, ` +
      'so the connection is still verified.')
    return parsed.toString()
  } catch {
    return u   // unparseable: leave it alone and let pg complain in its own words
  }
}

/**
 * Hand pg a connection string that does not fight the `ssl` object we pass beside it.
 *
 * ⚠️ THE URL WINS. Proven against the live database 2026-08-24:
 *
 *     sslmode=require in the url + our ssl object -> self-signed certificate in chain
 *     no sslmode in the url      + our ssl object -> connects
 *
 * pg-connection-string turns `sslmode` into its own `config.ssl`, and that takes
 * precedence over the `ssl` option. Modern pg also treats `require` as `verify-full`
 * (it warns about this on every boot), so the URL's mode verifies against the SYSTEM
 * CA store — which has no DigitalOcean private CA. Result: the first DO deploy failed
 * every query with `self-signed certificate in certificate chain` while src/db.js was
 * holding the correct CA in its hand.
 *
 * ⚠️ AND THE SAME MECHANISM MEANT RENDER WAS NEVER VERIFYING EITHER. Its URL is
 * `uselibpqcompat=true&sslmode=require`, where libpq semantics make `require` mean
 * "encrypt, do not verify". Tested by tampering: with that URL, a BOGUS ca still
 * connects. CLAUDE.md records "the deploy verifies without an env change — proven by
 * tampering", but that proof was run locally, where the url's own `sslrootcert` was
 * doing the verifying. A verification demonstrated in one configuration and assumed
 * in another is this repo's oldest mistake, and it was hiding in the sentence claiming
 * the opposite.
 *
 * So when we are supplying the CA ourselves, the URL's TLS parameters are removed and
 * our object is the only authority. Verification becomes real, and provable by
 * tampering in the configuration that actually runs.
 *
 * ⚠️ ONLY when `ownCa` is true. If the committed certificate could not be read there
 * is nothing to fall back to, and stripping `sslmode` would drop the connection to
 * plaintext against a server that demands TLS — trading a verification failure for an
 * outage. In that case the URL keeps its mode and at least encrypts.
 */
export function prepareConnectionString(u, { ownCa = false } = {}) {
  const stripped = stripMissingSslRootCert(u)
  if (!ownCa || !stripped) return stripped
  try {
    const parsed = new URL(stripped)
    for (const p of ['sslmode', 'sslrootcert', 'uselibpqcompat', 'sslcert', 'sslkey']) {
      parsed.searchParams.delete(p)
    }
    return parsed.toString()
  } catch {
    return stripped
  }
}
