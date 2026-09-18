import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { BUILDINGS, ROADS, BUILDING, centreOf, buildingStates, moversFrom } from '../../../src/model/baseMap.js'
import { rankFor } from '../../../src/model/crewRank.js'
import { imagesFor } from '../data/characterImages.js'
import { faceFor } from '../data/crewFaces.js'
import { CHARACTERS } from '../../../src/model/characters.js'
import { crewOnRoads } from '../../../src/model/crewOnBase.js'

const CREW_NAME = new Map(CHARACTERS.map((c) => [c.id, c.name]))

// ⚠️ AN UNMANNED POST SAYS SO, rather than showing nothing (Nima, 2026-09-18: "either
// see character assigned to the building or a message in the building letting us know
// they need a crew member to operate"). Today NOTHING is posted anywhere — no rank has
// been conferred and there is no posting table yet — so every building shows the empty
// state. That is the honest picture, not a placeholder: the Base is unmanned until
// somebody is promoted and posted.
function CrewSlot({ building, posting }) {
  const need = rankFor(building.minRank)
  if (!posting) {
    return (
      <span className="bsCrew bsCrewEmpty"
            title={need ? `No one is posted here. Needs ${need.name} or above.` : 'No one is posted here.'}>
        <span className="bsCrewFace bsCrewNone" aria-hidden="true">?</span>
        {/* ⚠️ COMPACT ON PURPOSE. The full sentence is in the tooltip; spelled out on the
            plate it made every building wider than its own footprint and the Scan bay's
            plate overlapped both its neighbours. Fourteen copies of "needs a crew
            member" is also noise — the empty seat and the rank say it. */}
        <span className="bsCrewText">needs crew{need ? <span className="bsCrewRank">{need.name}+</span> : null}</span>
      </span>
    )
  }
  const face = faceFor(posting.characterId) || imagesFor(posting.characterId)?.[0] || null
  const name = CREW_NAME.get(posting.characterId) || posting.characterId
  const held = rankFor(posting.rank)
  return (
    <span className="bsCrew" title={`${held ? held.name + ' ' : ''}${name} is posted here`}>
      {face
        ? <img className="bsCrewFace" src={face} alt="" />
        : <span className="bsCrewFace bsCrewNone" aria-hidden="true">{name.slice(0, 1)}</span>}
      <span className="bsCrewText">
        {name}{held ? <span className="bsCrewRank">{held.name}</span> : null}
      </span>
    </span>
  )
}

// ⚠️ AN UNCOUNTABLE BUILDING MUST NOT BE DESCRIBED WITH A ZERO (fixed 2026-09-18).
// The visible plate has always shown "open" for the Archive, the Catalogue and now
// Seasons — but the TOOLTIP read "Archive — 0 trace anything", fabricating exactly the
// figure the plate refuses to invent, and the two disagreed on the same button. The
// screen-reader name is the tooltip, so the only version some people get was the wrong
// one. One helper, used by both call sites, so they cannot drift again.
const buildingTitle = (b, count) =>
  (b.countable === false ? `${b.label} — ${b.of}` : `${b.label} — ${count} ${b.of}`)
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
const VB_H = 600            // starting guess only; the real height is measured
const px = (x) => (x / 100) * VB_W

