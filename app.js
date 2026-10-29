import * as THREE from "three";
import { createWallGridMaterial } from "./shaders.js";
import { SensorManager, getNearbyLayers } from "./sensorManager.js";

const $ = (id) => document.getElementById(id);
const sceneRoot = $("scene");
const cameraFeed = $("camera-feed");
const statusText = $("status-text");
const scanLabel = $("scan-label");
const toast = $("toast");
const createDrawer = $("create-drawer");
const libraryDrawer = $("library-drawer");
const openedCard = $("opened-card");
const layerList = $("layer-list");
const layerCount = $("layer-count");
const nearbyCount = $("nearby-count");
const nearestDistance = $("nearest-distance");
const locationState = $("location-state");
const fpsLabel = $("fps");
const xrButton = $("xr-btn");
const cameraButton = $("camera-btn");
const placeButton = $("place-btn");

const STORAGE_KEY = "ghost-layers:v1";
const MAX_AUDIO_SECONDS = 30;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_AUDIO_BYTES = 12 * 1024 * 1024;

let layers = loadLayers();
let mode = "search";
let xrSession = null;
let viewerSpace = null;
let hitTestSource = null;
let referenceSpace = null;
let hitPoseMatrix = null;
let currentAnchor = null;
let placedMeshes = new Map();
let selectedHitPose = null;
let cameraStream = null;
let localObjectUrls = new Map();
let lastFrameAt = 0;
let fpsFrames = 0;
let fpsWindowAt = performance.now();
let fps = 0;
let sensorSnapshot = { position: null, heading: null };
let renderer, camera, scene, gridMesh, reticle, gridMaterial;
let xrSupported = false;
let pendingPlacement = false;
let wallGridVisible = false;

const sensorManager = new SensorManager(
  (snapshot) => {
    sensorSnapshot = snapshot;
    updateProximity();
    if (snapshot.position) {
      locationState.textContent = "LOCATION: SHARED LOCALLY";
    }
  },
  (error) => showToast(error.message || "Sensor access failed.")
);

function loadLayers() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(saved) ? saved.filter(isValidLayer) : [];
  } catch {
    return [];
  }
}

function isValidLayer(layer) {
  return !!layer && typeof layer.layer_id === "string" &&
    layer.location && Number.isFinite(layer.location.latitude) &&
    Number.isFinite(layer.location.longitude) && layer.content &&
    typeof layer.content.type === "string";
}

function persistLayers() {
  try {
    // Media URLs are references, not embedded assets; browser object URLs cannot persist across sessions.
    const serializable = layers.map((layer) => {
      const copy = structuredClone(layer);
      if (copy.content?.media_url?.startsWith("blob:")) copy.content.media_url = "";
      if (copy.content?.audio_url?.startsWith("blob:")) copy.content.audio_url = "";
      return copy;
    });
    localStorage.setItem(STORAGE_KEY, JSON.stringify(serializable));
  } catch (error) {
    showToast("Local storage is full. Export your markers and remove large data.");
    console.error(error);
  }
}

function showToast(message, duration = 2800) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), duration);
}

function setMode(nextMode) {
  mode = nextMode;
  createDrawer.classList.toggle("open", mode === "create");
  libraryDrawer.classList.toggle("open", mode === "library");
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  });
  if (mode !== "create") openedCard.classList.remove("open");
  scanLabel.textContent = mode === "create"
    ? "AIM AT SURFACE // PLACE MARKER"
    : mode === "library" ? "LOCAL MARKER DATABASE" : "SCANNING FIELD // PROXIMITY";
  if (mode === "library") renderLayerList();
}

function initThree() {
  scene = new THREE.Scene();
  scene.background = null;
  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.01, 100);
  camera.position.set(0, 1.55, 3.5);
  camera.lookAt(0, 1.4, 0);

  renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.xr.enabled = true;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.setAttribute("aria-label", "Ghost Layers 3D view");
  sceneRoot.appendChild(renderer.domElement);

  scene.add(new THREE.HemisphereLight(0xc7fbff, 0x071017, 1.5));
  const keyLight = new THREE.DirectionalLight(0x6ffaff, 1.6);
  keyLight.position.set(1, 3, 2);
  scene.add(keyLight);

  gridMaterial = createWallGridMaterial(THREE);
  gridMesh = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2, 1, 1), gridMaterial);
  gridMesh.visible = false;
  gridMesh.renderOrder = 2;
  scene.add(gridMesh);

  const ring = new THREE.RingGeometry(0.055, 0.075, 32);
  const reticleMaterial = new THREE.MeshBasicMaterial({ color: 0x00f3ff, side: THREE.DoubleSide });
  reticle = new THREE.Mesh(ring, reticleMaterial);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  window.addEventListener("resize", onResize);
  renderer.setAnimationLoop(renderFrame);
  restoreStoredMarkers();
}

