// The inside of a building — the close-up you get when you zoom in on one.
//
// Nima, 2026-08-21: "we want a zoomed in view of that building still from the top and
// to the side… with the internal close up of the building with computers and stuff
// flashing".
//
// So: the sprite blown up (still top-down, as asked), and beneath it an operations
// console. The console is deliberately NOT decoration — every readout on it is that
// building's own live number, and the one that is a real finding is the one that
// blinks. A wall of invented lights would be the "looks live, driven by nothing"
// trap that the whole base was designed to avoid.
//
// Hand-drawn rather than rendered: `bay.glb` has no interiors, so there is nothing to
// photograph. Drawn in the same amber-on-deck palette as the sprites so the zoom feels
// like the same place.

const CRT_ROWS = 7

import { imagesFor } from '../data/characterImages.js'
import { faceFor } from '../data/crewFaces.js'

export default function BuildingInterior({ building, state, posting = null, onBack }) {
  const alerts = state?.alerts || []
  const count = state?.count ?? 0

  return (
    <div className={`biWrap tone-${building.tone}`}>
      {/* ── The building itself, zoomed, still from above ───────────────────
          Nima, 2026-08-21: "clicking that coms tower image should take you back to
          the base". So the building you are standing in IS the way out — the same
          gesture that brought you here, reversed. The strip above is no longer a
          back link but a way across to the other buildings.
          ⚠️ A <button>, and safe as one: this subtree is an img and a span, so
          there is no button-in-button (the trap TacticalCore's custody rows hit). */}
      <button type="button" className="biZoom" onClick={onBack}
              title={`Back to the base — leave ${building.label}`}
              aria-label={`Back to the base — leave ${building.label}`}>
        <img src={`/base/${building.sprite}.png`} alt="" className="biSprite" />
        {/* A scan line crossing the roof: the only ornament here, and it says
            "this building is being looked at" rather than inventing data. */}
        <span className="biScan" />
        {/* The affordance. Without it the image is a secret door. */}
        <span className="biBackHint">← the whole base</span>

        {/* ⚠️ WHO MANS THIS BUILDING, LARGE, IN THE TOP-RIGHT (Nima, 2026-09-18: "the
            portrait should be in the top right corner as big as we can without
            conflicting with the actual base"). The sprite is centred and its corners are
            empty, so this claims space nothing else uses.
            ⚠️ IT IS AN <img> AND A <span>, DELIBERATELY. This subtree lives inside the
            back button, and anything interactive here would be a button in a button —
            the trap the note above records. Clicking the portrait leaves the building,
            exactly like clicking the roof does, so the gesture stays consistent. */}
        <span className={`biStageCrew${posting?.characterId ? '' : ' biStageCrewEmpty'}`}>
          {posting?.characterId && (faceFor(posting.characterId) || imagesFor(posting.characterId)?.[0])
            ? <img className="biStageFace"
                   src={faceFor(posting.characterId) || imagesFor(posting.characterId)[0]} alt="" />
            : <span className="biStageFace biStageFaceNone">?</span>}
          <span className="biStageWho">
            {posting?.characterId
              ? (
                <>
                  <span className="biStageName">{posting.name || posting.characterId}</span>
                  {posting.rank && <span className="biStageRank">{posting.rank}</span>}
                </>
              )
              : (
                <>
                  <span className="biStageName">unmanned</span>
                  {building.minRank && <span className="biStageRank">needs {building.minRank}</span>}
                </>
              )}
          </span>
        </span>
      </button>

      {/* ── The console ───────────────────────────────────────────────────── */}
      <div className="biConsole">
        <div className="biConsoleTop">
          <span className="biName">{building.label}</span>
          <span className="biSub">interior · live</span>
          {/* ⚠️ WHO IS STANDING IN HERE. Nima, 2026-09-18: "we need the associated
              character to show up in the in building view as the building does". An
              unmanned post SAYS SO rather than showing nothing — the empty state is the
              whole reason the ladder exists. */}
          <span className={`biCrew${posting?.characterId ? '' : ' biCrewEmpty'}`}>
            {posting?.characterId
              ? (
                <>
                  {faceFor(posting.characterId) || imagesFor(posting.characterId)?.[0]
                    ? <img className="biCrewFace" src={faceFor(posting.characterId) || imagesFor(posting.characterId)[0]} alt="" />
                    : <span className="biCrewFace biCrewNone">{(posting.name || '?').slice(0, 1)}</span>}
                  <span className="biCrewText">
                    {posting.name || posting.characterId}
                    {posting.rank && <span className="biCrewRank">{posting.rank}</span>}
                    {posting.underRanked && <span className="pill danger">outranked by this post</span>}
                  </span>
                </>
              )
              : (
                <>
                  <span className="biCrewFace biCrewNone">?</span>
                  <span className="biCrewText">
                    unmanned{building.minRank ? ` · needs ${building.minRank}` : ''}
                  </span>
                </>
              )}
          </span>
        </div>

        <div className="biBanks">
          {/* Bank 1: the headline, big, on its own CRT. */}
          <div className="biCrt biCrtBig">
            <span className="biCrtNum">{count}</span>
            <span className="biCrtCap">{building.of}</span>
          </div>

          {/* Bank 2: indicator lamps. The count of LIT lamps is the count of items,
              capped by the row — so a busy building is visibly lit and an empty one
              is visibly dark, without either lying about a number. */}
          <div className="biLamps" aria-hidden="true">
            {Array.from({ length: CRT_ROWS * 6 }, (_, i) => (
              <span
                key={i}
                className={`biLamp${i < Math.min(count, CRT_ROWS * 6) ? ' biLampOn' : ''}`}
                style={{ animationDelay: `${(i % 11) * 0.32}s` }}
              />
            ))}
          </div>
        </div>

        {/* Bank 3: the readouts that are real findings. These BLINK — the only thing
            here that does — because they are the only thing that wants an answer. */}
        {!!alerts.length && (
          <div className="biAlerts">
            {alerts.map((a) => (
              <div key={a.key} className="biAlertRow">
                <span className="biAlertPip" />
                <b>{a.count}</b> {a.label}
              </div>
            ))}
          </div>
        )}

        {state?.oldest && (
          <div className="biOldest">
            oldest here <b>{new Date(state.oldest).toLocaleDateString()}</b>
          </div>
        )}

        {/* A running trace across the bottom — pure chrome, and labelled as such by
            being unreadable rather than fake numbers pretending to mean something. */}
        <div className="biTrace" aria-hidden="true"><span /></div>
      </div>
    </div>
  )
}
