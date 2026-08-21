import { useEffect, useMemo, useRef, useState } from 'react'
import { BUILDINGS, ROADS, BUILDING, centreOf, buildingStates, moversFrom } from '../../../src/model/baseMap.js'
import { NsLink } from '../lib.jsx'
import BuildingInterior from './BuildingInterior.jsx'
import './base.css'

// Base — the command base, seen from directly above (Nima, 2026-08-20/21).
//
//   "if you look at launch base and the background we use there with the different
//    building the 3d model that is what we meant by base… a top down view would be
//    best i think like in a video game and we want the people moving from building to
//    building on roads not just randomly anywhere"
//
// and, deciding what it is FOR:
//
//   "we would like to be able to use this view to work from"
//
// So a building is not a link to somewhere else — it OPENS, in place, into the work
// it holds, and every document in that list opens its data packet. You act here.
//
// ⚠️ NO THREE.JS AND NO NEW ENDPOINT. The buildings are pre-rendered PNGs of the real
// `bay.glb` structures (client/public/base/README.md), and every number comes from the
// props App already passes every view. This is the screen meant to be open all day on
// a one-vCPU deploy; it costs a few images and some CSS.
//
// The rules — which building is which lane, what connects to what, what each one
// counts — are all in src/model/baseMap.js, tested. This file is the drawing.

// The map's own coordinate space. Buildings are placed in percentages and the SVG
// shares the same 0–100 space scaled to this box, so roads and buildings cannot
// disagree about where a building is. The container is locked to this aspect ratio
// for exactly that reason.
const VB_W = 1000
const VB_H = 600
const px = (x) => (x / 100) * VB_W
const py = (y) => (y / 100) * VB_H

// A dogleg between two centres: out to the halfway line, across, then in. Streets
// turn corners; a straight diagonal between every pair reads as a cobweb.
function roadPath(from, to) {
  const a = centreOf(BUILDING[from])
  const b = centreOf(BUILDING[to])
  const mx = (a.x + b.x) / 2
  return `M ${px(a.x)} ${py(a.y)} L ${px(mx)} ${py(a.y)} L ${px(mx)} ${py(b.y)} L ${px(b.x)} ${py(b.y)}`
}

// How many of a building's twelve windows are lit: proportional to its share of the
// busiest building's load, so the base reads at a glance. Always at least one when
// there is ANY work — a building with three things in it should not look abandoned —
// and always zero when there is none.
const WINDOWS = 12
function litWindows(count, busiest) {
  if (!count) return 0
  return Math.max(1, Math.round((count / Math.max(1, busiest)) * WINDOWS))
}

const AGE = (iso) => {
  if (!iso) return null
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
  if (Number.isNaN(days)) return null
  return days <= 0 ? 'today' : `${days}d`
}

