import tgpu from "typegpu";
import * as d from "typegpu/data";
import * as std from "typegpu/std";

export interface NeonFrame {
    enabled: boolean;
    bloom: number;
    threshold: number;
    knee: number;
    chromatic: number;
    vignette: number;
    reducedDetail: boolean;
}

export interface NeonInput {
    visible: boolean;
    intensity: "standard" | "calm" | "off";
    reducedMotion: boolean;
    reducedFlash: boolean;
    highQuality: boolean;
    beatPulse: number;
    downbeatPulse: number;
    musicalStrength: number;
    sectionActive: boolean;
    sectionProgress: number;
}

const unit = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Music-clock envelopes only; comfort modes keep a steady glow with no colour separation. */
export function sampleNeonFrame(input: NeonInput): NeonFrame {
    const enabled = input.visible && input.intensity !== "off";
    const calm = input.intensity === "calm";
    const steady = input.reducedMotion || input.reducedFlash;
    const pulse = steady ? 0 : Math.max(unit(input.beatPulse), unit(input.downbeatPulse)) * unit(input.musicalStrength);
    const section = steady || !input.sectionActive ? 0 : Math.sin(Math.PI * unit(input.sectionProgress)) ** 2;
    return {
        enabled,
        bloom: enabled ? (steady ? 0.3 : calm ? 0.32 + pulse * 0.02 + section * 0.03
            : 0.62 + pulse * 0.06 + section * 0.1) : 0,
        threshold: 0.8,
        knee: 0.3,
        chromatic: enabled ? section * (calm ? 0.18 : 0.75) : 0,
        vignette: enabled ? (calm || steady ? 0.08 : 0.12) : 0,
        reducedDetail: !input.highQuality,
    };
}

export interface NeonDimensions {
    width: number;
    height: number;
    bloomWidth: number;
    bloomHeight: number;
}

export function neonTargetDimensions(width: number, height: number, reducedDetail: boolean): NeonDimensions & {
    extractWidth: number; extractHeight: number;
} {
    const w = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1;
    const h = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 1;
    return {
        width: w, height: h,
        extractWidth: Math.max(1, Math.ceil(w / (reducedDetail ? 4 : 2))),
        extractHeight: Math.max(1, Math.ceil(h / (reducedDetail ? 4 : 2))),
        bloomWidth: Math.max(1, Math.ceil(w / (reducedDetail ? 8 : 4))),
        bloomHeight: Math.max(1, Math.ceil(h / (reducedDetail ? 8 : 4))),
    };
}

/** Soft-knee contribution preserves saturated hues and excludes the dark arena floor. */
export const bloomContribution = tgpu.fn([d.f32, d.f32, d.f32], d.f32)((brightness, threshold, knee) => {
    "use gpu";
    const safeKnee = std.max(knee, 0.0001);
    const soft = std.clamp(brightness - threshold + safeKnee, 0, 2 * safeKnee);
    const contribution = std.max(brightness - threshold, soft * soft / (4 * safeKnee));
    return std.max(0, contribution) / std.max(brightness, 0.0001);
});

/**
 * One module, five precompiled entry points. The original scene is sampled at
 * full resolution only in the final pass; bloom never blurs its geometry.
 */
