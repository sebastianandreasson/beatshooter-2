/** Flat unit ring shared by pickup and weapon area indicators. */
export function ringGeometry() {
    const vertices: number[] = [], indices: number[] = [];
    for (let i = 0; i < 64; i++) {
        const angle = i / 64 * Math.PI * 2;
        for (const radius of [0.95, 1]) vertices.push(Math.sin(angle) * radius, 0, Math.cos(angle) * radius, 0, 0, 1, 0, 0);
        const a = i * 2, b = (i + 1) % 64 * 2;
        indices.push(a, a + 1, b + 1, a, b + 1, b);
    }
    return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}
