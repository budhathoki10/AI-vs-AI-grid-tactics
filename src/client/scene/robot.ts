import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { PALETTE } from "./materials";

/**
 * An original, procedurally built bipedal combat robot (about 0.9 tiles tall).
 * Team colour drives the armour panels, the visor, the ground ring and the shield.
 */
export interface RobotRig {
  root: THREE.Group;
  body: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  kneeL: THREE.Group;
  kneeR: THREE.Group;
  torso: THREE.Group;
  gun: THREE.Group;
  head: THREE.Group;
  muzzle: THREE.Object3D;
  ring: THREE.Mesh;
  shield: THREE.Mesh;
  setColor(hex: string): void;
  setDisabled(amount: number): void;
  /** Brief white-hot flash on the armour when hit (0..1). */
  flash(amount: number): void;
  dispose(): void;
}

const shared = {
  gunmetal: new THREE.MeshStandardMaterial({ color: PALETTE.gunmetal, roughness: 0.48, metalness: 0.65 }),
  dark: new THREE.MeshStandardMaterial({ color: PALETTE.gunmetalDark, roughness: 0.55, metalness: 0.55 }),
  joint: new THREE.MeshStandardMaterial({ color: PALETTE.joint, roughness: 0.7, metalness: 0.4 }),
};

const geo = {
  torso: new RoundedBoxGeometry(0.4, 0.3, 0.3, 3, 0.05),
  chest: new RoundedBoxGeometry(0.3, 0.16, 0.06, 2, 0.02),
  shoulder: new RoundedBoxGeometry(0.16, 0.13, 0.24, 2, 0.035),
  head: new RoundedBoxGeometry(0.2, 0.12, 0.19, 2, 0.03),
  visor: new THREE.BoxGeometry(0.155, 0.032, 0.02),
  hips: new RoundedBoxGeometry(0.3, 0.1, 0.2, 2, 0.025),
  thigh: new RoundedBoxGeometry(0.12, 0.2, 0.14, 2, 0.025),
  shin: new RoundedBoxGeometry(0.11, 0.17, 0.13, 2, 0.025),
  shinPlate: new THREE.BoxGeometry(0.08, 0.1, 0.02),
  foot: new RoundedBoxGeometry(0.15, 0.06, 0.24, 2, 0.02),
  knee: new THREE.SphereGeometry(0.05, 12, 8),
  upperArm: new RoundedBoxGeometry(0.09, 0.2, 0.1, 2, 0.02),
  shieldPlate: new RoundedBoxGeometry(0.05, 0.24, 0.2, 2, 0.015),
  gunHousing: new RoundedBoxGeometry(0.12, 0.12, 0.24, 2, 0.025),
  barrel: new THREE.CylinderGeometry(0.03, 0.035, 0.26, 12),
  barrelTip: new THREE.CylinderGeometry(0.042, 0.042, 0.04, 12),
  backpack: new RoundedBoxGeometry(0.28, 0.22, 0.12, 2, 0.03),
  vent: new THREE.CylinderGeometry(0.03, 0.03, 0.05, 10),
  antenna: new THREE.CylinderGeometry(0.006, 0.008, 0.2, 6),
  antennaTip: new THREE.SphereGeometry(0.018, 8, 6),
  ring: new THREE.RingGeometry(0.29, 0.35, 48),
  shield: new THREE.IcosahedronGeometry(0.5, 2),
};

