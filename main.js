import * as THREE from 'three';
import { Fn, If, uniform, float, color, uv, vec2, vec3, hash, instancedArray, instanceIndex } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import Stats from 'three/addons/libs/stats.module.js';

const video = document.getElementById('webcam');
const overlay = document.getElementById('overlay');
const overlayCtx = overlay.getContext('2d');

async function initWebcam() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    video.srcObject = stream;
  } catch (err) {
    console.error('Webcam access error:', err);
  }
}

initWebcam();

function resizeOverlay() {
  overlay.width = window.innerWidth;
  overlay.height = window.innerHeight;
}

window.addEventListener('resize', resizeOverlay);
resizeOverlay();

const hands = new Hands({
  locateFile: file => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
  maxNumHands: 2,
  modelComplexity: 0,
  minDetectionConfidence: 0.2,
  minTrackingConfidence: 0.2,
});

const cameraFeed = new Camera(video, {
  onFrame: async () => {
    await hands.send({ image: video });
  },
  width: 1280,
  height: 720
});

cameraFeed.start();

const particleCount = 500000;
const gravity = uniform(-0.00198);
const bounce = uniform(0.8);
const friction = uniform(0.99);
const size = uniform(0.25);
const clickPosition = uniform(new THREE.Vector3());  // Right hand - repel
const magnetPosition = uniform(new THREE.Vector3()); // Left hand - attract
const magnetActive = uniform(0.0);  // Flag to track if magnet is active (0 = inactive, 1 = active)

let camera, scene, renderer;
let controls, stats;
let computeParticles;
let isOrbitControlsActive;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const geometry = new THREE.PlaneGeometry(1000, 1000);
const plane = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ visible: false }));

// Repel particles - Right hand
const computeHit = Fn(() => {
  const position = positions.element(instanceIndex);
  const velocity = velocities.element(instanceIndex);

  const dist = position.distance(clickPosition);
  const direction = position.sub(clickPosition).normalize();
  const distArea = float(10).sub(dist).max(0);

  const power = distArea.mul(0.015);
  const relativePower = power.mul(hash(instanceIndex).mul(1.5).add(0.5));

  velocity.assign(velocity.add(direction.mul(relativePower)));
})().compute(particleCount);

// Attract particles - Left hand
const computeMagnet = Fn(() => {
  const magnetActiveFloat = float(magnetActive);
  If(magnetActiveFloat.greaterThan(0.5), () => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);

    const dist = position.distance(magnetPosition);
    const direction = magnetPosition.sub(position).normalize();
    const distArea = float(15).sub(dist).max(0);  // Larger attraction radius

    const power = distArea.mul(0.003);  // Gentler attraction force
    const relativePower = power.mul(hash(instanceIndex).mul(1.3).add(0.5));

    velocity.assign(velocity.add(direction.mul(relativePower)));
  });
})().compute(particleCount);

const positions = instancedArray(particleCount, 'vec3');
const velocities = instancedArray(particleCount, 'vec3');
const colors = instancedArray(particleCount, 'vec3');

let repelOrb, attractOrb, repelOrbMaterial, attractOrbMaterial;