function onResize() {
  if (!camera || !renderer) return;
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}

function renderFrame(time, frame) {
  const delta = lastFrameAt ? Math.min((time - lastFrameAt) / 1000, 0.05) : 0;
  lastFrameAt = time;
  if (gridMaterial) gridMaterial.uniforms.uTime.value = time / 1000;
  if (frame && xrSession && hitTestSource && referenceSpace) {
    const hits = frame.getHitTestResults(hitTestSource);
    if (hits.length) {
      const pose = hits[0].getPose(referenceSpace);
      if (pose) {
        selectedHitPose = pose;
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        gridMesh.matrix.fromArray(pose.transform.matrix);
        gridMesh.matrix.decompose(gridMesh.position, gridMesh.quaternion, gridMesh.scale);
        gridMesh.scale.set(
          Number($("scale").value) * 1.6,
          Number($("scale").value) * 1.2,
          1
        );
        const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(gridMesh.quaternion);
        // A vertical hit normal generally points horizontally; avoid claiming full plane reconstruction.
        wallGridVisible = Math.abs(normal.y) < 0.45;
        gridMesh.visible = wallGridVisible;
        scanLabel.textContent = wallGridVisible ? "SURFACE CANDIDATE // READY" : "SURFACE HIT // ALIGNING";
      }
    } else {
      selectedHitPose = null;
      reticle.visible = false;
      gridMesh.visible = false;
      scanLabel.textContent = "SEARCHING FOR SURFACE";
    }
  }
  renderer.render(scene, camera);
  fpsFrames++;
  if (time - fpsWindowAt >= 1000) {
    fps = Math.round(fpsFrames * 1000 / (time - fpsWindowAt));
    fpsLabel.textContent = "FPS " + fps;
    fpsFrames = 0;
    fpsWindowAt = time;
  }
}

async function enterAR() {
  if (!navigator.xr) {
    showToast("WebXR is not available here. Use Mobile camera for the sensor fallback.");
    return;
  }
  try {
    const supported = await navigator.xr.isSessionSupported("immersive-ar");
    if (!supported) {
      showToast("This browser does not expose immersive-ar. Try a supported headset browser.");
      return;
    }
    xrSession = await navigator.xr.requestSession("immersive-ar", {
      requiredFeatures: ["hit-test"],
      optionalFeatures: ["dom-overlay", "anchors"],
      domOverlay: { root: $("hud") }
    });
    renderer.xr.setReferenceSpaceType("local");
    await renderer.xr.setSession(xrSession);
    referenceSpace = await xrSession.requestReferenceSpace("local");
    viewerSpace = await xrSession.requestReferenceSpace("viewer");
    hitTestSource = await xrSession.requestHitTestSource({ space: viewerSpace });
    statusText.textContent = "WEBXR ACTIVE";
    xrButton.textContent = "Exit AR";
    showToast("AR session started. Aim at a surface and tap Scan / place.");
    xrSession.addEventListener("end", onXREnd, { once: true });
    xrSession.addEventListener("visibilitychange", () => {
      if (xrSession?.visibilityState === "visible") showToast("AR view resumed.");
    });
    setMode("create");
  } catch (error) {
    console.error(error);
    showToast("Could not start AR: " + (error.message || "session rejected"));
    await cleanupXR();
  }
}

async function cleanupXR() {
  if (hitTestSource) {
    try { hitTestSource.cancel(); } catch {}
  }
  hitTestSource = null;
  viewerSpace = null;
  referenceSpace = null;
  selectedHitPose = null;
  xrSession = null;
  reticle.visible = false;
  gridMesh.visible = false;
  statusText.textContent = "LOCAL MODE";
  xrButton.textContent = "Enter AR";
}

function onXREnd() {
  cleanupXR();
  showToast("AR session ended.");
}

async function toggleAR() {
  if (xrSession) {
    try { await xrSession.end(); } catch { await cleanupXR(); }
  } else {
    await enterAR();
  }
}

