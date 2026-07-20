import { useEffect, useState } from 'react'
import { fetchLaunchBay, fetchCustodyRegister, fetchEdiReview, fetchCredits, fetchAffection, fetchQuestEmails, createManualTask, completeQuestTask } from '../api.js'
import { computeEdiWork } from '../../../src/model/ediWork.js'
import { CHARACTERS } from '../../../src/model/characters.js'
import { spaceBackdrop } from '../data/spaceBackdrop.js'
import { STAGE_ORDER, STAGE_SHORT, sevClass, taskToCard, docRef, docDate, SourceBadge, Flags, LinkedText } from '../lib.jsx'
import { speakLine, taskContext } from '../../../src/model/dialogue.js'
import { imagesFor } from '../data/characterImages.js'

// Command Center (Nima, 2026-07-17) — the main hub, rebuilt as a monitoring
// CONSOLE instead of one undifferentiated blob. Every operation gets its own
// sector, so at a glance you know: the status of ALL orders (pipeline sector),
// what's physically moving (bay/custody sectors), what EDI is doing, and which
// task belongs where (task command groups by origin). Each sector links to its
// full view — the hub is the map, the tabs are the territory.

const dayAge = (o) => (o.daysPending != null ? `${o.daysPending}d` : '')

// ── small building blocks ────────────────────────────────────────────────────
function Sector({ title, count, onOpen, openLabel, children, tone, area, scroll }) {
  return (
    <section className={'sector' + (tone ? ` sector-${tone}` : '')} style={area ? { gridArea: area } : undefined}>
      <div className="sectorHead">
        <span className="sectorTitle">◤ {title}</span>
        {count != null && <span className="sectorCount">{count}</span>}
        {onOpen && (
          <button className="linkBtn sectorOpen" onClick={onOpen}>{openLabel || 'open'} ↗</button>
        )}
      </div>
      {scroll
        ? <div className="sectorScroll" style={typeof scroll === 'number' ? { maxHeight: scroll } : undefined}>{children}</div>
        : children}
    </section>
  )
}

// Live chrono readout — ship's clock in the core (Nima, 2026-07-20).
function CoreClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="coreClock">
      <span className="coreTime">{now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
      <span className="coreDate">{now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}</span>
    </div>
  )
}

// The cockpit canopy (Nima, 2026-07-20): the Command Center is the view from
// the ship — a framed viewport looking out on animated stars (or whatever
// image is dropped into assets/space/), with the console panels below it.
function Canopy() {
  return (
    <div className={'canopy' + (spaceBackdrop ? ' hasSpace' : '')}
         style={spaceBackdrop ? { backgroundImage: `url("${spaceBackdrop}")` } : undefined}>
      {!spaceBackdrop && <>
        <div className="canopyPlanet" />
        <div className="starLayer sl1" /><div className="starLayer sl2" /><div className="starLayer sl3" />
        <div className="shootingStar ss1" /><div className="shootingStar ss2" />
      </>}
      <div className="canopyVignette" />
      <div className="canopyGlass" />
      <div className="canopyStruts" />
      <span className="canopyLabel">FORWARD VIEWPORT · NAGHEDI COMMAND</span>
    </div>
  )
}

