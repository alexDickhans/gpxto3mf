import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { TerrainModel } from '../lib/mesh'
import { hexToRgb } from '../lib/palette'

type Props = {
  model: TerrainModel | null
  showNorth: boolean
  showScale: boolean
}

export function Preview({ model, showNorth, showScale }: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    controls: OrbitControls
    group: THREE.Group
    markers: THREE.Group
  } | null>(null)

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    } catch {
      mount.innerHTML =
        '<p style="padding:2rem;color:#1c2420;font-family:Figtree,sans-serif">WebGL unavailable — mesh export still works.</p>'
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(
      42,
      mount.clientWidth / mount.clientHeight,
      0.1,
      5000,
    )
    camera.position.set(120, -160, 110)
    camera.up.set(0, 0, 1)

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.target.set(0, 0, 20)

    const hemi = new THREE.HemisphereLight(0xf0f5ef, 0x5a4a38, 1.35)
    scene.add(hemi)
    const dir = new THREE.DirectionalLight(0xfff6e8, 1.7)
    dir.position.set(80, -40, 120)
    scene.add(dir)
    const fill = new THREE.DirectionalLight(0xb8d4e0, 0.55)
    fill.position.set(-60, 80, 40)
    scene.add(fill)
    const rim = new THREE.DirectionalLight(0xffffff, 0.4)
    rim.position.set(0, 100, 60)
    scene.add(rim)

    const group = new THREE.Group()
    scene.add(group)
    const markers = new THREE.Group()
    scene.add(markers)

    // Soft ground plane shadow feel
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(220, 64),
      new THREE.MeshBasicMaterial({
        color: 0x2a332c,
        transparent: true,
        opacity: 0.12,
      }),
    )
    ground.position.z = -0.5
    scene.add(ground)

    let frame = 0
    const animate = () => {
      frame = requestAnimationFrame(animate)
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      if (!mount) return
      const w = mount.clientWidth
      const h = mount.clientHeight
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h)
    }
    window.addEventListener('resize', onResize)

    stateRef.current = { renderer, scene, camera, controls, group, markers }

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', onResize)
      controls.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      stateRef.current = null
    }
  }, [])

  useEffect(() => {
    const st = stateRef.current
    if (!st) return

    while (st.group.children.length) {
      const c = st.group.children[0]
      st.group.remove(c)
      if (c instanceof THREE.Mesh) {
        c.geometry.dispose()
        if (Array.isArray(c.material)) c.material.forEach((m) => m.dispose())
        else c.material.dispose()
      }
    }
    while (st.markers.children.length) {
      const c = st.markers.children[0]
      st.markers.remove(c)
    }

    if (!model) {
      // Empty plaque placeholder
      const geo = new THREE.BoxGeometry(80, 60, 4)
      const mat = new THREE.MeshStandardMaterial({
        color: 0x6b7368,
        roughness: 0.85,
        metalness: 0.05,
      })
      const mesh = new THREE.Mesh(geo, mat)
      mesh.position.z = 2
      st.group.add(mesh)
      st.camera.position.set(90, -120, 80)
      st.controls.target.set(0, 0, 8)
      return
    }

    const mats = model.materials.map((m) => {
      const [r, g, b] = hexToRgb(m.hex)
      return new THREE.MeshStandardMaterial({
        color: new THREE.Color(r / 255, g / 255, b / 255),
        roughness: 0.72,
        metalness: 0.02,
        flatShading: true,
        emissive: new THREE.Color(r / 255, g / 255, b / 255),
        emissiveIntensity: 0.08,
      })
    })

    // Split by material for Three.js multi-material
    const groups: number[][] = model.materials.map(() => [])
    for (let t = 0; t < model.triMaterials.length; t++) {
      const mi = model.triMaterials[t]
      const i0 = t * 3
      groups[mi].push(
        model.indices[i0],
        model.indices[i0 + 1],
        model.indices[i0 + 2],
      )
    }

    groups.forEach((idx, mi) => {
      if (idx.length === 0) return
      const geo = new THREE.BufferGeometry()
      geo.setAttribute(
        'position',
        new THREE.BufferAttribute(model.positions, 3),
      )
      geo.setIndex(idx)
      geo.computeVertexNormals()
      const mesh = new THREE.Mesh(geo, mats[mi])
      st.group.add(mesh)
    })

    const cx = model.extentMm.x
    const cy = model.extentMm.y
    const cz = model.extentMm.z
    const dist = Math.max(cx, cy) * 1.35
    st.camera.position.set(dist * 0.55, -dist * 0.85, dist * 0.55)
    st.controls.target.set(0, 0, cz * 0.35)

    if (showNorth) {
      const northY = cy / 2 + 8
      const arrow = new THREE.ArrowHelper(
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, northY - 14, cz + 2),
        12,
        0xe23b2f,
        3.5,
        2.5,
      )
      st.markers.add(arrow)
      const canvas = document.createElement('canvas')
      canvas.width = 128
      canvas.height = 64
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#1c2420'
      ctx.font = 'bold 48px Barlow Condensed, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('N', 64, 48)
      const tex = new THREE.CanvasTexture(canvas)
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, transparent: true }),
      )
      sprite.scale.set(10, 5, 1)
      sprite.position.set(0, northY, cz + 6)
      st.markers.add(sprite)
    }

    if (showScale) {
      const barLen = Math.min(50, cx * 0.35)
      const barGeo = new THREE.BoxGeometry(barLen, 1.2, 0.8)
      const barMat = new THREE.MeshBasicMaterial({ color: 0x1c2420 })
      const bar = new THREE.Mesh(barGeo, barMat)
      bar.position.set(0, -cy / 2 - 6, 0.5)
      st.markers.add(bar)
      // ticks
      for (const side of [-1, 1]) {
        const tick = new THREE.Mesh(
          new THREE.BoxGeometry(1.2, 3, 0.8),
          barMat,
        )
        tick.position.set((barLen / 2) * side, -cy / 2 - 6, 0.5)
        st.markers.add(tick)
      }
    }
  }, [model, showNorth, showScale])

  return <div className="preview-mount" ref={mountRef} aria-label="3D preview" />
}
