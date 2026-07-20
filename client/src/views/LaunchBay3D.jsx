import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js'
import { fetchLaunchBay } from '../api.js'
import { channelMeta } from '../../../src/model/channels.js'
import { NoteWidget, ChannelTag, CustomerName } from '../lib.jsx'

// Holotable (Nima, 2026-07-17) — the 3D hologram twin of the 2D Launch Bay,
// built from the OBJ models in the Drive "Holograms" folder (decimated to web
// weight as /holograms/*.glb). Same data, same states, same layout idea as the
// 2D view so the two can be compared side by side:
//   • cleared ships FLY above the deck (bobbing), grounded ones sit ON it;
//   • hologram tint tells you why: green=cleared, red=payment, amber=invoice,
//     blue=scanned-in (prep to ship), pulsing red=delayed launch;
//   • every ship carries a floating tag (IF · customer · status), rendered as
//     HTML so it stays crisp at any zoom.

const MODELS = ['ship-a', 'ship-b', 'ship-cr90']
const STATE_COLOR = {
  approved: 0x58ffa6,
  payment: 0xff5149,
  invoice: 0xffc857,
  scanned_in: 0x58a6ff,
  other: 0x9ab4cc,
}
const STATE_LABEL = {
  approved: 'Cleared for launch',
  payment: 'Waiting on payment',
  invoice: 'Pending invoice',
  scanned_in: 'Scanned in — prep to ship',
  other: 'Holding',
}

// same stable-hash trick the 2D bay uses, so a given IF always gets the same model
function hashPick(key, n) {
  const s = String(key)
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h % n
}

// hologram look: translucent additive fill + wireframe overlay
function holoMaterialize(root, color) {
  const fill = new THREE.MeshBasicMaterial({
    color, transparent: true, opacity: 0.16,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  })
  const wire = new THREE.MeshBasicMaterial({
    color, wireframe: true, transparent: true, opacity: 0.28,
    blending: THREE.AdditiveBlending, depthWrite: false,
  })
  const wires = []
  root.traverse((c) => {
    if (c.isMesh) {
      c.material = fill
      const w = new THREE.Mesh(c.geometry, wire)
      wires.push([c, w])
    }
  })
  for (const [c, w] of wires) c.add(w)
  return { fill, wire }
}

