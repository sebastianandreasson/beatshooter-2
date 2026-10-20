import tgpu from "typegpu";
import * as d from "typegpu/data";
import * as std from "typegpu/std";

/** Two box coordinates approach a face boundary only along an edge or corner. */
export const boxEdgeCoordinate = tgpu.fn([d.vec3f], d.f32)((position) => {
    "use gpu";
    const p = std.abs(position);
    return std.max(std.min(p.x, p.y), std.max(std.min(p.y, p.z), std.min(p.z, p.x)));
});

/** Crisp luminous geometry with a quiet interior; derivative width avoids distant sparkle. */
export const neonEdgeEmission = tgpu.fn([d.f32, d.f32, d.vec3f], d.vec3f)((coordinate, footprint, color) => {
    "use gpu";
    const width = std.max(0.002, footprint);
    const edge = std.smoothstep(0.455 - width, 0.49 + width, coordinate);
    return std.mul(color, 0.025 + edge * 0.975);
});
