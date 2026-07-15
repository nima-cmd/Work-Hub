// scripts/connect-gmail.js — one-time (or re-run-as-needed) OAuth consent flow
// for read-only Gmail access. Prints a URL to open in your browser; once you
// click Allow, this catches Google's redirect locally, exchanges the code for
// tokens, and saves the refresh token to .env.local. No dependency needed —
// just Node's built-in http server + fetch, same dependency-light style as
// the rest of this repo's ingest scripts.
//
// Run: node --env-file=.env.local scripts/connect-gmail.js

import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'

const PORT = 51776
const REDIRECT_URI = `http://localhost:${PORT}`
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('❌ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET missing from .env.local')
  process.exit(1)
}

const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
authUrl.searchParams.set('client_id', CLIENT_ID)
authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
authUrl.searchParams.set('response_type', 'code')
authUrl.searchParams.set('scope', 'https://www.googleapis.com/auth/gmail.readonly')
authUrl.searchParams.set('access_type', 'offline') // required to get a refresh token
authUrl.searchParams.set('prompt', 'consent') // forces a refresh token even on repeat runs

console.log('\n1. Open this URL in your browser and click Allow:\n')
console.log(authUrl.toString())
console.log('\n2. Waiting for you to finish in the browser...\n')

const server = createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI)
  const code = url.searchParams.get('code')
  const error = url.searchParams.get('error')

  if (error) {
    res.end('Consent denied — you can close this tab.')
    console.error(`❌ Google returned an error: ${error}`)
    server.close()
    process.exit(1)
  }
  if (!code) {
    res.end('Waiting for authorization...')
    return
  }

  res.end('✅ Connected — you can close this tab and go back to the terminal.')
  server.close()

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  })
  const tokens = await tokenRes.json()
  if (!tokens.refresh_token) {
    console.error('❌ No refresh_token in response:', tokens)
    process.exit(1)
  }

  // Append to .env.local (never print the token itself to the terminal).
  const envPath = new URL('../.env.local', import.meta.url)
  const current = readFileSync(envPath, 'utf8')
  const updated = current.includes('GOOGLE_REFRESH_TOKEN=')
    ? current.replace(/GOOGLE_REFRESH_TOKEN=.*/g, `GOOGLE_REFRESH_TOKEN="${tokens.refresh_token}"`)
    : `${current}\nGOOGLE_REFRESH_TOKEN="${tokens.refresh_token}"\n`
  writeFileSync(envPath, updated)

  console.log('✅ Saved GOOGLE_REFRESH_TOKEN to .env.local — Gmail access is now set up.')
  process.exit(0)
})

server.listen(PORT)
