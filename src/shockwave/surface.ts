import tgpu from "typegpu";
import * as d from "typegpu/data";
import * as std from "typegpu/std";

export const SHOCKWAVE_RADIUS = 30;
export const SHOCKWAVE_HALF_WIDTH = 3;
export const SHOCKWAVE_MAX_LIFT = 1.5;

const waveAmplitude = tgpu.fn([d.f32, d.f32], d.f32)((progress, strength) => {
    "use gpu";
    return 1.5 * std.clamp(strength, 0, 1)
        * std.smoothstep(0, 0.06, progress) * (1 - std.smoothstep(0.88, 1, progress));
});

/**
 * Shared CPU/GPU height for vertices and projected health/damage labels. This
 * compact bell has zero height and zero slope outside the single moving front.
 */
export const shockwaveHeight = tgpu.fn([d.f32, d.f32, d.f32, d.f32], d.f32)((progress, strength, x, z) => {
    "use gpu";
    const offset = (std.sqrt(x * x + z * z) - progress * 30) / 3;
    const bell = std.max(0, 1 - offset * offset);
    return waveAmplitude(progress, strength) * bell * bell;
});

export const ShockwaveSurface = d.struct({ position: d.vec3f, normal: d.vec3f, lift: d.f32 });

/** World-space Y deformation; physics positions, horizontal coordinates and the camera are unchanged. */
export const shockwaveSurface = tgpu.fn(
    [d.f32, d.f32, d.vec3f, d.vec3f], ShockwaveSurface,
)((progress, strength, worldPosition, worldNormal) => {
    "use gpu";
    const distance = std.sqrt(worldPosition.x * worldPosition.x + worldPosition.z * worldPosition.z);
    const offset = (distance - progress * 30) / 3;
    const bell = std.max(0, 1 - offset * offset);
    const amplitude = waveAmplitude(progress, strength);
    const lift = amplitude * bell * bell;
    const slope = -4 * amplitude * offset * bell / 3;
    const gx = slope * worldPosition.x / std.max(distance, 0.0001);
    const gz = slope * worldPosition.z / std.max(distance, 0.0001);
    // Inverse-transpose of the height field's Jacobian. Displacement does not
    // depend on normals, so color, depth prepass and shadow vertices agree.
    const normal = std.normalize(d.vec3f(
        worldNormal.x - gx * worldNormal.y,
        worldNormal.y,
        worldNormal.z - gz * worldNormal.y,
    ));
    return ShockwaveSurface({
        position: d.vec3f(worldPosition.x, worldPosition.y + lift, worldPosition.z),
        normal,
        lift,
    });
});