async function toggleCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null;
    cameraFeed.srcObject = null;
    cameraFeed.style.display = "none";
    cameraButton.textContent = "Mobile camera";
    showToast("Camera overlay stopped.");
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Camera access is unavailable. Use HTTPS or localhost.");
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } }, audio: false
    });
    cameraFeed.srcObject = cameraStream;
    cameraFeed.style.display = "block";
    cameraButton.textContent = "Stop camera";
    statusText.textContent = "SENSOR FALLBACK";
    await sensorManager.start();
    showToast("Camera overlay active. GPS/compass is approximate, not wall tracking.");
  } catch (error) {
    showToast("Camera unavailable: " + (error.message || "permission denied"));
  }
}

function createTextTexture(title, caption) {
  const canvas = document.createElement("canvas");
  canvas.width = 768;
  canvas.height = 384;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "rgba(3,12,17,.92)";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.strokeStyle = "#00f3ff";
  ctx.lineWidth = 3;
  ctx.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);
  ctx.fillStyle = "#00f3ff";
  ctx.font = "bold 24px monospace";
  ctx.fillText("GHOST LAYER // LOCAL MARKER", 28, 42);
  ctx.fillStyle = "#f0fdff";
  ctx.font = "bold 42px sans-serif";
  wrapCanvasText(ctx, title || "Untitled", 28, 105, 700, 50, 2);
  ctx.fillStyle = "#b7d8de";
  ctx.font = "28px sans-serif";
  wrapCanvasText(ctx, caption || "Spatial message", 28, 205, 700, 38, 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  const words = String(text).split(/\s+/);
  let line = "";
  let lineCount = 0;
  for (const word of words) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, y + lineCount * lineHeight);
      line = word;
      lineCount++;
      if (lineCount >= maxLines - 1) break;
    } else line = test;
  }
  if (line && lineCount < maxLines) ctx.fillText(line, x, y + lineCount * lineHeight);
}

function makeLayerMesh(layer, poseMatrix = null) {
  const group = new THREE.Group();
  const title = layer.content?.title || "Ghost Layer";
  const caption = layer.content?.caption || "";
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(0.85, 0.42),
    new THREE.MeshBasicMaterial({ map: createTextTexture(title, caption), transparent: true, side: THREE.DoubleSide })
  );
  group.add(plane);
  const frame = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.PlaneGeometry(0.9, 0.47)),
    new THREE.LineBasicMaterial({ color: 0x00f3ff, transparent: true, opacity: 0.8 })
  );
  frame.position.z = 0.002;
  group.add(frame);
  if (poseMatrix) {
    const matrix = new THREE.Matrix4().fromArray(poseMatrix);
    matrix.decompose(group.position, group.quaternion, group.scale);
  } else {
    group.position.set((Math.random() - .5) * 1.8, 1.35 + Math.random() * .5, -1.7 - Math.random() * .6);
  }
  group.userData.layerId = layer.layer_id;
  group.userData.layer = layer;
  group.userData.createdAt = performance.now();
  scene.add(group);
  placedMeshes.set(layer.layer_id, group);
  return group;
}

async function placeCurrentLayer() {
  if (mode !== "create") setMode("create");
  const title = $("layer-title").value.trim() || "Без названия";
  const caption = $("layer-caption").value.slice(0, 1000);
  const contentType = $("content-type").value;
  const imageFile = $("image-file").files?.[0] || null;
  const audioFile = $("audio-file").files?.[0] || null;

  if (imageFile && imageFile.size > MAX_IMAGE_BYTES) {
    showToast("Image must be smaller than 8 MB.");
    return;
  }
  if (audioFile && audioFile.size > MAX_AUDIO_BYTES) {
    showToast("Audio must be smaller than 12 MB.");
    return;
  }
  if (audioFile) {
    try {
      const duration = await inspectAudioDuration(audioFile);
      if (duration > MAX_AUDIO_SECONDS) {
        showToast("Audio must be 30 seconds or shorter.");
        return;
      }
    } catch {
      showToast("Could not read audio duration. Choose another file.");
      return;
    }
  }

  const gps = sensorSnapshot.position;
  const location = {
    latitude: gps?.latitude ?? 52.520008,
    longitude: gps?.longitude ?? 13.404954,
    altitude: gps?.altitude ?? 1.5,
    orientation_vector: { pitch: 0, roll: 0, azimuth_yaw: sensorSnapshot.heading ?? 0 }
  };
  const mediaUrl = imageFile ? URL.createObjectURL(imageFile) : "";
  const audioUrl = audioFile ? URL.createObjectURL(audioFile) : "";
  if (mediaUrl) localObjectUrls.set("image:" + Date.now(), mediaUrl);
  if (audioUrl) localObjectUrls.set("audio:" + Date.now(), audioUrl);

  const layer = {
    layer_id: "gl_" + crypto.randomUUID().replaceAll("-", "").slice(0, 12),
    layer_type: "FREE",
    location,
    content: {
      type: contentType,
      media_url: mediaUrl,
      audio_url: audioUrl,
      title,
      author: "Local user",
      caption,
      timestamp: new Date().toISOString()
    },
    monetization: { is_for_rent: false, weekly_rate_usd: 0, owner_address: "" }
  };

  layers.unshift(layer);
  persistLayers();
  if (xrSession && selectedHitPose) {
    const poseMatrix = Array.from(selectedHitPose.transform.matrix);
    const mesh = makeLayerMesh(layer, poseMatrix);
    mesh.scale.multiplyScalar(Number($("scale").value));
    mesh.rotation.z += THREE.MathUtils.degToRad(Number($("yaw").value));
    const hitResult = selectedHitPose;
    // Anchor creation is optional and not available in all implementations.
    if (hitResult && typeof hitResult.createAnchor === "function") {
      try { currentAnchor = await hitResult.createAnchor(); } catch (error) { console.debug("Anchor fallback:", error); }
    }
    showToast(currentAnchor ? "Layer placed with a session anchor." : "Layer placed at the current hit pose.");
  } else {
    makeLayerMesh(layer);
    showToast(gps ? "Layer saved locally at your current GPS location." : "Layer saved locally with demo coordinates. Enable location for proximity.");
  }
  updateCounts();
  renderLayerList();
  setMode("library");
}