function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const m = new THREE.Mesh(geometry, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** Fresnel-style energy shell: bright at the rim, nearly clear in the middle. */
function shieldMaterial(color: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uOpacity: { value: 0 }, uTime: { value: 0 } },
    vertexShader: /* glsl */ `
      varying vec3 vNormal; varying vec3 vView; varying vec3 vPos;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vNormal = normalize(normalMatrix * normal);
        vView = normalize(-mv.xyz);
        vPos = position;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uOpacity; uniform float uTime;
      varying vec3 vNormal; varying vec3 vView; varying vec3 vPos;
      void main() {
        float rim = pow(1.0 - abs(dot(vNormal, vView)), 2.2);
        float bands = 0.5 + 0.5 * sin(vPos.y * 38.0 - uTime * 2.0);
        float a = (rim * 0.85 + bands * 0.06) * uOpacity;
        gl_FragColor = vec4(uColor * (0.6 + rim), a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
}

export function lighten(hex: string, amount: number): THREE.Color {
  return new THREE.Color(hex).lerp(new THREE.Color("#ffffff"), amount);
}

export function buildRobot(color: string): RobotRig {
  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.4, metalness: 0.22 });
  const paintDark = new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(0.55), roughness: 0.5, metalness: 0.3 });
  const visor = new THREE.MeshStandardMaterial({ color: "#0b0d10", emissive: lighten(color, 0.35), emissiveIntensity: 2.2, roughness: 0.3 });
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide });
  const shieldMat = shieldMaterial(lighten(color, 0.25));

  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  const ring = new THREE.Mesh(geo.ring, ringMat);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.012;
  ring.renderOrder = 2;
  root.add(ring);

  // Legs: hip pivot → thigh → knee pivot → shin → foot.
  const makeLeg = (side: -1 | 1) => {
    const leg = new THREE.Group();
    leg.position.set(0.1 * side, 0.36, 0);
    leg.add(mesh(geo.thigh, paint, 0, -0.09, 0));
    const knee = new THREE.Group();
    knee.position.set(0, -0.18, 0);
    knee.add(mesh(geo.knee, shared.joint));
    knee.add(mesh(geo.shin, shared.gunmetal, 0, -0.08, 0));
    knee.add(mesh(geo.shinPlate, paint, 0, -0.06, 0.072));
    knee.add(mesh(geo.foot, shared.dark, 0, -0.165, 0.03));
    leg.add(knee);
    body.add(leg);
    return { leg, knee };
  };
  const { leg: legL, knee: kneeL } = makeLeg(-1);
  const { leg: legR, knee: kneeR } = makeLeg(1);

  body.add(mesh(geo.hips, shared.dark, 0, 0.38, 0));

  const torso = new THREE.Group();
  torso.position.y = 0.41;
  body.add(torso);
  torso.add(mesh(geo.torso, paint, 0, 0.16, 0));
  torso.add(mesh(geo.chest, paintDark, 0, 0.19, 0.145));
  torso.add(mesh(geo.shoulder, paint, -0.27, 0.26, 0));
  torso.add(mesh(geo.shoulder, paint, 0.27, 0.26, 0));
  const pack = mesh(geo.backpack, shared.dark, 0, 0.17, -0.19);
  torso.add(pack);
  for (const x of [-0.07, 0.07]) {
    const vent = mesh(geo.vent, paintDark, x, 0.3, -0.2);
    torso.add(vent);
  }

  // Left arm carries a small shield plate.
  const armL = new THREE.Group();
  armL.position.set(-0.27, 0.2, 0);
  armL.add(mesh(geo.upperArm, shared.gunmetal, 0, -0.08, 0));
  armL.add(mesh(geo.shieldPlate, paint, -0.06, -0.12, 0.03));
  torso.add(armL);

  // Right arm is the cannon.
  const gun = new THREE.Group();
  gun.position.set(0.3, 0.18, 0.02);
  gun.add(mesh(geo.gunHousing, shared.dark, 0, 0, 0.04));
  const barrel = mesh(geo.barrel, shared.gunmetal, 0, 0, 0.27);
  barrel.rotation.x = Math.PI / 2;
  gun.add(barrel);
  const tip = mesh(geo.barrelTip, paint, 0, 0, 0.4);
  tip.rotation.x = Math.PI / 2;
  gun.add(tip);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(0, 0, 0.44);
  gun.add(muzzle);
  torso.add(gun);

  const head = new THREE.Group();
  head.position.set(0, 0.36, 0.01);
  head.add(mesh(geo.head, shared.gunmetal, 0, 0, 0));
  const visorMesh = new THREE.Mesh(geo.visor, visor);
  visorMesh.position.set(0, 0.005, 0.096);
  head.add(visorMesh);
  head.add(mesh(geo.antenna, shared.dark, -0.07, 0.15, -0.05));
  const antennaTip = new THREE.Mesh(geo.antennaTip, visor);
  antennaTip.position.set(-0.07, 0.25, -0.05);
  head.add(antennaTip);
  torso.add(head);

  const shield = new THREE.Mesh(geo.shield, shieldMat);
  shield.position.y = 0.48;
  shield.visible = false;
  shield.renderOrder = 5;
  root.add(shield);

  const baseVisor = visor.emissiveIntensity;

  return {
    root,
    body,
    legL,
    legR,
    kneeL,
    kneeR,
    torso,
    gun,
    head,
    muzzle,
    ring,
    shield,
    setColor(hex: string) {
      paint.color.set(hex);
      paintDark.color.set(hex).multiplyScalar(0.55);
      visor.emissive.copy(lighten(hex, 0.35));
      ringMat.color.set(hex);
      shieldMat.uniforms.uColor.value.copy(lighten(hex, 0.25));
    },
    setDisabled(amount: number) {
      visor.emissiveIntensity = baseVisor * (1 - amount * 0.92);
      ringMat.opacity = 0.9 - amount * 0.6;
      body.rotation.z = amount * 0.32;
      body.rotation.x = amount * 0.18;
      body.position.y = -amount * 0.08;
      torso.rotation.x = amount * 0.35;
    },
    flash(amount: number) {
      paint.emissive.setRGB(amount, amount * 0.85, amount * 0.7);
    },
    dispose() {
      paint.dispose();
      paintDark.dispose();
      visor.dispose();
      ringMat.dispose();
      shieldMat.dispose();
    },
  };
}