// New tasking straight from the core (Nima, 2026-07-20) — the quick version of
// Transmissions' form: subject + urgency + messenger, filed on the spot.
function CoreNewTask({ onRefresh }) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState({ subject: '', urgency: '', characterId: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  async function submit(e) {
    e.preventDefault()
    if (!draft.subject.trim()) return
    setBusy(true); setErr(null)
    try {
      await createManualTask(draft)
      setDraft({ subject: '', urgency: '', characterId: '' })
      setOpen(false)
      onRefresh?.()
    } catch (e2) { setErr(e2.message) } finally { setBusy(false) }
  }

  return (
    <>
      <button className="importBtn coreNewTask" onClick={() => setOpen(!open)}>＋ New task</button>
      {open && (
        <form className="coreTaskForm" onSubmit={submit}>
          <input autoFocus placeholder="What needs doing?" value={draft.subject}
                 onChange={(e) => setDraft({ ...draft, subject: e.target.value })} />
          <div className="coreTaskRow">
            <select value={draft.urgency} onChange={(e) => setDraft({ ...draft, urgency: e.target.value })}>
              <option value="">urgency…</option><option value="lo">low</option><option value="mid">medium</option><option value="hi">high</option>
            </select>
            <select value={draft.characterId} onChange={(e) => setDraft({ ...draft, characterId: e.target.value })}>
              <option value="">messenger (random)</option>
              {CHARACTERS.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="importBtn" disabled={busy || !draft.subject.trim()}>{busy ? '…' : 'File it'}</button>
            <button type="button" className="linkBtn" onClick={() => setOpen(false)}>cancel</button>
          </div>
          {err && <div className="boxNote bad">{err}</div>}
        </form>
      )}
    </>
  )
}

// Stylized starbird — an original simplified emblem in the spirit of the
// Alliance insignia, watermarked behind the core readouts.
function Starbird() {
  return (
    <svg className="coreInsignia" viewBox="0 0 100 100" aria-hidden="true">
      <path d="M50 8 L58 34 A22 22 0 0 1 72 62 L88 84 A46 46 0 0 0 62 32 L50 8 L38 32 A46 46 0 0 0 12 84 L28 62 A22 22 0 0 1 42 34 Z" />
      <circle cx="50" cy="58" r="12" fill="none" strokeWidth="3" />
    </svg>
  )
}

// The war-room table itself (Nima's Death-Star-briefing reference): a central
// circular tactical core with the day's vital readouts, radar sweep and all.
// Everything else on the console arranges AROUND it.
function TacticalCore({ orders, attention, bayStats, custodyCount, custodyList, waiting, crew, unreadComms, partnerScan, onNavigate, onRefresh }) {
  const allCrew = [...crew].sort((a, b) => (b.affection || 0) - (a.affection || 0))
  const missingArt = CHARACTERS.filter((c) => imagesFor(c.id).length === 0)
  return (
    <div className="tacticalCore" style={{ gridArea: 'core' }}>
      {/* corner readouts: ship's chrono top-left, comm traffic top-right */}
      <div className="coreCorner tl"><CoreClock /></div>
      <div className="coreCorner tr coreTrStack">
        <button className="coreComms" onClick={() => onNavigate('transmissions')}
                title="Unread transmissions awaiting review">
          <b>{unreadComms ?? '—'}</b>
          <span>incoming<br/>transmissions</span>
        </button>
        <CoreNewTask onRefresh={onRefresh} />
      </div>
      <div className="coreCenter">
      <div className="coreRing ringTicks" />
      <div className="coreRing ringDash" />
      <div className="coreSweep" />
      <Starbird />
      <div className="coreInner">
        <div className="coreLabel">NAGHEDI OPS CORE</div>
        <div className="coreBig">{orders}</div>
        <div className="coreBigLabel">orders in pipeline</div>
        <div className="coreStats">
          <span className={attention ? 'coreStat bad' : 'coreStat'}><b>{attention}</b> need attention</span>
          {bayStats && <span className="coreStat ok"><b>{bayStats.cleared}</b> cleared to launch</span>}
          {bayStats?.delayed > 0 && <span className="coreStat bad"><b>{bayStats.delayed}</b> delayed</span>}
          <span className="coreStat"><b>{custodyCount ?? '—'}</b> in custody</span>
          {waiting != null && <span className="coreStat amber"><b>{Math.round(waiting).toLocaleString()}</b> CR waiting</span>}
        </div>
      </div>
      </div>

      {/* EDI partner scan — red targeting readout, the "are we all green" check */}
      {partnerScan?.length > 0 && (
        <button className="partnerScan" onClick={() => onNavigate('edi')} title="EDI partner health — open the relay">
          <div className="scanTitle">◎ PARTNER SCAN</div>
          {partnerScan.slice(0, 5).map((p) => (
            <div key={p.tradingPartner} className={'scanRow h-' + p.health}>
              <span className="scanName">{p.tradingPartner.replace(/\s*\(.*$/, '')}</span>
              <span className="scanOpen">{p.open} open</span>
              <span className="scanState">{p.health === 'red' ? 'CRITICAL' : p.health === 'amber' ? 'WATCH' : 'NOMINAL'}</span>
            </div>
          ))}
        </button>
      )}

      {/* custody register readout — the physical-cargo channel, right in the core */}
      {custodyList?.length > 0 && (
        <button className="custodyScan" onClick={() => onNavigate('custody')} title="Custody register — open the full board">
          <div className="scanTitle cyan">◍ CUSTODY REGISTER</div>
          {custodyList.slice(0, 4).map((c) => (
            <div key={c.ifNumber} className={'scanRow ' + (c.stale ? 'h-red' : c.state === 'with_warehouse' ? 'h-amber' : 'h-green')}>
              <span className="scanName">{c.ifNumber} · {c.customer || 'unknown'}</span>
              <span className="scanOpen">{c.boxes > 0 ? `${c.boxes}📦` : ''}</span>
              <span className="scanState">{c.stale ? `STALE ${c.ageDays}d` : c.state === 'with_warehouse' ? 'AT WAREHOUSE' : 'IN HAND'}</span>
            </div>
          ))}
          {custodyList.length > 4 && <div className="scanRow"><span className="scanName cust">+ {custodyList.length - 4} more</span></div>}
        </button>
      )}

      {/* crew bonds — square holos in a left-to-right scroll as the roster grows */}
      {allCrew.length > 0 && (
        <div className="coreCrew crewScroll" title="Crew bonds — earned by finishing their quests">
          {allCrew.map((c) => {
            const img = imagesFor(c.characterId)[0]
            return (
              <span key={c.characterId} className="crewChip">
                {img ? <img src={img} alt="" /> : <i>◈</i>}
                <b>{c.character?.name?.split(' ')[0] || ''}</b>
                <em>{c.level?.name || ''}</em>
              </span>
            )
          })}
          {missingArt.length > 0 && (
            <button className="crewChip crewMissing" onClick={() => onNavigate('transmissions')}
                    title={'No portrait yet: ' + missingArt.map((c) => c.name).join(', ') + ' — the Crew section lists the exact filenames to drop in'}>
              <i>＋</i>
              <b>{missingArt.length} missing</b>
              <em>portraits</em>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function MiniOrder({ o }) {
  return (
    <div className={'miniRow ' + sevClass(o.severity)}>
      <span className="miniSo">{o.soNumber}</span>
      <span className="miniCust">{o.customer}</span>
      <span className="miniAge">{dayAge(o)}</span>
    </div>
  )
}

// A task card with its messenger's face + spoken line — the "who handed me
// this and what did they say" identity, kept identical to Transmissions.
// Clickable/expandable (Nima, 2026-07-20): full task access right here — no
// trip to Transmissions needed just to read or close a task.
function TaskChip({ t, onRefresh }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const img = imagesFor(t.characterId)[0]

  async function markDone(e) {
    e.stopPropagation()
    setBusy(true)
    try { await completeQuestTask(t.id, true); onRefresh?.() } finally { setBusy(false) }
  }

  return (
    <div className={'taskChip' + (open ? ' taskChipOpen' : '') + ' ' + sevClass(t.urgency === 'hi' ? 3 : t.urgency === 'mid' ? 2 : 1)}
         onClick={() => setOpen(!open)}>
      <div className="chipAvatar">
        {img ? <img src={img} alt="" /> : <span className="chipGlyph">◈</span>}
      </div>
      <div className="chipBody">
        <div className="chipTop">
          <b>{t.character?.name || 'Unknown Messenger'}</b>
          {t.urgency && <span className={'flag ' + (t.urgency === 'hi' ? 'sev-hi' : t.urgency === 'mid' ? 'sev-mid' : 'sev-lo')}>{t.urgency}</span>}
        </div>
        <div className="chipSpeech">“{speakLine(t.characterId, taskContext(t), t.id)}”</div>
        <div className="chipSubject"><LinkedText text={t.subject} /></div>
        {open && (
          <div className="chipExpand">
            <p className="holoSnippet"><LinkedText text={t.snippet} /></p>
            <div className="chipActions">
              <button className="btn" disabled={busy} onClick={markDone}>✓ Mark done</button>
              {t.threadId && (
                <a className="btnGhost" href={`https://mail.google.com/mail/u/0/#all/${t.threadId}`}
                   target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>↗ Gmail</a>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── the hub ──────────────────────────────────────────────────────────────────
export default function CommandCenter({ orders, tasks = [], onNavigate = () => {}, onRefresh }) {
  const [bay, setBay] = useState(null)
  const [custody, setCustody] = useState(null)
  const [edi, setEdi] = useState(null)
  const [credits, setCredits] = useState(null)
  const [crew, setCrew] = useState([])
  const [unreadComms, setUnreadComms] = useState(null)

  useEffect(() => {
    fetchLaunchBay().then(setBay).catch(() => setBay([]))
    fetchCustodyRegister().then(setCustody).catch(() => setCustody([]))
    fetchEdiReview().then(setEdi).catch(() => setEdi(null))
    fetchCredits().then(setCredits).catch(() => {})
    fetchAffection().then(setCrew).catch(() => {})
    fetchQuestEmails().then((r) => setUnreadComms((r.emails || []).filter((e) => e.isUnread).length)).catch(() => {})
  }, [])

  // ── orders by stage: the "status of all orders" answer ─────────────────────
  const byStage = STAGE_ORDER.map((s) => {
    const list = orders.filter((o) => o.stage === s)
    return {
      stage: s,
      n: list.length,
      hot: list.filter((o) => o.severity >= 2).length,
      worst: [...list].sort((a, b) => b.severity - a.severity || (b.daysPending || 0) - (a.daysPending || 0)).slice(0, 3),
    }
  }).filter((x) => x.n)

  // ── attention queue (orders + tasks merged, worst first) ───────────────────
  const openTasks = tasks.filter((t) => t.status === 'open')
  const attention = [
    ...orders.filter((o) => o.severity > 0),
    ...openTasks.map(taskToCard),
  ].sort((a, b) => b.severity - a.severity || (b.daysPending || 0) - (a.daysPending || 0))
  const topAttention = attention.slice(0, 8)

  // ── task command: WHERE each task belongs (origin groups) ──────────────────
  const taskGroups = [
    { key: 'protocol', label: 'Protocols · recurring duties', items: openTasks.filter((t) => t.recurringKey) },
    { key: 'transmission', label: 'Transmissions · from the comm relay', items: openTasks.filter((t) => !t.recurringKey && t.emailId) },
    { key: 'manual', label: 'Manual · logged by hand', items: openTasks.filter((t) => !t.recurringKey && !t.emailId) },
  ].filter((g) => g.items.length)

  // ── operations summaries ────────────────────────────────────────────────────
  const bayStats = bay && {
    cleared: bay.filter((s) => s.floating).length,
    delayed: bay.filter((s) => s.delayed).length,
    scannedIn: bay.filter((s) => s.state === 'scanned_in').length,
    grounded: bay.filter((s) => !s.floating).length,
  }
  const custodyStats = custody && {
    out: custody.filter((c) => c.state === 'with_warehouse').length,
    back: custody.filter((c) => c.state === 'returned').length,
    stale: custody.filter((c) => c.stale),
  }
  const ediWork = edi ? computeEdiWork(edi.orders || [], edi.resolutions || []) : null
  const ediStats = ediWork && {
    open: ediWork.totals.open,
    closed: ediWork.totals.closed,
    missed: ediWork.totals.missed,
    partners: ediWork.partners.slice(0, 3),
  }
  const partnerScan = ediWork
    ? ediWork.partners.map((p) => ({
        ...p, health: p.missed > 0 || p.cancelDanger > 0 ? 'red' : p.issues > 0 ? 'amber' : 'green',
      }))
    : null

  return (
    <div className="commandCenter">
      <Canopy />
      {/* status strip — the whole pipeline in one row */}
      <div className="stageStrip">
        {byStage.map(({ stage, n, hot }) => (
          <button key={stage} className="stagePill clickable" onClick={() => onNavigate('kanban')}>
            <b>{n}</b>
            <span>{STAGE_SHORT[stage]}</span>
            {hot > 0 && <em className="hotDot" title={`${hot} need attention`}>{hot}</em>}
          </button>
        ))}
      </div>

      <div className="sectorGrid radial">
        {/* ── the war-room core, everything arranged around it ── */}
        <TacticalCore
          orders={orders.length} attention={attention.length}
          bayStats={bayStats} custodyCount={custody?.length} custodyList={custody} waiting={credits?.waiting} crew={crew}
          unreadComms={unreadComms} partnerScan={partnerScan} onNavigate={onNavigate} onRefresh={onRefresh}
        />

        {/* ── attention queue ── */}
        <Sector area="attn" scroll={560} title="ATTENTION QUEUE" count={attention.length} tone={attention.length ? 'hot' : undefined}
                onOpen={() => onNavigate('kanban')} openLabel="missions">
          {topAttention.map((o) => (
            <div key={o.soNumber} className={'miniCard ' + sevClass(o.severity)}>
              <div className="miniCardTop">
                <span className="miniSo">{o.soNumber}</span>
                <SourceBadge source={o.source} character={o.character} />
                <span className="miniCust">{o.customer}</span>
              </div>
              <div className="miniNext">→ {o.nextAction}{docRef(o) && <span className="ifs"> · {docRef(o)}{docDate(o) && ` · ${docDate(o)}`}</span>}</div>
              <Flags flags={o.flags} />
            </div>
          ))}
          {attention.length > 8 && <div className="moreLine">+ {attention.length - 8} more in Mission Quests</div>}
          {!attention.length && <div className="empty">All quiet — nothing needs attention 🎉</div>}
        </Sector>

        {/* ── order pipeline: every stage, worst offenders ── */}
        <Sector area="pipe" title="ORDER PIPELINE" count={orders.length} onOpen={() => onNavigate('table')} openLabel="table">
          <div className="stageBoard">
            {byStage.map(({ stage, n, worst }) => (
              <div key={stage} className="stageCell">
                <div className="stageCellHead">
                  <span>{STAGE_SHORT[stage]}</span><b>{n}</b>
                </div>
                {worst.map((o) => <MiniOrder key={o.soNumber} o={o} />)}
              </div>
            ))}
          </div>
        </Sector>

        {/* ── operations row ── */}
        <Sector area="launch" title="LAUNCH BAY" count={bay?.length} tone={bayStats?.delayed ? 'hot' : undefined}
                onOpen={() => onNavigate('launch')} openLabel="bay">
          {!bay && <div className="empty">Scanning the bay…</div>}
          {bayStats && (
            <>
              <div className="opStats">
                <span className="opStat ok"><b>{bayStats.cleared}</b> cleared</span>
                <span className="opStat"><b>{bayStats.grounded}</b> grounded</span>
                {bayStats.scannedIn > 0 && <span className="opStat info"><b>{bayStats.scannedIn}</b> prep to ship</span>}
                {bayStats.delayed > 0 && <span className="opStat bad"><b>{bayStats.delayed}</b> delayed</span>}
              </div>
              {bay.filter((s) => s.delayed).map((s) => (
                <div key={s.ifNumber} className="miniRow sev-hi">
                  <span className="miniSo">{s.ifNumber}</span>
                  <span className="miniCust">should have launched {s.floatingDays}d ago</span>
                </div>
              ))}
            </>
          )}
        </Sector>

        <Sector area="custody" title="CUSTODY" count={custody?.length} tone={custodyStats?.stale.length ? 'hot' : undefined}
                onOpen={() => onNavigate('custody')} openLabel="register">
          {!custody && <div className="empty">Checking the register…</div>}
          {custodyStats && (
            <>
              <div className="opStats">
                <span className="opStat"><b>{custodyStats.out}</b> with warehouse</span>
                <span className="opStat ok"><b>{custodyStats.back}</b> back in our hands</span>
              </div>
              {custodyStats.stale.map((c) => (
                <div key={c.ifNumber} className="miniRow sev-hi">
                  <span className="miniSo">{c.ifNumber}</span>
                  <span className="miniCust">sitting {c.ageDays}d with no movement</span>
                </div>
              ))}
            </>
          )}
        </Sector>

        <Sector area="edi" title="EDI RELAY" count={ediStats ? ediStats.open + ediStats.closed : undefined}
                tone={ediStats?.missed ? 'hot' : undefined}
                onOpen={() => onNavigate('edi')} openLabel="edi">
          {!edi && <div className="empty">Reading the relay…</div>}
          {ediStats && (
            <>
              <div className="opStats">
                <span className="opStat bad"><b>{ediStats.open}</b> open</span>
                <span className="opStat ok"><b>{ediStats.closed}</b> closed</span>
                {ediStats.missed > 0 && <span className="opStat bad"><b>{ediStats.missed}</b> missed?</span>}
              </div>
              {ediStats.partners.map((p) => (
                <div key={p.tradingPartner} className="miniRow">
                  <span className="miniSo">{p.tradingPartner.replace(/\s*\(.*$/, '')}</span>
                  <span className="miniCust">{p.open} open · {p.closed} closed</span>
                </div>
              ))}
            </>
          )}
        </Sector>

        {/* ── task command: what belongs where ── */}
        <Sector area="tasks" scroll={560} title="TASK COMMAND" count={openTasks.length} onOpen={() => onNavigate('transmissions')} openLabel="transmissions">
          {taskGroups.map((g) => (
            <div key={g.key} className="taskGroup">
              <div className="taskGroupHead">{g.label} <span className="sectorCount">{g.items.length}</span></div>
              {g.items.map((t) => <TaskChip key={t.id} t={t} onRefresh={onRefresh} />)}
            </div>
          ))}
          {!openTasks.length && <div className="empty">No open tasks — the crew is idle.</div>}
        </Sector>
      </div>
    </div>
  )
}
