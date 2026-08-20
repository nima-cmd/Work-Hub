import { useEffect, useState } from 'react'
import { fetchWeaver } from '../api.js'

// Weaver — is NAGHEDI's product data still true in NetSuite?
//
// Weaver is the Airtable base where products are authored; NetSuite is the system
// of record for items; Shopify cannot create an item NetSuite does not have. The
// round trip has two manual steps, and step 2 (feed NetSuite's reality back) is
// what `npm run weaver:sync` automates and this page reports.
//
// Same principle as Health.jsx: the person who has to fix a UPC collision is not
// the person with a shell, so nothing here should require a terminal to read.
//
// THE COLUMN THAT MATTERS IS "seen". Weaver can tell you something is wrong; it
// cannot tell you for how long, because Airtable stores a present, not a history.
// Every other number on this page exists in Weaver somewhere. That one does not.
//
// Deliberately read-only — there is no "sync now" button. A sync writes, and a
// write should not be one stray click away from a page people browse.

const KINDS = [
  { key: 'upc_collision', label: 'UPC collisions', tone: 'bad',
    blurb: 'One UPC on two active NetSuite items. Weaver reports these as healthy — its duplicate check counts Weaver variants, not NetSuite items, so it structurally cannot see this. UPC is the field Nordstrom, Saks and Mirakl all match on.' },
  { key: 'mismatch_flagged', label: 'MISMATCH', tone: 'warn',
    blurb: "Weaver's own flag. Its two link paths to a parent SKU disagree, which in practice means style-number drift — a product renumbered after its items were already in NetSuite." },
  { key: 'field_drift', label: 'Field drift', tone: 'warn',
    blurb: 'The mirror and NetSuite disagree on sku, upc or hts for the same internal id.' },
  { key: 'stale_in_weaver', label: 'Stale in Weaver', tone: 'warn',
    blurb: 'Mirrored in Weaver, no longer in NetSuite.' },
  { key: 'shopify_drift', label: 'Shopify drift', tone: 'bad',
    blurb: "Shopify and Weaver disagree on a field Weaver COMPUTES — so Shopify was edited directly, or an upload never landed. Weaver's own Shopify diff formulas compare a field to itself and are permanently empty, so this comparison has never existed until now." },
  { key: 'shopify_orphan', label: 'Shopify orphans', tone: 'warn',
    blurb: 'Live on the storefront with a SKU no Weaver product owns. Gift cards and Internal items are expected here — they are Shopify-only by design and never come from NetSuite.' },
  { key: 'stranded_sku', label: 'Stranded SKUs', tone: 'info', informational: true,
    blurb: 'Active in NetSuite, but no CURRENT Weaver product computes this SKU. Usually a weave re-code: the SKU moved and left the NetSuite item orphaned. Weaver knows the item exists — it cannot remember that the old SKU was once its own.' },
  { key: 'missing_in_weaver', label: 'Not mirrored', tone: 'info',
    blurb: 'In NetSuite, absent from the Back Office mirror.' },
]

const fmtAge = (since, runs) => {
  if (!since || runs <= 1) return 'new'
  const days = Math.floor((Date.now() - new Date(since)) / 86400000)
  if (days >= 1) return `${days}d · ${runs} runs`
  const hrs = Math.floor((Date.now() - new Date(since)) / 3600000)
  return hrs >= 1 ? `${hrs}h · ${runs} runs` : `${runs} runs`
}

