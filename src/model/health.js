// src/model/health.js — is every outside system actually reachable, and is the
// data still arriving?
//
// Why this exists (Nima, 2026-07-31): the deployed app had gone 13 hours without
// a NetSuite sync while its cron returned 200 on every run. Diagnosing that took
// correlating GitHub Actions history against snapshot timestamps by hand — and
// the answer, once found, was mundane: five environment variables were missing on
// the deploy, so `netsuiteConfigured()` returned false and the sync skipped in
// silence. Nima: "That seems like a useful thing for both of us to have so we can
// both see if something broken."
//
// The failure mode this is built against: **a missing credential is not an
// error.** Every integration here is gated on `xConfigured()` and skips quietly
// when it isn't set, which is right for local dev (you don't want the app dead
// because you have no Orderful key) and dangerous in production (nothing
// complains). So absence has to be reported as loudly as failure.
//
// ⚠️ SECURITY RULE, DO NOT LOOSEN: this module receives and returns BOOLEANS and
// VARIABLE NAMES ONLY. It never sees a credential value, so no route built on it
// can leak one. Variable names are not secrets — they're in the source already —
// and naming the missing one is the entire diagnostic value.

// Every integration, the env vars it needs, and what silently stops without it.
// `optional` vars are recorded but don't make an integration "missing".
export const INTEGRATIONS = [
  {
    key: 'netsuite',
    label: 'NetSuite',
    vars: ['NS_ACCOUNT_ID', 'NS_CONSUMER_KEY', 'NS_CONSUMER_SECRET', 'NS_TOKEN_ID', 'NS_TOKEN_SECRET'],
    powers: 'Orders, fulfilments, invoices and the EDI carton feed',
    ifMissing: 'The app serves whatever Neon last received. Nothing errors.',
    syncs: ['netsuiteLive', 'ediPackagesLive'],
  },
  {
    key: 'orderful',
    label: 'Orderful (EDI)',
    vars: ['ORDERFUL_API_KEY'],
    powers: '850 / 856 / 810 transactions and the undelivered-ASN check',
    ifMissing: 'New POs stop arriving and undelivered ASNs go unnoticed.',
    syncs: [],
  },
  {
    key: 'shipstation',
    label: 'ShipStation',
    vars: ['SHIPSTATION_API_KEY', 'SHIPSTATION_API_SECRET'],
    optional: ['SHIPSTATION_API_KEY_V2'],
    powers: 'Billed UPS costs; V2 key adds live per-account rate quotes',
    ifMissing: 'No wholesale rate figures at all.',
    syncs: ['shipstationCosts'],
  },
  {
    key: 'google',
    label: 'Google (Gmail / Drive / Calendar)',
    vars: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
    powers: 'Transmissions, BOL filing to Drive, the shipping calendar',
    ifMissing: 'Email-derived tasks stop; BOLs are not filed.',
    syncs: [],
  },
  {
    key: 'database',
    // ⚠️ NO NAME HARD-CODED HERE. This said "Database (Neon)" for a day and a half
    // AFTER the app moved to DigitalOcean — a FOURTH instance of the cutover bug the
    // register already holds three of (check:neon, check:transfer and migrate all
    // announced NEON while reading DO). The label is filled in from the connection
    // by computeIntegrationHealth, the same way DB_TARGET is derived by hostKind(),
    // because a database name typed into a string cannot follow a migration.
    label: 'Database',
    vars: ['DATABASE_URL'],
    powers: 'Everything — this is the app\'s only store',
    ifMissing: 'The app cannot start.',
    syncs: [],
  },
]

/** How the database entry names itself, from the DERIVED target — never a literal. */
export const DB_LABEL = {
  digitalocean: 'Database (DigitalOcean)',
  neon: 'Database (Neon)',
  mirror: 'Database (local mirror — STALE)',
}

// present: { VAR_NAME: boolean } — booleans only, never values. See the rule above.
//
// dbTarget comes from hostKind(DATABASE_URL), so the database row names the database
// actually connected. Unknown or absent leaves it as plain "Database": an unnamed
// store is honest, a wrongly-named one is the bug this parameter exists to prevent.
export function computeIntegrationHealth(present = {}, { dbTarget = null } = {}) {
  return INTEGRATIONS.map((i) => (i.key === 'database' && DB_LABEL[dbTarget]
    ? { ...i, label: DB_LABEL[dbTarget] }
    : i)).map((i) => {
    const missing = i.vars.filter((v) => !present[v])
    const missingOptional = (i.optional || []).filter((v) => !present[v])
    return {
      key: i.key,
      label: i.label,
      powers: i.powers,
      ifMissing: i.ifMissing,
      syncs: i.syncs,
      configured: missing.length === 0,
      missing,
      missingOptional,
      // Configured but not fully — worth showing without crying wolf.
      partial: missing.length === 0 && missingOptional.length > 0,
    }
  })
}

// Overall verdict. A missing credential outranks a stale sync, because it's
// almost always the CAUSE of one — that was exactly the 13-hour NetSuite gap.
export function overallHealth({ integrations = [], syncs = null } = {}) {
  const broken = integrations.filter((i) => !i.configured)
  if (broken.length) {
    return {
      status: 'broken',
      headline: broken.length === 1
        ? `${broken[0].label} is not configured — ${broken[0].missing.length} variable${broken[0].missing.length === 1 ? '' : 's'} missing`
        : `${broken.length} integrations are not configured`,
      // Name the likely knock-on so the two symptoms are connected, not debugged twice.
      detail: broken.some((b) => b.syncs.length) && syncs && syncs.status !== 'ok'
        ? 'This is almost certainly why the data below is stale.'
        : null,
    }
  }
  if (syncs && syncs.status !== 'ok') {
    return { status: 'stale', headline: 'Everything is configured, but a sync has stopped arriving', detail: null }
  }
  const partial = integrations.filter((i) => i.partial)
  if (partial.length) {
    return { status: 'partial', headline: `${partial.length} integration${partial.length === 1 ? '' : 's'} missing an optional key`, detail: null }
  }
  return { status: 'ok', headline: 'All integrations configured and syncing', detail: null }
}