function init() {
  const { innerWidth, innerHeight } = window;

  camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 1000);
  camera.position.set(0, 4, 30);

  scene = new THREE.Scene();

  const separation = 0.2;
  const amount = Math.sqrt(particleCount);
  const offset = float(amount / 2);

  const computeInit = Fn(() => {
    const position = positions.element(instanceIndex);
    const color = colors.element(instanceIndex);

    const x = instanceIndex.mod(amount);
    const z = instanceIndex.div(amount);

    position.x = offset.sub(x).mul(separation);
    position.z = offset.sub(z).mul(separation);

    const randX = hash(instanceIndex);
    const randY = hash(instanceIndex.add(2));
    const randZ = hash(instanceIndex.add(3));

    color.assign(vec3(randX, randY.mul(0.5), randZ));
  })().compute(particleCount);

  const computeUpdate = Fn(() => {
    const position = positions.element(instanceIndex);
    const velocity = velocities.element(instanceIndex);

    velocity.addAssign(vec3(0.0, gravity, 0.0));
    position.addAssign(velocity);

    velocity.mulAssign(friction);

    If(position.y.lessThan(0), () => {
      position.y = 0;
      velocity.y = velocity.y.negate().mul(bounce);
      velocity.x = velocity.x.mul(0.9);
      velocity.z = velocity.z.mul(0.9);
    });
  });

  computeParticles = computeUpdate().compute(particleCount);

  const material = new THREE.SpriteNodeMaterial();
  material.colorNode = uv().mul(colors.element(instanceIndex));
  material.positionNode = positions.toAttribute();
  material.scaleNode = size;
  material.alphaTestNode = uv().mul(2).distance(vec2(1));
  material.transparent = true;

  const particles = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  particles.count = particleCount;
  particles.frustumCulled = false;
  scene.add(particles);

  const helper = new THREE.GridHelper(60, 40, 0x303030, 0x303030);
  scene.add(helper);

  geometry.rotateX(-Math.PI / 2);
  scene.add(plane);

  renderer = new THREE.WebGPURenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setAnimationLoop(animate);
  document.body.appendChild(renderer.domElement);

  stats = new Stats();
  document.body.appendChild(stats.dom);

  renderer.computeAsync(computeInit);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.minDistance = 5;
  controls.maxDistance = 200;
  controls.target.set(0, -8, 0);
  controls.update();

  controls.addEventListener('start', () => { isOrbitControlsActive = true; });
  controls.addEventListener('end', () => { isOrbitControlsActive = false; });

  window.addEventListener('resize', onWindowResize);

  // Blue repel orb setup (right hand)
  const orbGeometry = new THREE.SphereGeometry(0.5, 32, 32);
  repelOrbMaterial = new THREE.MeshBasicMaterial({ color: 0x00aaff, transparent: true, opacity: 0.8 });
  repelOrb = new THREE.Mesh(orbGeometry, repelOrbMaterial);
  repelOrb.visible = false;
  scene.add(repelOrb);

  // Green attract orb setup (left hand)
  attractOrbMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff66, transparent: true, opacity: 0.8 });
  attractOrb = new THREE.Mesh(orbGeometry.clone(), attractOrbMaterial);
  attractOrb.visible = false;
  scene.add(attractOrb);
}

function onWindowResize() {
  const { innerWidth, innerHeight } = window;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  resizeOverlay();
}

async function animate() {
  stats.update();
  await renderer.computeAsync(computeParticles);
  
  // Apply magnet effect if active
  if (magnetActive.value > 0.5) {
    await renderer.computeAsync(computeMagnet);
  }

  // Animate repel orb (right hand)
  if (repelOrb.visible) {
    const time = performance.now() * 0.005;
    const scale = 1 + Math.sin(time) * 0.3;
    repelOrb.scale.set(scale, scale, scale);
    repelOrbMaterial.opacity = 0.5 + 0.5 * Math.abs(Math.sin(time * 0.5));
  }

  // Animate attract orb (left hand)
  if (attractOrb.visible) {
    const time = performance.now() * 0.008; // Slightly different frequency
    const scale = 1 + Math.sin(time) * 0.4;
    attractOrb.scale.set(scale, scale, scale);
    attractOrbMaterial.opacity = 0.6 + 0.4 * Math.abs(Math.sin(time * 0.6));
  }

  await renderer.renderAsync(scene, camera);
}

init();

