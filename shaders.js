export const wallGridVertexShader = `
  varying vec2 vUv;
  varying vec3 vWorldPosition;
  void main() {
    vUv = uv;
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldPosition = worldPosition.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`;

export const wallGridFragmentShader = `
  uniform float uTime;
  uniform vec3 uColor;
  uniform float uOpacity;
  varying vec2 vUv;
  varying vec3 vWorldPosition;

  void main() {
    vec2 cell = abs(fract(vUv * 24.0 - 0.5) - 0.5) / fwidth(vUv * 24.0);
    float grid = 1.0 - min(min(cell.x, cell.y), 1.0);
    float pulse = 0.58 + 0.42 * sin(uTime * 1.8 + vUv.y * 16.0);
    float scan = smoothstep(0.02, 0.0, abs(fract(vUv.y * 3.0 - uTime * 0.12) - 0.5));
    float edge = smoothstep(0.0, 0.035, min(min(vUv.x, 1.0-vUv.x), min(vUv.y, 1.0-vUv.y)));
    float alpha = (grid * 0.6 + scan * 0.24) * pulse * edge * uOpacity;
    gl_FragColor = vec4(uColor * (0.65 + pulse * 0.65), alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

export function createWallGridMaterial(THREE) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uColor: { value: new THREE.Color("#00f3ff") },
      uOpacity: { value: 0.85 }
    },
    vertexShader: wallGridVertexShader,
    fragmentShader: wallGridFragmentShader,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending
  });
}
