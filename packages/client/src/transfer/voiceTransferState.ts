export const VOICE_TRANSFER_SOURCES = ["timeline", "moments", "folder"] as const;

export type VoiceTransferSource = typeof VOICE_TRANSFER_SOURCES[number];
export type VoiceTransferState = "idle" | "recording" | "uploading";
export type VoiceTransferStates = Record<VoiceTransferSource, VoiceTransferState>;

export function createInitialVoiceTransferStates(): VoiceTransferStates {
  return {
    timeline: "idle",
    moments: "idle",
    folder: "idle",
  };
}

export function isVoiceTransferStateActive(state: VoiceTransferState): boolean {
  return state !== "idle";
}

export function setVoiceTransferState(
  states: VoiceTransferStates,
  source: VoiceTransferSource,
  state: VoiceTransferState,
): VoiceTransferStates {
  if (states[source] === state) return states;
  return {
    ...states,
    [source]: state,
  };
}

export function getActiveVoiceTransferState(states: VoiceTransferStates): VoiceTransferState {
  if (Object.values(states).includes("recording")) return "recording";
  if (Object.values(states).includes("uploading")) return "uploading";
  return "idle";
}
