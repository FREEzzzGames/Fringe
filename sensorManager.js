const EARTH_RADIUS_M = 6371000;

export function distanceMeters(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.latitude - a.latitude) * rad;
  const dLon = (b.longitude - a.longitude) * rad;
  const lat1 = a.latitude * rad;
  const lat2 = b.latitude * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class SensorManager {
  constructor(onUpdate = () => {}, onError = () => {}) {
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.position = null;
    this.heading = null;
    this.watchId = null;
    this.started = false;
    this.orientationHandler = this.handleOrientation.bind(this);
  }

  async requestPermission() {
    try {
      if (typeof DeviceOrientationEvent !== "undefined" &&
          typeof DeviceOrientationEvent.requestPermission === "function") {
        const result = await DeviceOrientationEvent.requestPermission();
        if (result !== "granted") throw new Error("Compass permission was denied.");
      }
      return true;
    } catch (error) {
      this.onError(error);
      return false;
    }
  }

  async start() {
    if (!("geolocation" in navigator)) {
      this.onError(new Error("Geolocation is not supported by this browser."));
      return false;
    }
    const allowed = await this.requestPermission();
    if (!allowed) return false;

    window.addEventListener("deviceorientationabsolute", this.orientationHandler, true);
    window.addEventListener("deviceorientation", this.orientationHandler, true);
    this.watchId = navigator.geolocation.watchPosition(
      (position) => {
        this.position = {
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          altitude: position.coords.altitude,
          accuracy: position.coords.accuracy,
          timestamp: position.timestamp
        };
        this.started = true;
        this.onUpdate(this.snapshot());
      },
      (error) => this.onError(new Error(error.message || "Location permission failed.")),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
    return true;
  }

  handleOrientation(event) {
    let heading = null;
    if (Number.isFinite(event.webkitCompassHeading)) {
      heading = event.webkitCompassHeading;
    } else if (Number.isFinite(event.alpha)) {
      heading = (360 - event.alpha + 360) % 360;
    }
    if (heading !== null) {
      this.heading = heading;
      this.onUpdate(this.snapshot());
    }
  }

  snapshot() {
    return { position: this.position, heading: this.heading };
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    window.removeEventListener("deviceorientationabsolute", this.orientationHandler, true);
    window.removeEventListener("deviceorientation", this.orientationHandler, true);
    this.started = false;
  }
}

export function getNearbyLayers(layers, position, radius = 5000) {
  if (!position) return [];
  return layers.map((layer) => {
    const loc = layer.location;
    if (!loc || !Number.isFinite(loc.latitude) || !Number.isFinite(loc.longitude)) return null;
    const distance = distanceMeters(position, loc);
    return { layer, distance };
  }).filter((item) => item && item.distance <= radius).sort((a, b) => a.distance - b.distance);
}
