// client/src/views/Barracks.jsx — where the crew are ranked and posted.
//
// ┌─ IN PLAIN WORDS ───────────────────────────────────────────────────────────┐
// │ Two jobs on one screen:                                                     │
// │                                                                             │
// │  PROMOTE — every crew member with the evidence for a promotion, and a        │
// │            dropdown to grant one. The app suggests; you decide.              │
// │  POST    — each building and who is manning it today.                        │
// │                                                                             │
// │ Bond (how much you have worked with someone) is earned automatically and     │
// │ cannot be given. Rank is given by you and cannot be earned. The screen shows │
// │ both side by side so the case for a promotion is visible while you make it.  │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// ⚠️ THIS FILE DECIDES NOTHING. The ladder, the eligibility gate, the recommendation and
// its evidence all come from src/model/crewRank.js through /api/barracks. Logic in a
// .jsx is logic with no test — the rule from [[marked-shipped-is-not-departed]].

import { useEffect, useState } from 'react'
import { fetchBarracks, grantRank, postCrew } from '../api.js'
import { imagesFor } from '../data/characterImages.js'
import { faceFor } from '../data/crewFaces.js'

const face = (id) => faceFor(id) || imagesFor(id)?.[0] || null

function Portrait({ id, name, size = 34 }) {
  const src = face(id)
  return src
    ? <img className="bkFace" src={src} alt="" style={{ width: size, height: size }} />
    : <span className="bkFace bkFaceNone" style={{ width: size, height: size }}>{(name || '?').slice(0, 1)}</span>
}