const fmtWhen = (t) => t ? new Date(t).toLocaleString(undefined,
  { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

function Delta({ now, was }) {
  if (was == null || now == null || now === was) return null
  const d = now - was
  return <span className={'wvDelta ' + (d > 0 ? 'up' : 'down')}>{d > 0 ? `+${d}` : d}</span>
}

function Tile({ label, value, was, hint }) {
  return (
    <div className="wvTile">
      <div className="wvTileVal">{value ?? '—'}<Delta now={value} was={was} /></div>
      <div className="wvTileLabel">{label}</div>
      {hint && <div className="wvTileHint">{hint}</div>}
    </div>
  )
}

// UPC collisions carry a re-code flag: same silhouette digits and colour with a
// different weave code is one product duplicated, which is defensible until the
// obsolete item is inactivated. Anything else is one code on two real products.
function Row({ kind, f }) {
  const d = f.detail || {}
  if (kind === 'upc_collision') {
    return (
      <tr className={d.recodeTwin ? '' : 'wvHard'}>
        <td className="mono">{f.sku}</td>
        <td>{d.recodeTwin
          ? <span className="wvPill">re-code twin</span>
          : <span className="wvPill bad">⚠ different products</span>}</td>
        <td className="mono wvWrap">{(d.skus || []).join('  +  ')}</td>
        <td className="wvAge">{fmtAge(f.since, f.runCount)}</td>
      </tr>
    )
  }
  if (kind === 'shopify_drift') {
    return (
      <tr>
        <td className="mono">{f.sku}</td>
        <td colSpan={2} className="wvWrap">
          {(d.diffs || []).map((x, i) => (
            <div key={i}><b>{x.field}</b> Shopify <code>{String(x.shopify)}</code> vs Weaver <code>{String(x.weaver)}</code></div>
          ))}
        </td>
        <td className="wvAge">{fmtAge(f.since, f.runCount)}</td>
      </tr>
    )
  }
  if (kind === 'field_drift') {
    return (
      <tr>
        <td className="mono">{f.sku}</td>
        <td colSpan={2} className="wvWrap">
          {(d.diffs || []).map((x, i) => (
            <div key={i}><b>{x.field}</b> NetSuite <code>{String(x.netsuite)}</code> vs Weaver <code>{String(x.weaver)}</code></div>
          ))}
        </td>
        <td className="wvAge">{fmtAge(f.since, f.runCount)}</td>
      </tr>
    )
  }
  return (
    <tr>
      <td className="mono">{f.sku || '—'}</td>
      <td className="muted mono">{f.internalId}</td>
      <td className="muted">{d.productType || d.flag || ''}</td>
      <td className="wvAge">{fmtAge(f.since, f.runCount)}</td>
    </tr>
  )
}

export default function Weaver() {
  const [w, setW] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(() => new Set(['upc_collision', 'mismatch_flagged']))

  function load() {
    setBusy(true)
    fetchWeaver().then((r) => { setW(r); setErr(null) })
      .catch((e) => setErr(e.message)).finally(() => setBusy(false))
  }
  useEffect(load, [])

  const toggle = (k) => setOpen((s) => {
    const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n
  })

  if (err) return <div className="banner error">⚠ Couldn’t load Weaver: {err}</div>
  if (!w) return <div className="banner">Loading…</div>
  if (!w.latest) return (
    <div className="banner">
      No reconciliation has run yet. Run <code>npm run weaver:sync</code> to record one.
    </div>
  )

  const { latest, previous, totals, findings, benignCounts, recoded, runs } = w
  // Must match `weaver-sync.js`'s exit code, or the page and the CLI disagree
  // about the same data — stranded SKUs are reported but do not count, because
  // most are historical residue from renumbering rather than a live decision.
  const actionable = KINDS.reduce((n, k) =>
    n + (k.informational ? 0 : (findings[k.key]?.length || 0)), 0)
  const informational = KINDS.reduce((n, k) =>
    n + (k.informational ? (findings[k.key]?.length || 0) : 0), 0)
  // `ok` on a run row tracks in-sync, NOT run health — a run that succeeded and
  // found problems has ok=false and error=null. Read `error` for health.
  const failed = !!latest.error

  return (
    <div className="weaver">
      <div className="hlHead">
        <div>
          <h2>Weaver <span className="muted">· product data vs NetSuite</span></h2>
          <div className="muted hlSub">
            Weaver authors products · NetSuite is the system of record · Shopify cannot create
            an item NetSuite does not have. This is step 2 of that round trip, recorded so drift
            has a history instead of only a “now”.
          </div>
        </div>
        <button className="btnGhost" disabled={busy} onClick={load}>{busy ? 'Loading…' : '↻ Reload'}</button>
      </div>

      <div className={'hlVerdict ' + (failed ? 'broken' : actionable ? 'warn' : 'ok')}>
        <span className="hlVerdictMark">{failed ? '⛔' : actionable ? '⚠' : '✓'}</span>
        <div>
          {failed
            ? <><b>The last run failed.</b> {latest.error}</>
            : actionable
              ? <><b>{actionable} finding{actionable === 1 ? '' : 's'} need a decision.</b> Nothing is changed automatically — this page only reports.</>
              : <><b>In sync.</b> Nothing outstanding.</>}
          <div className="muted wvSub">
            Run #{latest.id} · {fmtWhen(latest.started_at)}
            {informational > 0 && <> · {informational} stranded SKUs listed for context, not counted</>}
            {latest.shopify_missing != null && <> · {latest.shopify_missing} eligible products not on the storefront (unpublishing, not divergence)</>}
            {previous && <> · previous run {fmtWhen(previous.started_at)}</>}
          </div>
        </div>
      </div>

      <div className="wvTiles">
        <Tile label="NetSuite items" value={latest.netsuite_rows} was={previous?.netsuite_rows} />
        <Tile label="Back Office mirror" value={latest.weaver_rows} was={previous?.weaver_rows} />
        <Tile label="Weaver products" value={latest.weaver_products} was={previous?.weaver_products} />
        <Tile label="UPC collisions" value={latest.upc_collisions} was={previous?.upc_collisions}
              hint="Weaver cannot see these" />
        <Tile label="MISMATCH" value={latest.mismatch_flagged} was={previous?.mismatch_flagged} />
        <Tile label="Stranded SKUs" value={latest.stranded_skus} was={previous?.stranded_skus}
              hint={benignCounts?.stranded_sku ? `${benignCounts.stranded_sku} more inactive/ignored` : null} />
        <Tile label="Shopify products" value={latest.shopify_products} was={previous?.shopify_products}
              hint="public storefront, no token" />
        <Tile label="Shopify drift" value={latest.shopify_drift} was={previous?.shopify_drift}
              hint="never checked before" />
      </div>

      {KINDS.map(({ key, label, tone, blurb }) => {
        const rows = findings[key] || []
        const benign = benignCounts?.[key] || 0
        if (!rows.length && !benign) return null
        const isOpen = open.has(key)
        return (
          <section key={key} className={'wvSection ' + tone}>
            <button className="wvSectionHead" onClick={() => toggle(key)}>
              <span className="wvCaret">{isOpen ? '▾' : '▸'}</span>
              <b>{label}</b>
              <span className={'wvCount ' + (rows.length ? tone : 'ok')}>{rows.length}</span>
              {benign > 0 && <span className="muted wvBenign">+{benign} expected</span>}
            </button>
            {isOpen && (
              <div className="wvSectionBody">
                <div className="muted wvBlurb">{blurb}</div>
                {rows.length === 0
                  ? <div className="muted">Nothing actionable.</div>
                  : (
                    <table className="wvTable">
                      <thead>
                        <tr>
                          <th>{key === 'upc_collision' ? 'UPC' : 'SKU'}</th>
                          <th>{key === 'upc_collision' ? 'shape' : 'internal id'}</th>
                          <th>{key === 'upc_collision' ? 'items sharing it' : 'detail'}</th>
                          <th>seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((f, i) => <Row key={i} kind={key} f={f} />)}
                      </tbody>
                    </table>
                  )}
              </div>
            )}
          </section>
        )
      })}

      {recoded?.length > 0 && (
        <section className="wvSection warn">
          <div className="wvSectionHead static"><b>Re-coded products</b>
            <span className="wvCount warn">{recoded.length}</span></div>
          <div className="wvSectionBody">
            <div className="muted wvBlurb">
              Products whose computed SKU has changed since we started watching. Each rename
              leaves the old SKU live in NetSuite unless someone inactivates it.
            </div>
            <table className="wvTable">
              <thead><tr><th>product</th><th>status</th><th>SKUs held</th><th>since</th></tr></thead>
              <tbody>
                {recoded.map((p) => (
                  <tr key={p.airtable_record_id}>
                    <td>{p.product_name}</td>
                    <td className="muted">{p.product_status}</td>
                    <td className="mono wvWrap">{(p.skus || []).join('  →  ')}</td>
                    <td className="muted">{fmtWhen(p.first_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="wvSection">
        <div className="wvSectionHead static"><b>Run history</b>
          <span className="muted wvBenign">newest first</span></div>
        <div className="wvSectionBody">
          <table className="wvTable">
            <thead>
              <tr><th>run</th><th>when</th><th>NS</th><th>mirror</th><th>products</th>
                  <th>UPC</th><th>MISMATCH</th><th>stranded</th><th>shop drift</th><th>missing</th><th></th></tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id}>
                  <td className="mono">#{r.id}</td>
                  <td className="muted">{fmtWhen(r.started_at)}</td>
                  <td>{r.netsuite_rows}</td>
                  <td>{r.weaver_rows}</td>
                  <td>{r.weaver_products ?? '—'}</td>
                  <td>{r.upc_collisions ?? '—'}</td>
                  <td>{r.mismatch_flagged}</td>
                  <td>{r.stranded_skus ?? '—'}</td>
                  <td>{r.shopify_drift ?? '—'}</td>
                  <td>{r.missing_in_weaver}</td>
                  <td>{r.error ? <span className="wvPill bad">failed</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="muted wvBlurb">
            A dash means the column did not exist yet on that run. Totals now held:
            {' '}{totals?.ns_items} NetSuite items · {totals?.products} products ·
            {' '}{totals?.back_office} mirror rows · {totals?.product_sku_history} product-SKU history rows
            {totals?.shopify_variants != null && <> · {totals.shopify_variants} Shopify variants</>}.
          </div>
        </div>
      </section>

      <div className="muted wvFoot">
        Read-only by design. To record a new run: <code>npm run weaver:sync</code> ·
        read-only check: <code>npm run check:weaver</code> · neither ever writes to
        NetSuite or Airtable.
      </div>
    </div>
  )
}
