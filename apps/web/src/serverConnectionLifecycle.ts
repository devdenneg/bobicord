export interface ServerConnectOwnership {
  requestedServerId: string;
  currentViewServerId: string | null;
  loadingServerId: string | null;
  engineAvailable: boolean;
  engineOwnsRequestedView: boolean;
}

/**
 * Coalesces only an exact same-server owner which is already loading or has a live/connecting
 * Engine room. A terminal Room disconnect clears Engine ownership synchronously, so the store's
 * still-present server id alone never suppresses the reconnect which replaces that room.
 */
export function shouldCoalesceServerConnect(state: ServerConnectOwnership): boolean {
  if (!state.engineAvailable || !state.requestedServerId) return false;
  if (state.loadingServerId === state.requestedServerId) return true;
  return state.currentViewServerId === state.requestedServerId && state.engineOwnsRequestedView;
}