function processHandPosition(screenX, screenY, isRightHand, palmCenter) {
  // Use palm center coordinates instead of wrist
  const palmX = window.innerWidth * (0.5 - (palmCenter.x - 0.5) * 1.5);
  const palmY = window.innerHeight * (0.5 + (palmCenter.y - 0.5) * 1.5);
  
  const ndcX = (palmX / window.innerWidth) * 2 - 1;
  const ndcY = -(palmY / window.innerHeight) * 2 + 1;

  const tempVector = new THREE.Vector3(ndcX, ndcY, 0.5);
  tempVector.unproject(camera);
  const dir = tempVector.sub(camera.position).normalize();
  const distance = (0 - camera.position.y) / dir.y;
  const pos = camera.position.clone().add(dir.multiplyScalar(distance));

  if (isRightHand) {
    // Right hand - repel particles
    clickPosition.value.copy(pos);
    clickPosition.value.y = -1;
    repelOrb.position.copy(pos);
    repelOrb.visible = true;
    renderer.computeAsync(computeHit);
  } else {
    // Left hand - attract particles
    magnetPosition.value.copy(pos);
    magnetPosition.value.y = -1;
    magnetActive.value = 1.0;
    attractOrb.position.copy(pos);
    attractOrb.visible = true;
  }
}

hands.onResults(results => {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);

  const handsList = results.multiHandLandmarks;
  const handedness = results.multiHandedness;
  
  if (!handsList || handsList.length === 0) {
    repelOrb.visible = false;
    attractOrb.visible = false;
    magnetActive.value = 0.0;
    return;
  }

  // Process each hand and draw landmarks
  for (let i = 0; i < handsList.length; i++) {
    const landmarks = handsList[i];
    const handInfo = handedness[i];
    
    drawConnectors(overlayCtx, landmarks, HAND_CONNECTIONS, {
      color: handInfo.label === 'Right' ? '#00FF00' : '#FFFF00', // Green for right hand (camera mirror), yellow for left
      lineWidth: 2
    });
    
    drawLandmarks(overlayCtx, landmarks, {
      color: '#FF0000', 
      lineWidth: 1, 
      radius: 3
    });

    function isFingerExtended(tip, pip) {
      return tip.y < pip.y;
    }

    const thumbExtended = isFingerExtended(landmarks[4], landmarks[2]);
    const indexExtended = isFingerExtended(landmarks[8], landmarks[6]);
    const middleExtended = isFingerExtended(landmarks[12], landmarks[10]);
    const ringExtended = isFingerExtended(landmarks[16], landmarks[14]);
    const pinkyExtended = isFingerExtended(landmarks[20], landmarks[18]);

    const allFingersExtended = thumbExtended && indexExtended && middleExtended && ringExtended && pinkyExtended;

    if (allFingersExtended) {
      // Calculate palm center using hand landmarks
      // Palm center can be approximated as the average of certain landmarks
      // We'll use points 0 (wrist) and 9 (middle finger base) as reference
      const wrist = landmarks[0];
      const middleFingerBase = landmarks[9]; 
      
      // Calculate palm center (weighted more toward the middle finger base)
      const palmCenter = {
        x: wrist.x * 0.4 + middleFingerBase.x * 0.6,
        y: wrist.y * 0.4 + middleFingerBase.y * 0.6,
        z: wrist.z * 0.4 + middleFingerBase.z * 0.6
      };
      
      const sensitivity = 1.0;
      let offsetX = (wrist.x - 0.5) * sensitivity;
      let offsetY = (wrist.y - 0.5) * sensitivity;

      offsetX = Math.max(-0.5, Math.min(0.5, offsetX));
      offsetY = Math.max(-0.5, Math.min(0.5, offsetY));

      const screenX = window.innerWidth * (0.5 - offsetX);
      const screenY = window.innerHeight * (0.5 + offsetY);

      // Note: MediaPipe's "Left" hand is the right hand in the camera view due to mirroring
      const isRightHand = handInfo.label === 'Left'; 
      
      if (isOrbitControlsActive) continue;
      processHandPosition(screenX, screenY, isRightHand, palmCenter);
    } else {
      // If hand is no longer extended, hide the corresponding orb
      if (handInfo.label === 'Left') { // Right hand in camera view
        repelOrb.visible = false;
      } else { // Left hand in camera view
        attractOrb.visible = false;
        magnetActive.value = 0.0;
      }
    }
  }
});