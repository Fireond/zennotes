export type PaneMode = 'edit' | 'preview' | 'split'

export const ZEN_SET_PANE_MODE_EVENT = 'zen:set-pane-mode'
export const DEFAULT_PANE_MODE: PaneMode = 'edit'

export function requestPaneMode(mode: PaneMode): void {
  window.dispatchEvent(
    new CustomEvent<{ mode: PaneMode }>(ZEN_SET_PANE_MODE_EVENT, {
      detail: { mode }
    })
  )
}