function inspectAudioDuration(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio();
    audio.preload = "metadata";
    audio.onloadedmetadata = () => {
      const duration = audio.duration;
      URL.revokeObjectURL(url);
      Number.isFinite(duration) ? resolve(duration) : reject(new Error("Unknown duration"));
    };
    audio.onerror = () => { URL.revokeObjectURL(url); reject(new Error("Invalid audio")); };
    audio.src = url;
  });
}

function restoreStoredMarkers() {
  // Stored marker metadata is restored to the library; world poses are session-local unless real anchors are available.
  updateCounts();
  renderLayerList();
}

function updateCounts() {
  layerCount.textContent = String(layers.length);
  updateProximity();
}

function updateProximity() {
  const nearby = getNearbyLayers(layers, sensorSnapshot.position, 5000);
  nearbyCount.textContent = String(nearby.length);
  nearestDistance.innerHTML = nearby.length
    ? Math.round(nearby[0].distance) + ' <small>m</small>'
    : '— <small>m</small>';
  if (sensorSnapshot.heading !== null) {
    scanLabel.textContent = nearby.length
      ? "NEAREST MARKER // " + Math.round(nearby[0].distance) + " M"
      : "SCANNING FIELD // NO MARKERS IN 5 KM";
  }
}

function renderLayerList() {
  layerList.replaceChildren();
  if (!layers.length) {
    const empty = document.createElement("p");
    empty.className = "small";
    empty.textContent = "No saved markers yet. Create a layer to get started.";
    layerList.appendChild(empty);
    return;
  }
  for (const layer of layers) {
    const item = document.createElement("article");
    item.className = "layer-item";
    const title = document.createElement("strong");
    title.textContent = layer.content?.title || "Untitled layer";
    const metadata = document.createElement("p");
    metadata.textContent = layer.layer_type + " · " + (layer.content?.type || "TEXT") + " · " + layer.layer_id;
    const caption = document.createElement("p");
    caption.textContent = layer.content?.caption || "No caption";
    const row = document.createElement("div");
    row.className = "row";
    const open = document.createElement("button");
    open.textContent = "Open";
    open.addEventListener("click", () => openLayer(layer));
    const remove = document.createElement("button");
    remove.textContent = "Delete";
    remove.addEventListener("click", () => {
      layers = layers.filter((candidate) => candidate.layer_id !== layer.layer_id);
      const mesh = placedMeshes.get(layer.layer_id);
      if (mesh) scene.remove(mesh);
      placedMeshes.delete(layer.layer_id);
      persistLayers();
      renderLayerList();
      updateCounts();
    });
    row.append(open, remove);
    item.append(title, metadata, caption, row);
    if (layer.monetization?.is_for_rent) {
      const premium = document.createElement("p");
      premium.className = "premium";
      premium.textContent = "PREMIUM SLOT · $" + (layer.monetization.weekly_rate_usd || 0) + "/week";
      item.appendChild(premium);
    }
    layerList.appendChild(item);
  }
}