export function neonShaderSource(): string {
    return tgpu.resolve({
        externals: { bloomContribution },
        template: `
struct NeonSettings {
    glow: vec4f,
    finish: vec4f,
};
@group(0) @binding(0) var scene: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var linearSampler: sampler;
@group(0) @binding(3) var<uniform> settings: NeonSettings;

struct ScreenVertex {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f,
};
@vertex fn neonVertex(@builtin(vertex_index) index: u32) -> ScreenVertex {
    let corner = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
    return ScreenVertex(vec4f(corner * 2.0 - 1.0, 0.0, 1.0), vec2f(corner.x, 1.0 - corner.y));
}
fn highlight(uv: vec2f) -> vec3f {
    let color = clamp(textureSampleLevel(scene, linearSampler, uv, 0.0).rgb, vec3f(0.0), vec3f(8.0));
    let brightness = max(color.r, max(color.g, color.b));
    return color * bloomContribution(brightness, settings.glow.y, settings.glow.z);
}
@fragment fn neonExtract(input: ScreenVertex) -> @location(0) vec4f {
    let texel = vec2f(1.0) / vec2f(textureDimensions(scene));
    let step = texel * mix(0.5, 1.0, settings.finish.w);
    let color = highlight(input.uv + vec2f(-step.x, -step.y))
        + highlight(input.uv + vec2f(step.x, -step.y))
        + highlight(input.uv + vec2f(-step.x, step.y))
        + highlight(input.uv + vec2f(step.x, step.y));
    return vec4f(color * 0.25, 1.0);
}
fn gaussian(uv: vec2f, step: vec2f) -> vec3f {
    var color = textureSampleLevel(scene, linearSampler, uv, 0.0).rgb * 0.227027;
    color += textureSampleLevel(scene, linearSampler, uv + step * 1.384615, 0.0).rgb * 0.316216;
    color += textureSampleLevel(scene, linearSampler, uv - step * 1.384615, 0.0).rgb * 0.316216;
    color += textureSampleLevel(scene, linearSampler, uv + step * 3.230769, 0.0).rgb * 0.0702705;
    color += textureSampleLevel(scene, linearSampler, uv - step * 3.230769, 0.0).rgb * 0.0702705;
    return color;
}
@fragment fn neonHorizontal(input: ScreenVertex) -> @location(0) vec4f {
    let texel = vec2f(1.0) / vec2f(textureDimensions(scene));
    return vec4f(gaussian(input.uv, vec2f(texel.x * 2.0, 0.0)), 1.0);
}
@fragment fn neonVertical(input: ScreenVertex) -> @location(0) vec4f {
    let texel = vec2f(1.0) / vec2f(textureDimensions(scene));
    return vec4f(gaussian(input.uv, vec2f(0.0, texel.y)), 1.0);
}
@fragment fn neonLowBlur(input: ScreenVertex) -> @location(0) vec4f {
    let step = vec2f(1.5) / vec2f(textureDimensions(scene));
    var color = textureSampleLevel(scene, linearSampler, input.uv, 0.0).rgb * 0.2;
    color += textureSampleLevel(scene, linearSampler, input.uv + vec2f(-step.x, -step.y), 0.0).rgb * 0.2;
    color += textureSampleLevel(scene, linearSampler, input.uv + vec2f(step.x, -step.y), 0.0).rgb * 0.2;
    color += textureSampleLevel(scene, linearSampler, input.uv + vec2f(-step.x, step.y), 0.0).rgb * 0.2;
    color += textureSampleLevel(scene, linearSampler, input.uv + vec2f(step.x, step.y), 0.0).rgb * 0.2;
    return vec4f(color, 1.0);
}
@fragment fn neonComposite(input: ScreenVertex) -> @location(0) vec4f {
    let original = textureLoad(scene, vec2i(input.position.xy), 0);
    var color = original.rgb;
    let centered = input.uv * 2.0 - 1.0;
    let edge = smoothstep(0.55, 1.0, max(abs(centered.x), abs(centered.y)));
    if (settings.glow.w > 0.0001 && edge > 0.0001) {
        let radial = centered / max(length(centered), 0.0001);
        let offset = radial * (settings.glow.w * edge) / settings.finish.yz;
        color.r = textureSampleLevel(scene, linearSampler, input.uv + offset, 0.0).r;
        color.b = textureSampleLevel(scene, linearSampler, input.uv - offset, 0.0).b;
    }
    let halo = textureSampleLevel(bloom, linearSampler, input.uv, 0.0).rgb;
    color += halo * settings.glow.x;
    let vignette = smoothstep(0.35, 1.35, length(centered));
    return vec4f(color * (1.0 - settings.finish.x * vignette), original.a);
}`,
    });
}
