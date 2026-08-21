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

export default function BuildingInterior({ building, state }) {
  const alerts = state?.alerts || []
  const count = state?.count ?? 0

  return (
    <div className={`biWrap tone-${building.tone}`}>
      {/* ── The building itself, zoomed, still from above ─────────────────── */}
      <div className="biZoom">
        <img src={`/base/${building.sprite}.png`} alt="" className="biSprite" />
        {/* A scan line crossing the roof: the only ornament here, and it says
            "this building is being looked at" rather than inventing data. */}
        <span className="biScan" />
      </div>

      {/* ── The console ───────────────────────────────────────────────────── */}
      <div className="biConsole">
        <div className="biConsoleTop">
          <span className="biName">{building.label}</span>
          <span className="biSub">interior · live</span>
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