function RankPicker({ member, ranks, onDone }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const held = member.record?.rank || ''
  const send = async (rank) => {
    setBusy(true); setErr(null)
    try { await grantRank({ characterId: member.id, rank: rank || null, by: 'Nima' }); await onDone() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  return (
    <span className="bkRankPick">
      <select value={held} disabled={busy} onChange={(e) => send(e.target.value)}>
        {/* ⚠️ The empty option CLEARS the rank back to Recruit — it is not "no change".
            crewRank.js treats a missing row as never-granted rather than demoted. */}
        <option value="">Recruit (no rank granted)</option>
        {ranks.filter((r) => r.key !== 'recruit').map((r) => (
          <option key={r.key} value={r.key}>{r.name}</option>
        ))}
      </select>
      {err && <span className="bkErr">{err}</span>}
    </span>
  )
}

function CrewRow({ member, ranks, onDone }) {
  const rec = member.recommendation
  return (
    <tr className={rec.promote ? 'bkCase' : ''}>
      <td><Portrait id={member.id} name={member.name} size={30} /></td>
      <td>
        <div className="bkName">{member.name}</div>
        <div className="muted bkUniverse">{member.universe}</div>
      </td>
      <td>
        <span className="pill">{member.bond.name}</span>
        <span className="muted"> {member.bond.points.toLocaleString()}</span>
      </td>
      <td className="num">{member.missions}</td>
      <td>
        {member.record
          ? (
            <span title={`granted by ${member.record.grantedBy || 'someone'} on ${String(member.record.grantedAt).slice(0, 10)}`}>
              {ranks.find((r) => r.key === member.record.rank)?.name || member.record.rank}
            </span>
          )
          : <span className="muted">Recruit</span>}
      </td>
      <td className="bkCaseCell">
        {/* ⚠️ THE EVIDENCE, NOT JUST A VERDICT. "Promote?" with no basis trains somebody
            to click yes. See crewRank.recommend — the sentence is built there. */}
        {rec.promote
          ? <span className="bkSuggest">→ {rec.target.name}<span className="muted"> · {rec.why}</span></span>
          : <span className="muted">{rec.why}</span>}
      </td>
      <td><RankPicker member={member} ranks={ranks} onDone={onDone} /></td>
    </tr>
  )
}

function PostRow({ post, crew, ranks, onDone }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const need = post.minRank ? ranks.find((r) => r.key === post.minRank) : null
  const send = async (characterId) => {
    setBusy(true); setErr(null)
    try { await postCrew({ building: post.key, characterId: characterId || null, by: 'Nima' }); await onDone() }
    catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  // ⚠️ ONLY THOSE WHO MAY HOLD THIS POST are offered. Listing everyone and refusing on
  // submit teaches people to try things; the gate belongs in the list.
  const eligible = crew.filter((c) => {
    if (!need) return true
    const held = ranks.find((r) => r.key === (c.record?.rank || 'recruit'))
    return (held?.level || 1) >= need.level
  })
  return (
    <tr className={post.characterId ? '' : 'bkEmpty'}>
      <td><Portrait id={post.characterId} name={post.characterName} size={30} /></td>
      <td><div className="bkName">{post.label}</div>
        <div className="muted bkUniverse">{need ? `${need.name} or above` : 'open to all ranks'}</div></td>
      <td colSpan={3}>
        {post.characterId
          ? <span>{post.characterName}{post.underRanked && <span className="pill danger"> outranked by this post</span>}</span>
          : <span className="muted">nobody is posted here</span>}
      </td>
      <td colSpan={2}>
        <select value={post.characterId || ''} disabled={busy} onChange={(e) => send(e.target.value)}>
          <option value="">— nobody —</option>
          {eligible.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {/* ⚠️ A refusal from the server is SHOWN. It carries the reason — "already posted
            to X today", or the rank required — and a bare "failed" would waste a trip. */}
        {err && <span className="bkErr">{err}</span>}
        {!eligible.length && <span className="bkErr">nobody holds {need?.name} yet</span>}
      </td>
    </tr>
  )
}

export default function Barracks() {
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const load = () => fetchBarracks().then(setData).catch((e) => setErr(e.message))
  useEffect(() => { load() }, [])

  if (err) return <div className="view"><p className="pill danger">{err}</p></div>
  if (!data) return <div className="view"><p className="muted">Opening the barracks…</p></div>

  const byChar = new Map(data.crew.map((c) => [c.id, c]))
  const posts = [...data.unmanned.map((u) => ({ ...u })), ...data.postings.map((p) => {
    const b = data.byBuilding[p.building] || {}
    return {
      key: p.building, label: p.building, minRank: null,
      characterId: p.characterId, characterName: byChar.get(p.characterId)?.name || p.characterId,
      underRanked: b.underRanked,
    }
  })].sort((a, b) => String(a.label).localeCompare(String(b.label)))

  const cases = data.crew.filter((c) => c.recommendation.promote).length

  return (
    <div className="view barracks">
      <header className="seasons-head">
        <h2>Barracks</h2>
        <div className="season-figs">
          <span className="pill">{data.crew.length} crew</span>
          <span className="pill">{data.postings.length} posted today</span>
          {data.unmanned.length > 0 && <span className="pill warn">{data.unmanned.length} posts unmanned</span>}
          {cases > 0 && <span className="pill fresh">{cases} earned a promotion</span>}
        </div>
      </header>
      <p className="muted seasons-note">
        <strong>Bond</strong> is earned by working together and cannot be given.
        <strong> Rank</strong> is given by you and cannot be earned. Bond only makes the case —
        every promotion below is yours.
      </p>

      <section className="card">
        <h3>Posts — today, {data.day}</h3>
        <table className="grid bkTable">
          <tbody>
            {posts.map((p) => <PostRow key={p.key} post={p} crew={data.crew} ranks={data.ranks} onDone={load} />)}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h3>The crew</h3>
        <table className="grid bkTable">
          <thead>
            <tr><th /><th>Name</th><th>Bond</th><th className="num">Missions</th><th>Rank</th><th>The case</th><th>Grant</th></tr>
          </thead>
          <tbody>
            {data.crew.map((c) => <CrewRow key={c.id} member={c} ranks={data.ranks} onDone={load} />)}
          </tbody>
        </table>
      </section>
    </div>
  )
}