export default function Base({ orders = [], tasks = [], emails = [], events = [], onNavigate, viewFor }) {
  const [open, setOpen] = useState(null)

  // ── Fit the map to whatever room is actually left ─────────────────────────
  //
  // The app stacks a dismissible EDI-arrivals banner and the court strip above every
  // view, so the space above this map is not a constant — a fixed `calc(100vh - 280px)`
  // put the bottom row and the ticker below the fold on one screen and left a gap on
  // another. So measure the map's own top and publish the room below it as a CSS
  // variable; the stylesheet caps the WIDTH from it, which keeps the aspect ratio
  // exact (a squashed box would pull the roads off their buildings).
  const mapRef = useRef(null)
  useEffect(() => {
    const fit = () => {
      const el = mapRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top
      // Leaves room for the ticker and its gap beneath the map.
      const room = Math.max(320, window.innerHeight - top - 108)
      el.style.setProperty('--bsRoom', `${room}px`)
    }
    fit()
    window.addEventListener('resize', fit)
    // The banners appear and disappear as arrivals are dismissed, which moves the map
    // without a resize event. Re-measure when anything above it changes size.
    const ro = new ResizeObserver(fit)
    if (document.querySelector('main')) ro.observe(document.querySelector('main'))
    return () => { window.removeEventListener('resize', fit); ro.disconnect() }
  }, [])

  const states = useMemo(
    () => buildingStates({ orders, tasks, emails, events }),
    [orders, tasks, emails, events],
  )
  const movers = useMemo(() => moversFrom(events), [events])

  const busiest = Math.max(1, ...BUILDINGS.map((b) => states[b.key]?.count || 0))
  const sel = open ? BUILDING[open] : null
  const selState = open ? states[open] : null

  // ── Two modes: the whole base, or one building open as a WORKSPACE ────────
  //
  // Nima, 2026-08-21: "the most important part though is that clicking the building
  // opens that view to the right of the base so it can be navigated here… we want
  // this to replace having to switch to the other view."
  //
  // So an open building is not a panel over the map — it is a split screen: the
  // building zoomed on the left, and the REAL lane view on the right, live and fully
  // navigable. `viewFor` comes from App and hands back exactly the component the tab
  // would render, with exactly the props the tab would get, so the embedded copy
  // cannot drift from the tab.
  if (sel) {
    const embedded = viewFor?.(sel.view)
    return (
      <div className="bsWork">
        <div className="bsWorkLeft">
          <button className="btnGhost bsBack" onClick={() => setOpen(null)}>← the whole base</button>
          <BuildingInterior building={sel} state={selState} />
          {/* The items stay reachable here too: the embedded view is the lane's own
              surface, but a building's ALERTS are findings that live nowhere else. */}
          {!!(selState.alerts || []).length && (
            <div className="bsAlerts">
              {selState.alerts.map((a) => (
                <span key={a.key} className="bsAlertRow">
                  <b>{a.count}</b> {a.label}
                  <span className="bsAlertDocs">
                    {a.items.slice(0, 8).map((f) => (
                      <NsLink key={f.ifNumber || f.id} doc={f.ifNumber} />
                    ))}
                    {a.items.length > 8 ? ` +${a.items.length - 8}` : ''}
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="bsWorkRight">
          {embedded || (
            <div className="empty">
              This building has no view of its own yet — its work is in the panel on the left.
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="bsWrap">
      <div className="bsHead">
        <span className="bsTitle">Naghedi base</span>
        <span className="bsHint">
          Every building is a lane — click one to work from it. Every mover is a document
          that just changed lanes.
        </span>
        <span className="bsLive">● live</span>
      </div>

      <div className="bsMap" ref={mapRef}>
        <svg className="bsRoads" viewBox={`0 0 ${VB_W} ${VB_H}`} aria-hidden="true">
          <defs>
            <pattern id="bsDeck" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M40 0 L0 0 0 40" fill="none" stroke="#14304d" strokeWidth="0.8" opacity="0.5" />
            </pattern>
            {ROADS.map((r) => (
              <path key={r.key} id={`bsRoad-${r.key}`} d={roadPath(r.from, r.to)} />
            ))}
          </defs>

          <rect x="0" y="0" width={VB_W} height={VB_H} fill="url(#bsDeck)" />

          {/* Asphalt, then a dashed centre line — the two passes that make a line
              read as a street rather than a connector. */}
          {ROADS.map((r) => (
            <use key={`a-${r.key}`} href={`#bsRoad-${r.key}`} className="bsRoadBed" />
          ))}
          {ROADS.map((r) => (
            <use key={`l-${r.key}`} href={`#bsRoad-${r.key}`} className="bsRoadLine" />
          ))}

          {/* Movers travel the road PATH ITSELF via mpath, so a dot physically cannot
              leave the network — the guarantee the model exists to make good on. */}
          {movers.map((m, i) => (
            <circle key={m.id} r="5" className={`bsMover tone-${m.tone}`}>
              <animateMotion dur={`${16 + (i % 4) * 5}s`} begin={`-${i * 3}s`} repeatCount="indefinite">
                <mpath href={`#bsRoad-${m.road}`} />
              </animateMotion>
            </circle>
          ))}
        </svg>

        {BUILDINGS.map((b) => {
          const st = states[b.key] || { count: 0, oldest: null }
          const age = AGE(st.oldest)
          return (
            <button
              key={b.key}
              className={`bsBldg tone-${b.tone}${open === b.key ? ' bsBldgOpen' : ''}`}
              // ⚠️ HEIGHT IS DECLARED, not left to the image. The sprite used to size
              // by width with height:auto, so a building's real height came from the
              // PNG's aspect ratio while the roads met the centre implied by `h` — the
              // two disagreed, and tall sprites overflowed the map. Now the model's
              // geometry governs and the sprite fits inside it.
              style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` }}
              onClick={() => setOpen(open === b.key ? null : b.key)}
              title={`${b.label} — ${st.count} ${b.of}`}
            >
              <img src={`/base/${b.sprite}.png`} alt=""
                   className={`bsSprite${b.flip ? ' bsSpriteFlip' : ''}`} />
              {/* ── LIVED IN ─────────────────────────────────────────────────
                  Nima, 2026-08-21: "it'd be nice if the base looked lived in so
                  computer going off data flowing type of thing from the top view…
                  by live inside i mean in the building."
                  Windows lit on the roof, and the NUMBER LIT is proportional to the
                  work inside — so a busy building glows and a quiet one goes dark,
                  and neither invents a figure. A grid of lights that flickered
                  identically regardless of the data would be exactly the
                  looks-live-driven-by-nothing trap this base was built to avoid. */}
              <span className="bsWindows" aria-hidden="true">
                {Array.from({ length: 12 }, (_, i) => (
                  <span key={i}
                        className={'bsWin' + (i < litWindows(st.count, busiest) ? ' bsWinOn' : '')}
                        style={{ animationDelay: `${(i % 7) * 0.45}s` }} />
                ))}
              </span>
              <span className="bsPlate">
                <span className="bsName">{b.label}</span>
                {/* An uncountable building shows what it IS, not a fabricated zero. */}
                {b.countable === false
                  ? <span className="bsOpen">open</span>
                  : <span className="bsCount">{st.count}</span>}
                <span className="bsOf">{b.of}</span>
                {/* More than a number: how long the oldest thing here has sat.
                    Absent rather than zero when nothing carries a date. */}
                {age && <span className="bsAge">oldest {age}</span>}
                {/* A differently-named second fact, when there is one. It is NOT
                    folded into the count above — that is how a real finding gets
                    smuggled out of sight. */}
                {(st.alerts || []).map((a) => (
                  <span key={a.key} className="bsAlert">{a.count} {a.label}</span>
                ))}
              </span>
              {/* A load bar, relative to the busiest building — so the base reads at a
                  glance before any number is read. */}
              {b.countable !== false && (
                <span className="bsLoad"><span style={{ width: `${(st.count / busiest) * 100}%` }} /></span>
              )}
            </button>
          )
        })}
      </div>

      {/* What is on the roads right now, named. A dot you cannot identify is
          decoration; this is the line that makes it information. */}
      <div className="bsTicker">
        <span className="bsTickerLabel">In transit · {movers.length}</span>
        {!movers.length && <span className="bsTickerQuiet">Nothing has moved between lanes recently.</span>}
        {movers.map((m) => (
          <span key={m.id} className="bsTickerItem">
            <span className={`bsPip tone-${m.tone}`} />
            {m.docNumber ? <NsLink doc={m.docNumber} /> : null}
            <span className="bsTickerWhat">
              {m.label} · {BUILDING[m.from].label} → {BUILDING[m.to].label}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}
