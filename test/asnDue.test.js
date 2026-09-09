// test/asnDue.test.js — the deadline that PO 50220600 needed and did not have.
import test from 'node:test'
import assert from 'node:assert/strict'
import { asnDue, asnDueList, asnDueSummary, clockStart, ASN_WINDOW_HOURS, ASN_WARN_HOURS } from '../src/model/asnDue.js'

const H = 36e5
// The real incident: CTE collected on 09-08, Nima marked it shipped at 18:33,
// no 856 was ever sent, Nordstrom's notice arrived on 09-09.
const NB1731282 = {
  bolNumber: 'NB1731282', partner: 'Nordstrom', memberPos: ['50220600'], cartons: 7,
  shipDate: '2026-09-08T00:00:00Z', shippedAt: '2026-09-08T18:33:00Z', asnSentAt: null,
}

test('⚠️ THE REAL CASE IS FLAGGED OVERDUE', () => {
  // 09-09 14:00, which is roughly when the compliance email landed.
  const r = asnDue(NB1731282, Date.parse('2026-09-09T14:00:00Z'))
  assert.equal(r.state, 'due')
  assert.equal(r.bolNumber, 'NB1731282')
  assert.equal(r.po, '50220600')
  assert.ok(r.hoursLeft < 0, `hoursLeft ${r.hoursLeft} should be negative`)
})

test('⚠️ THE CLOCK STARTS AT PICKUP, NOT AT OUR CLICK', () => {
  // Nordstrom's notice names the PICKUP date. shipped_at is when someone pressed a
  // button — 18 hours later here. Using it would put the deadline 18 hours late and
  // reassure us right up to the fee.
  assert.equal(clockStart(NB1731282).basis, 'pickup')
  assert.equal(clockStart(NB1731282).at, Date.parse('2026-09-08T00:00:00Z'))

  const fromPickup = asnDue(NB1731282, Date.parse('2026-09-09T06:00:00Z'))
  const noPickup = asnDue({ ...NB1731282, shipDate: null }, Date.parse('2026-09-09T06:00:00Z'))
  assert.equal(fromPickup.state, 'due', 'past 24h from pickup — the real deadline')
  // ⚠️ AND THIS IS THE WHOLE POINT: from the click it reads 'watch', i.e. half a day
  // still in hand, while the partner already considers it late. 12.5 hours of false
  // reassurance is exactly how PO 50220600 reached a compliance notice.
  assert.equal(noPickup.state, 'watch')
  assert.ok(noPickup.hoursLeft > ASN_WARN_HOURS, `${noPickup.hoursLeft}h "left" that does not exist`)
  assert.equal(noPickup.basis, 'marked shipped', 'and it SAYS which basis it used')
})

test('⚠️ ONLY A REAL 856 COUNTS — NEVER THE NETSUITE FLAG', () => {
  // Measured on this incident: custbody_hb_edi_856_synced read T on all ten
  // fulfilments while Orderful held ZERO 856s. A flag that lies about being sent
  // is what would hide the next one, so it is not an input here at all.
  const withFlag = { ...NB1731282, ediSynced: 'T', asn856Synced: true }
  assert.equal(asnDue(withFlag, Date.parse('2026-09-09T14:00:00Z')).state, 'due')

  const reallySent = { ...NB1731282, asnSentAt: '2026-09-08T19:00:00Z' }
  assert.equal(asnDue(reallySent, Date.parse('2026-09-09T14:00:00Z')), null)
})

test('nothing that has not left is owed', () => {
  assert.equal(asnDue({ bolNumber: 'NB1', partner: 'Nordstrom' }), null)
  assert.equal(asnDue({ bolNumber: 'NB1', shipDate: null, shippedAt: null }), null)
})

test('a pickup in the future has not started its clock', () => {
  const r = asnDue({ ...NB1731282, shipDate: '2026-09-20T00:00:00Z', shippedAt: null }, Date.parse('2026-09-09T14:00:00Z'))
  assert.equal(r, null)
})

test('the three states track the window', () => {
  const at = Date.parse('2026-09-08T00:00:00Z')
  const s = { ...NB1731282, shipDate: '2026-09-08T00:00:00Z' }
  assert.equal(asnDue(s, at + 2 * H).state, 'watch', '2h in — plenty of time')
  assert.equal(asnDue(s, at + (ASN_WINDOW_HOURS - ASN_WARN_HOURS + 1) * H).state, 'warn')
  assert.equal(asnDue(s, at + (ASN_WINDOW_HOURS + 1) * H).state, 'due')
})

