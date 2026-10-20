import { calculateEnergy } from "./energy";

self.onmessage = (event: MessageEvent<Float32Array>) => {
    try { self.postMessage({ energy: calculateEnergy(event.data) }); }
    catch { self.postMessage({ energy: undefined }); }
};