function openLayer(layer) {
  openedCard.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = layer.content?.title || "Untitled layer";
  const author = document.createElement("p");
  author.className = "small";
  author.textContent = "BY " + (layer.content?.author || "Unknown") + " · " + (layer.content?.timestamp || "");
  const caption = document.createElement("p");
  caption.textContent = layer.content?.caption || "";
  openedCard.append(heading, author, caption);
  const imageUrl = localObjectUrls.get("image:" + layer.layer_id) || layer.content?.media_url;
  if (imageUrl) {
    const image = document.createElement("img");
    image.src = imageUrl;
    image.alt = layer.content?.title || "Layer image";
    image.onerror = () => image.remove();
    openedCard.appendChild(image);
  }
  const audioUrl = localObjectUrls.get("audio:" + layer.layer_id) || layer.content?.audio_url;
  if (audioUrl) {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = audioUrl;
    openedCard.appendChild(audio);
  }
  if (layer.monetization?.is_for_rent) {
    const card = document.createElement("div");
    card.className = "notice";
    card.innerHTML = '<span class="eyebrow">SPATIAL REAL ESTATE</span><br>LOCATION ID: ' + escapeHTML(layer.layer_id) +
      '<br>STATUS: Available<br>RENT: $' + Number(layer.monetization.weekly_rate_usd || 0) + '/Week';
    const inquire = document.createElement("button");
    inquire.className = "primary";
    inquire.textContent = "Inquire / Bid";
    inquire.addEventListener("click", () => showToast("Marketplace is a UI prototype. No bid or payment is submitted."));
    card.appendChild(inquire);
    openedCard.appendChild(card);
  }
  const close = document.createElement("button");
  close.textContent = "Close";
  close.addEventListener("click", () => openedCard.classList.remove("open"));
  openedCard.appendChild(close);
  openedCard.classList.add("open");
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function exportJSON() {
  const blob = new Blob([JSON.stringify(layers, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "ghost-layers.json";
  link.click();
  URL.revokeObjectURL(url);
  showToast("Marker metadata exported.");
}

async function importJSON(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (!Array.isArray(parsed) || !parsed.every(isValidLayer)) throw new Error("Expected an array of valid layer markers.");
    const byId = new Map(layers.map((layer) => [layer.layer_id, layer]));
    for (const layer of parsed) byId.set(layer.layer_id, layer);
    layers = [...byId.values()];
    persistLayers();
    updateCounts();
    renderLayerList();
    showToast("Imported " + parsed.length + " layer(s).");
  } catch (error) {
    showToast("Import failed: " + error.message);
  }
}

function bindUI() {
  document.querySelectorAll("[data-mode]").forEach((button) => button.addEventListener("click", () => setMode(button.dataset.mode)));
  $("menu-btn").addEventListener("click", () => setMode(mode === "library" ? "search" : "library"));
  xrButton.addEventListener("click", toggleAR);
  cameraButton.addEventListener("click", toggleCamera);
  placeButton.addEventListener("click", placeCurrentLayer);
  $("cancel-create").addEventListener("click", () => setMode("search"));
  $("export-btn").addEventListener("click", exportJSON);
  $("import-btn").addEventListener("click", () => $("import-file").click());
  $("import-file").addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) importJSON(file);
    event.target.value = "";
  });
  renderer.domElement.addEventListener("pointerdown", (event) => {
    if (!xrSession || !selectedHitPose || mode !== "create") return;
    pendingPlacement = true;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && cameraStream) {
      // Keep stream lifecycle explicit; mobile browsers may suspend camera when backgrounded.
      cameraStream.getTracks().forEach((track) => { if (track.readyState === "live") track.enabled = false; });
    } else if (cameraStream) cameraStream.getTracks().forEach((track) => { track.enabled = true; });
  });
}

async function boot() {
  initThree();
  bindUI();
  updateCounts();
  try {
    if (navigator.xr && await navigator.xr.isSessionSupported("immersive-ar")) {
      xrSupported = true;
      xrButton.textContent = "Enter AR";
      statusText.textContent = "AR READY";
    } else {
      xrButton.title = "This browser may not support immersive-ar.";
    }
  } catch { /* WebXR not exposed in this browser. */ }
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./sw.js").catch((error) => console.debug("Service worker unavailable:", error));
  }
  // The example schema is bundled separately; no remote APIs or remote assets are fetched.
}

boot().catch((error) => {
  console.error(error);
  showToast("Initialization failed: " + error.message, 6000);
});
