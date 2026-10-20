import type { ActiveDash, DashStatus } from "../dash/state";

export interface ShipEngineFrame {
    status: DashStatus | "offline";
    material: "idle" | "ready" | "used" | "boost";
    plumeLength: number;
    plumeWidth: number;
    coreLength: number;
    coreWidth: number;
}

interface ShipEngineInput {
    status: DashStatus;
    position: number;
    available: boolean;
    motionAllowed: boolean;
    calm: boolean;
    active?: Pick<ActiveDash, "startedAt" | "endsAt">;
}

const unit = (value: number) => Math.max(0, Math.min(1, value));

/** Readiness uses the input clock; exhaust never advances on a separate timer. */
export function sampleShipEngine(input: ShipEngineInput): ShipEngineFrame {
    const status = input.available && Number.isFinite(input.position) ? input.status : "offline";
    const material = status === "ready" ? "ready" : status === "dashing" ? "boost"
        : status === "waiting" ? "idle" : "used";
    let length = 0, width = 0;
    if (input.motionAllowed) {
        if (status === "waiting") {
            length = 0.035;
            width = 0.045;
        } else if (status === "ready") {
            // A small steady tip marks the window without a repeated flare.
            length = 0.07;
            width = 0.055;
        } else if (status === "dashing" && input.active) {
            const duration = input.active.endsAt - input.active.startedAt;
            const progress = duration > 0 ? unit((input.position - input.active.startedAt) / duration) : 1;
            length = 0.09 + 0.09 * (1 - progress) ** 2;
            width = 0.065;
        }
    }
    const strength = input.calm ? 0.65 : 1;
    return {
        status, material,
        plumeLength: length * strength,
        plumeWidth: width * strength,
        coreLength: length * strength * 0.68,
        coreWidth: width * strength * 0.43,
    };
}