export default function LaunchBay3D() {
  const mountRef = useRef(null)
  const [ships, setShips] = useState(null)
  const [err, setErr] = useState(null)
  const [loadNote, setLoadNote] = useState('Projecting holotable…')
  const [selected, setSelected] = useState(null) // ship whose datapad panel is open

  useEffect(() => {
    fetchLaunchBay().then(setShips).catch((e) => setErr(e.message))
  }, [])

  useEffect(() => {
    if (!ships || !mountRef.current) return
    const mount = mountRef.current
    let disposed = false
    let raf = 0
    try {

    // ── stage ────────────────────────────────────────────────────────────────
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x05070d)
    scene.fog = new THREE.Fog(0x05070d, 26, 60)

    const camera = new THREE.PerspectiveCamera(46, mount.clientWidth / mount.clientHeight, 0.1, 200)
    camera.position.set(0, 8.5, 17)

    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    mount.appendChild(renderer.domElement)

    const labelRenderer = new CSS2DRenderer()
    labelRenderer.setSize(mount.clientWidth, mount.clientHeight)
    labelRenderer.domElement.className = 'holoLabels'
    mount.appendChild(labelRenderer.domElement)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.target.set(0, 1.6, 0)
    controls.maxPolarAngle = Math.PI * 0.49
    controls.minDistance = 5
    controls.maxDistance = 40
    controls.enableDamping = true

    // ── deck: holo grid + rings, Star Wars tactical-table style ─────────────
    const grid = new THREE.GridHelper(30, 30, 0x1f6feb, 0x14304d)
    grid.material.transparent = true
    grid.material.opacity = 0.5
    scene.add(grid)
    for (const r of [5, 9, 13]) {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(r - 0.03, r, 96),
        new THREE.MeshBasicMaterial({ color: 0x2b6cb0, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.012
      scene.add(ring)
    }

    const animated = [] // { obj, baseY, bob, mats, pulse }
    const loader = new GLTFLoader()
    const disposables = []

    // ── the bay model as the environment centerpiece ─────────────────────────
    loader.load('/holograms/bay.glb', (g) => {
      if (disposed) return
      const bay = g.scene
      bay.scale.setScalar(19)
      bay.position.set(0, 0.02, -9) // spaceport skyline BEHIND the cargo, not under it
      const mats = holoMaterialize(bay, 0xd9a441) // amber structure hologram, kept faint
      mats.fill.opacity = 0.04
      mats.wire.opacity = 0.09
      disposables.push(mats.fill, mats.wire)
      scene.add(bay)
    })

    // ── ships: same states as the 2D bay ────────────────────────────────────
    const flying = ships.filter((s) => s.floating)
    const grounded = ships.filter((s) => !s.floating)
    setLoadNote(ships.length ? '' : 'The bay is clear — nothing packed waiting to depart.')

    const gltfCache = new Map()
    const getModel = (name) =>
      gltfCache.get(name) ||
      gltfCache.set(name, new Promise((res, rej) => loader.load(`/holograms/${name}.glb`, (g) => res(g.scene), undefined, rej))).get(name)

    function placeRow(list, { y, zBase, perRow = 5, spread = 12 }) {
      list.forEach((s, i) => {
        const row = Math.floor(i / perRow)
        const inRow = Math.min(perRow, list.length - row * perRow)
        const col = i % perRow
        const x = inRow === 1 ? 0 : -spread / 2 + (col / (inRow - 1)) * spread
        const z = zBase + row * 3.2
        const key = s.ifNumber || s.soNumber
        const state = s.delayed ? 'delayed' : s.state
        const color = s.delayed ? 0xff5149 : (STATE_COLOR[s.state] ?? STATE_COLOR.other)

        getModel(MODELS[hashPick(key, MODELS.length)]).then((proto) => {
          if (disposed) return
          const ship = proto.clone(true)
          ship.scale.setScalar(3.1)
          ship.position.set(x, y, z)
          ship.rotation.y = Math.PI // face the camera-ish
          const mats = holoMaterialize(ship, color)
          disposables.push(mats.fill, mats.wire)

          // status glow disc on the deck under the ship
          const disc = new THREE.Mesh(
            new THREE.CircleGeometry(1.5, 48),
            new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.13, blending: THREE.AdditiveBlending, depthWrite: false }),
          )
          disc.rotation.x = -Math.PI / 2
          disc.position.set(x, 0.02, z)
          scene.add(disc)
          disposables.push(disc.material, disc.geometry)

          // floating HTML tag
          const el = document.createElement('div')
          el.className = 'holoTag' + (s.delayed ? ' delayed' : '')
          const ch = channelMeta(s)
          el.innerHTML =
            `<b>${key}</b><span style="color:${ch.color}">${s.customer || 'Unknown consignee'}</span>` +
            `<em style="color:#${color.toString(16).padStart(6, '0')}">${s.delayed ? `Overdue ${s.floatingDays}d — mark shipped` : STATE_LABEL[s.state] || 'Holding'}</em>` +
            `<u class="holoTagNote">✎ datapad</u>`
          // Click a tag to open its datapad panel (a React sibling of the mount,
          // never a child — see the note by the mount div). setSelected is
          // stable, so referencing it from this imperative handler is safe.
          el.style.cursor = 'pointer'
          el.onclick = () => setSelected(s)
          const tag = new CSS2DObject(el)
          tag.position.set(0, 1.15, 0)
          ship.add(tag)

          scene.add(ship)
          animated.push({
            obj: ship, baseY: y,
            bob: s.floating ? 0.9 + hashPick(key, 100) / 160 : 0,
            phase: hashPick(key, 628) / 100,
            mats, pulse: !!s.delayed,
          })
        }).catch(() => {})
      })
    }

    placeRow(flying, { y: 3.4, zBase: -1.5 })
    placeRow(grounded, { y: 0.55, zBase: 4.5 })

    // ── loop ────────────────────────────────────────────────────────────────
    const clock = new THREE.Clock()
    const tick = () => {
      if (disposed) return
      const t = clock.getElapsedTime()
      for (const a of animated) {
        if (a.bob) {
          a.obj.position.y = a.baseY + Math.sin(t * a.bob + a.phase) * 0.22
          a.obj.rotation.y += 0.0012 // flying ships drift; parked ones hold still
        }
        if (a.pulse) {
          const k = 0.5 + 0.5 * Math.sin(t * 5)
          a.mats.fill.opacity = 0.1 + 0.18 * k
          a.mats.wire.opacity = 0.2 + 0.3 * k
        }
      }
      controls.update()
      renderer.render(scene, camera)
      labelRenderer.render(scene, camera)
      raf = requestAnimationFrame(tick)
    }
    tick()

    const onResize = () => {
      const w = mount.clientWidth, h = mount.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
      labelRenderer.setSize(w, h)
    }
    const ro = new ResizeObserver(onResize)
    ro.observe(mount)

    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      ro.disconnect()
      controls.dispose()
      for (const d of disposables) d.dispose?.()
      renderer.dispose()
      renderer.domElement.remove()
      labelRenderer.domElement.remove()
    }
    } catch (e) {
      console.error('holotable init failed:', e)
      setErr(e.message)
    }
  }, [ships])

  if (err) return <div className="banner error">⚠ Couldn’t project the holotable: {err}</div>

  return (
    <div className="holotable">
      <div className="holotableBar">
        <span className="sectorTitle">◤ LAUNCH BAY — HOLOTABLE PROJECTION</span>
        <span className="hint">drag to orbit · scroll to zoom</span>
        <span className="holoLegend">
          <i style={{ color: '#58ffa6' }}>■ cleared</i>
          <i style={{ color: '#ff5149' }}>■ payment</i>
          <i style={{ color: '#ffc857' }}>■ invoice</i>
          <i style={{ color: '#58a6ff' }}>■ prep to ship</i>
        </span>
      </div>
      {/* React must NEVER manage children inside the WebGL mount: when its
          conditional child emptied, React's textContent='' fast path wiped the
          imperatively-appended canvas too. The mount stays childless from
          React's point of view; the note is a sibling overlay. */}
      <div className="holoStage">
        <div ref={mountRef} className="holoMount" />
        {loadNote && <div className="holoLoadNote">{loadNote}</div>}
        {selected && (
          <div className="holoDatapad">
            <div className="holoDatapadHead">
              <div>
                <div className="mono" style={{ fontWeight: 700 }}>{selected.ifNumber || selected.soNumber}</div>
                <div><ChannelTag order={selected} /> <CustomerName order={selected} /></div>
              </div>
              <button className="linkBtn" onClick={() => setSelected(null)}>✕</button>
            </div>
            <div className="holoDatapadMeta">
              {selected.soNumber && <span>SO {selected.soNumber}</span>}
              {selected.poNumber && <span>PO {selected.poNumber}</span>}
              {selected.delayed
                ? <span className="sev-hi">Overdue {selected.floatingDays}d</span>
                : <span>{STATE_LABEL[selected.state] || 'Holding'}</span>}
            </div>
            <p className="hint" style={{ margin: '2px 0 6px' }}>Why is it delayed? Note it here — and link the email/transmission that explains it.</p>
            <NoteWidget key={selected.ifNumber || selected.soNumber}
                        docType={selected.ifNumber ? 'IF' : 'SO'}
                        docNumber={selected.ifNumber || selected.soNumber} compact />
          </div>
        )}
      </div>
    </div>
  )
}