// A dogleg between two centres: out to the halfway line, across, then in. Streets
// turn corners; a straight diagonal between every pair reads as a cobweb.
// `vbH` is passed in because the viewBox height follows the rendered box — see the
// note in the component.
function roadPath(from, to, vbH, viaY = null) {
  const a = centreOf(BUILDING[from])
  const b = centreOf(BUILDING[to])
  const py = (y) => (y / 100) * vbH
  // ⚠️ A CORRIDOR ROUTE, when the road asks for one. The halfway dogleg turns in the
  // middle of the map, which is fine between neighbours and drives a road straight
  // through whatever sits between two buildings that are far apart. `viaY` instead goes
  // UP first, runs along an empty horizontal band, and comes down — see CORRIDOR_Y.
  if (viaY != null) {
    return `M ${px(a.x)} ${py(a.y)} L ${px(a.x)} ${py(viaY)} L ${px(b.x)} ${py(viaY)} L ${px(b.x)} ${py(b.y)}`
  }
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

// ⚠️ `postings` IS AN INPUT, not something this view fetches or invents. It arrives as
// {buildingKey: {characterId, rank}} and is EMPTY today — see CrewSlot.
export default function Base({ orders = [], tasks = [], emails = [], events = [], containers = null, postings = {}, crewRoster = [], onNavigate, viewFor }) {
  // ── OPENING A BUILDING, WITHOUT MAKING THE CLICK WAIT FOR IT ──────────────
  //
  // Measured 2026-08-21 in Nima's Performance panel: INP 208ms on a pointer, against
  // an LCP of 0.53s and a CLS of 0.00 — so loading was never the problem, RESPONDING
  // was. Measured cause: opening a building takes the page from 456 to 1,181 DOM
  // elements (44 Kanban cards among them) in one synchronous render, and the browser
  // cannot paint anything — not even the glow on the building just clicked — until
  // that finishes.
  //
  // `armed` is the urgent half: it is the clicked key and nothing else, so React can
  // paint the building lit on the very next frame. `open` is the same value again
  // inside a transition, which lets React build the heavy tree without blocking that
  // paint.
  //
  // ⚠️ THIS DOES NOT MAKE THE VIEW MOUNT ANY FASTER, and it should not be described
  // that way. The work is identical; what changes is that the click is ANSWERED first.
  // Time-to-Kanban is unchanged, time-to-feedback goes from 208ms to one frame.
  const [open, setOpen] = useState(null)
  const [armed, setArmed] = useState(null)
  const [, startTransition] = useTransition()
  const openBuilding = (key) => {
    const next = armed === key ? null : key
    setArmed(next)                                 // urgent — paints immediately
    startTransition(() => setOpen(next))           // deferred — the 725-node mount
  }

  // ── The viewBox follows the box, so nothing distorts ─────────────────────
  //
  // ⚠️ CSS OWNS THE MAP'S SIZE NOW, and this measurement only refines the SVG's
  // viewBox. The previous version computed the WIDTH from a measured height, and it
  // could LATCH: measured once while the layout was still settling it fell back to the
  // 320px floor and stayed there — a 533x320 map on a 1920x1080 screen with 1,387px of
  // horizontal waste, which is exactly what Nima was looking at. Sizing in CSS cannot
  // latch, and if this measurement never lands the only cost is a slightly stretched
  // road, not a tiny base.
  //
  // The viewBox height is derived from the rendered aspect so roads and buildings share
  // one coordinate space at any window size. preserveAspectRatio="none" would have been
  // one line, but it scales stroke widths unevenly and the roads would go oval.
  const mapRef = useRef(null)
  const [vbH, setVbH] = useState(VB_H)
  useEffect(() => {
    const el = mapRef.current
    if (!el) return undefined
    const measure = () => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) setVbH(Math.round(VB_W * (r.height / r.width)))
    }
    // ⚠️ NO requestAnimationFrame HERE, and that is not a style preference. A version
    // of this deferred the measurement one frame to let layout settle; rAF DOES NOT
    // FIRE in a hidden or background tab, so the callback never ran, `vbH` stayed at
    // its initial 600, and the SVG letterboxed its 1000x600 viewBox inside a 1.93 box
    // — drawing every road up to 87px inboard of the building it was supposed to reach.
    // Measuring straight from the observer is what worked, so it is what this does.
    //
    // A timeout for the settle instead: it still fires when a frame would not, and the
    // observer corrects anything it catches early anyway.
    // Measure now, and again once layout has settled. The trailing pass matters on
    // RESIZE too, not just at mount: the observer fires mid-layout, so the first read
    // can be one step behind and leaves the roads slightly inboard of their buildings
    // until something else changes size.
    let settle = 0
    const bump = () => {
      measure()
      clearTimeout(settle)
      settle = setTimeout(measure, 150)
    }
    bump()
    const ro = new ResizeObserver(bump)
    ro.observe(el)
    return () => { clearTimeout(settle); ro.disconnect() }
  }, [])

  const states = useMemo(
    () => buildingStates({ orders, tasks, emails, events, containers }),
    // ⚠️ `containers` BELONGS IN THE DEPS. It arrives after the first paint (its own
    // fetch), and without it here the Landing bay would stay at its loading state — the
    // count frozen as unknown while the data sat in props.
    [orders, tasks, emails, events, containers],
  )
  const movers = useMemo(() => moversFrom(events), [events])
  // ⚠️ THE DOTS BECOME FACES — of the crew NOT on duty (Nima, 2026-09-18). Seeded on the
  // mover's id inside crewOnRoads, never Math.random(), so the map does not reshuffle on
  // every render. The posted crew are excluded: somebody manning the Pack house should
  // not also be walking the road to it.
  const postedIds = useMemo(
    () => new Set(Object.values(postings).map((p) => p?.characterId).filter(Boolean)), [postings])
  const walkers = useMemo(
    () => crewOnRoads({ movers, roster: crewRoster.length ? crewRoster : CHARACTERS, postedIds }),
    [movers, crewRoster, postedIds])

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
          {/* Nima, 2026-08-21: "instead of what is above it being a link to going
              back to the overall base view, a link to the other buildings." Going
              back is the building image itself now; this strip is how you cross the
              base without returning to it first — the point of the workspace being
              that you never have to switch views.
              ⚠️ Routed through openBuilding, so switching keeps the urgent-paint
              split from #151: the new lane lights immediately, its view follows. */}
          <div className="bsWorkNav">
            {BUILDINGS.filter((b) => b.key !== sel.key).map((b) => (
              <button key={b.key} type="button"
                      className={`bsNavBtn tone-${b.tone}`}
                      onClick={() => openBuilding(b.key)}
                      title={buildingTitle(b, states[b.key]?.count ?? 0)}>
                <span className="bsNavLabel">{b.label}</span>
                {/* ⚠️ And no digit at all for an uncountable building — see buildingTitle. */}
                {b.countable !== false && <span className="bsNavN">{states[b.key]?.count ?? 0}</span>}
              </button>
            ))}
          </div>
          <BuildingInterior building={sel} state={selState}
                            posting={postings[sel.key] ? {
                              ...postings[sel.key],
                              name: CREW_NAME.get(postings[sel.key].characterId) || postings[sel.key].characterId,
                            } : null}
                            onBack={() => openBuilding(null)} />
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

      <div className="bsField">
      <div className="bsMap" ref={mapRef}>
        <svg className="bsRoads" viewBox={`0 0 ${VB_W} ${vbH}`} aria-hidden="true">
          <defs>
            <pattern id="bsDeck" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M40 0 L0 0 0 40" fill="none" stroke="#14304d" strokeWidth="0.8" opacity="0.5" />
            </pattern>
            {ROADS.map((r) => (
              <path key={r.key} id={`bsRoad-${r.key}`} d={roadPath(r.from, r.to, vbH, r.viaY ?? null)} />
            ))}
          </defs>

          <rect x="0" y="0" width={VB_W} height={vbH} fill="url(#bsDeck)" />

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
          {/* ⚠️ A CLIPPED PORTRAIT, NOT AN <image> ALONE — an unclipped one is a square
              on a road. The clip path is defined once and reused. ⚠️ AND THE ANIMATION
              IS UNCHANGED: still SMIL following the road path, so the browser drives it
              and the app does no work per frame. A face costs a decode, not a frame. */}
          <defs>
            <clipPath id="bsWalkerClip"><circle cx="0" cy="0" r="9" /></clipPath>
          </defs>
          {walkers.map((m, i) => {
            const src = m.characterId ? (faceFor(m.characterId) || imagesFor(m.characterId)?.[0] || null) : null
            return (
              <g key={m.id} className={`bsMover tone-${m.tone}`}>
                <animateMotion dur={`${16 + (i % 4) * 5}s`} begin={`-${i * 3}s`} repeatCount="indefinite">
                  <mpath href={`#bsRoad-${m.road}`} />
                </animateMotion>
                {src
                  ? (
                    <>
                      <image href={src} x="-9" y="-9" width="18" height="18"
                             clipPath="url(#bsWalkerClip)" preserveAspectRatio="xMidYMid slice" />
                      <circle r="9" className="bsWalkerRing" />
                    </>
                  )
                  /* ⚠️ No crew left means the dot stays — never a blank gap on the road. */
                  : <circle r="5" className="bsMoverDot" />}
              </g>
            )
          })}
        </svg>

        {BUILDINGS.map((b) => {
          const st = states[b.key] || { count: 0, oldest: null }
          const age = AGE(st.oldest)
          return (
            <button
              key={b.key}
              className={`bsBldg tone-${b.tone}${armed === b.key ? ' bsBldgOpen' : ''}`}
              // ⚠️ HEIGHT IS DECLARED, not left to the image. The sprite used to size
              // by width with height:auto, so a building's real height came from the
              // PNG's aspect ratio while the roads met the centre implied by `h` — the
              // two disagreed, and tall sprites overflowed the map. Now the model's
              // geometry governs and the sprite fits inside it.
              style={{ left: `${b.x}%`, top: `${b.y}%`, width: `${b.w}%`, height: `${b.h}%` }}
              onClick={() => openBuilding(b.key)}
              title={buildingTitle(b, st.count)}
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
                <CrewSlot building={b} posting={postings[b.key] || null} />
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

      {/* What is on the roads right now, named — a dot you cannot identify is
          decoration, and this is the line that makes it information.
          ⚠️ A SIDE RAIL, not a strip beneath the map (Nima, 2026-08-21: "perhaps we can
          open space by having the top banner and lower banner beneath the base go to
          the side"). As a full-width strip it cost 68px of the one dimension the map
          was starved of. */}
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
    </div>
  )
}