test('⚠️ "watch" ROWS ARE RETURNED, NOT HIDDEN', () => {
  // A shipment with 20 hours left is not a problem yet, and IS the one you want to
  // see at 5pm. Suppressing it here would rebuild exactly the silence this replaces.
  const at = Date.parse('2026-09-08T00:00:00Z')
  const list = asnDueList([{ ...NB1731282, shipDate: '2026-09-08T00:00:00Z' }], at + 4 * H)
  assert.equal(list.length, 1)
  assert.equal(list[0].state, 'watch')
})

test('worst first — overdue above warn above watch', () => {
  const now = Date.parse('2026-09-09T00:00:00Z')
  const mk = (bol, hoursAgo) => ({
    bolNumber: bol, partner: 'Nordstrom', memberPos: ['P'], asnSentAt: null,
    shipDate: new Date(now - hoursAgo * H).toISOString(),
  })
  const out = asnDueList([mk('watch', 2), mk('due-worst', 60), mk('warn', 20), mk('due', 30)], now)
  assert.deepEqual(out.map((r) => r.bolNumber), ['due-worst', 'due', 'warn', 'watch'])
})

test('⚠️ THE SUMMARY IS WORDED FOR SOMEONE ABOUT TO WALK OUT', () => {
  const now = Date.parse('2026-09-09T14:00:00Z')
  const s = asnDueSummary([NB1731282, { ...NB1731282, bolNumber: 'NB1731283' }], now)
  assert.equal(s.due, 2)
  assert.equal(s.severity, 'critical')
  assert.match(s.text, /2 ASNs OVERDUE/)
  assert.match(s.text, /offset fee/, 'names the consequence, not just the count')
  assert.deepEqual(s.bols, ['NB1731282', 'NB1731283'], 'names the work rather than counting it')
})

test('a clear board says nothing at all', () => {
  assert.equal(asnDueSummary([]), null)
  assert.equal(asnDueSummary([{ ...NB1731282, asnSentAt: '2026-09-08T19:00:00Z' }]), null)
})

test('⚠️ NO CHARACTER OUTSIDE WinAnsi IN THE SUMMARY', () => {
  // It reaches the same PDF/print surfaces where pdfkit rendered "⚠" as "&".
  const s = asnDueSummary([NB1731282], Date.parse('2026-09-09T14:00:00Z'))
  assert.doesNotMatch(s.text, /[←-⯿]/, s.text)
})

test('it reads snake_case rows straight from the database projection', () => {
  const r = asnDue({
    bol_number: 'NB1731283', partner: 'Nordstrom', member_pos: ['50220600'],
    ship_date: '2026-09-08T00:00:00Z', shipped_at: '2026-09-08T18:33:00Z', asn_sent_at: null,
  }, Date.parse('2026-09-09T14:00:00Z'))
  assert.equal(r.bolNumber, 'NB1731283')
  assert.equal(r.po, '50220600')
  assert.equal(r.state, 'due')
})

test('⚠️ THE LINK TABLE IS NOT THE TRUTH — rule 3', () => {
  // The first version read routing_shipment_edi and reported 23 overdue when 21 had
  // real ASNs: that table is populated on 30 of 53 shipped rows. A NULL there means
  // "never linked", not "never sent".
  const linkedButNotSent = { ...NB1731282, asnCreatedAt: '2026-09-08T19:00:00Z', asnSentAt: null }
  assert.equal(asnDue(linkedButNotSent, Date.parse('2026-09-09T14:00:00Z')).state, 'due',
    'a link-table timestamp must not clear the deadline')

  const sentButNotLinked = { ...NB1731282, asnCreatedAt: null, asnSentAt: '2026-08-25T22:53:00Z' }
  assert.equal(asnDue(sentButNotLinked, Date.parse('2026-09-09T14:00:00Z')), null,
    'a real 856 clears it even with nothing linked')
})

// ── The leaving cutoff ──────────────────────────────────────────────────────
import { asnBanner, cutoffPhase, localMinutes, ASN_CUTOFF_TZ } from '../src/model/asnDue.js'

// 2026-09-09 is PDT (UTC-7). 15:30 local = 22:30Z.
const pdt = (h, m = 0) => Date.parse(`2026-09-09T${String(h + 7).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`)

