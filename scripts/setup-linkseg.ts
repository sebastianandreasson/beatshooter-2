import { createHash } from "node:crypto";
import { copyFile, readFile, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { SECTION_MODEL } from "../src/analysis/models";

export async function setupLinkSeg(root: string, destination: string): Promise<void> {
    const path = resolve(destination, SECTION_MODEL.file);
    const valid = (bytes: Uint8Array) => bytes.length === SECTION_MODEL.bytes &&
        createHash("sha256").update(bytes).digest("hex") === SECTION_MODEL.sha256;
    const existing = await readFile(path).catch(() => undefined);
    if (!existing || !valid(existing)) {
        console.log("Downloading pinned LinkSeg section model (1.57 MB)...");
        const response = await fetch("https://huggingface.co/elicwhite/linkseg-7c-onnx/resolve/b15f9d9f5f68409cbd2cc0e78beb208df497c6f5/linkseg_7c.onnx");
        if (!response.ok) throw new Error(`LinkSeg download failed: HTTP ${response.status}`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!valid(bytes)) throw new Error("LinkSeg checksum or size does not match the pinned model.");
        try {
            await Bun.write(`${path}.partial`, bytes);
            await rename(`${path}.partial`, path);
        } finally {
            await rm(`${path}.partial`, { force: true });
        }
    }
    await copyFile(resolve(root, "src/analysis/vendor/linkseg/LICENSE"),
        resolve(destination, "LINKSEG-LICENSE.txt"));
    console.log("LinkSeg model SHA-256 verified.");
}