test('⚠️ THE CUTOFF IS GLENDALE WALL-CLOCK, NOT A UTC HOUR', () => {
  // Every timestamp here is UTC and the warehouse is Pacific. Comparing raw hours
  // would fire this at 8:30am half the year and never the other half.
  assert.equal(localMinutes(pdt(15, 30), ASN_CUTOFF_TZ), 15 * 60 + 30)

  // ⚠️ AND IT MUST SURVIVE DST. 2026-12-09 is PST (UTC-8), so 15:30 local is 23:30Z
  // — an hour later in UTC than the same wall-clock time in September.
  const pst = Date.parse('2026-12-09T23:30:00Z')
  assert.equal(localMinutes(pst, ASN_CUTOFF_TZ), 15 * 60 + 30, 'same wall clock across the DST boundary')
  assert.equal(cutoffPhase(pst, ASN_CUTOFF_TZ).phase, 'window')
})

test('the four phases of the afternoon', () => {
  assert.equal(cutoffPhase(pdt(9), ASN_CUTOFF_TZ).phase, 'clear')
  assert.equal(cutoffPhase(pdt(14, 45), ASN_CUTOFF_TZ).phase, 'approach')
  assert.equal(cutoffPhase(pdt(15, 45), ASN_CUTOFF_TZ).phase, 'window')
  assert.equal(cutoffPhase(pdt(16, 15), ASN_CUTOFF_TZ).phase, 'missed')
})

test('⚠️ THE BANNER SPEAKS BEFORE THE PARTNER CLOCK RUNS OUT', () => {
  // A shipment picked up TODAY is 'watch' under the 24-hour rule — hours in hand —
  // and is exactly what must go out before 4pm. Keying the banner on 'due' would
  // stay silent all afternoon and light up tomorrow morning, which is precisely how
  // PO 50220600 went wrong.
  // Collected 7am local today, so at 3:45pm there are still 15 hours in hand — the
  // partner rule is entirely relaxed about it, and it is the most urgent thing on
  // the board because nobody will be here to send it.
  const today = {
    bolNumber: 'NB1731282', partner: 'Nordstrom', memberPos: ['50220600'],
    shipDate: '2026-09-09T14:00:00Z', asnSentAt: null,
  }
  const d = asnDue(today, pdt(15, 45))
  assert.equal(d.state, 'watch', 'not remotely late for the partner')
  assert.ok(d.hoursLeft > 12, `${d.hoursLeft}h still in hand under the 24h rule`)
  const b = asnBanner([today], pdt(15, 45), ASN_CUTOFF_TZ)
  assert.equal(b.severity, 'critical')
  assert.match(b.text, /SEND NOW/)
  assert.match(b.text, /3:30 and 4:00pm/)
})

test('⚠️ SILENT BEFORE THE LEAD-IN — a permanent banner is wallpaper', () => {
  const today = { bolNumber: 'NB1', shipDate: '2026-09-09T00:00:00Z', asnSentAt: null }
  assert.equal(asnBanner([today], pdt(9), ASN_CUTOFF_TZ), null, '9am, nothing overdue, say nothing')
  assert.ok(asnBanner([today], pdt(14, 45), ASN_CUTOFF_TZ), 'but 45 min before the cutoff, speak')
})

test('a partner-deadline breach speaks at any hour', () => {
  // That one is already costing money; it does not wait for 3:30.
  const old = { bolNumber: 'NB1731262', partner: "Bloomingdale's", shipDate: '2026-08-11T00:00:00Z', asnSentAt: null }
  const b = asnBanner([old], pdt(9), ASN_CUTOFF_TZ)
  assert.equal(b.severity, 'critical')
  assert.match(b.text, /offset fees/)
})

test('past 4pm it says the day is being missed', () => {
  const today = { bolNumber: 'NB1', shipDate: '2026-09-09T00:00:00Z', asnSentAt: null }
  assert.match(asnBanner([today], pdt(16, 20), ASN_CUTOFF_TZ).text, /past 4:00pm/)
})

test('a clear board never banners, at any hour', () => {
  for (const h of [9, 14.75, 15.75, 16.5]) {
    assert.equal(asnBanner([], pdt(Math.floor(h), (h % 1) * 60), ASN_CUTOFF_TZ), null)
  }
})

test('⚠️ NO CHARACTER OUTSIDE WinAnsi IN THE BANNER', () => {
  const today = { bolNumber: 'NB1', shipDate: '2026-09-09T00:00:00Z', asnSentAt: null }
  for (const t of [pdt(14, 45), pdt(15, 45), pdt(16, 20)]) {
    const b = asnBanner([today], t, ASN_CUTOFF_TZ)
    assert.doesNotMatch(b.text, /[←-⯿]/, b.text)
  }
})
