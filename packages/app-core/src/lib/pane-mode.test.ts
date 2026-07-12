// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PANE_MODE,
  requestPaneMode,
  ZEN_SET_PANE_MODE_EVENT,
  type PaneMode
} from './pane-mode'

describe('global editor mode requests', () => {
  it('starts in edit mode', () => {
    expect(DEFAULT_PANE_MODE).toBe('edit')
  })

  it('dispatches one mode request without a pane or note identity', () => {
    let requested: PaneMode | null = null
    const handler = (event: Event): void => {
      requested = (event as CustomEvent<{ mode: PaneMode }>).detail.mode
    }
    window.addEventListener(ZEN_SET_PANE_MODE_EVENT, handler)

    requestPaneMode('preview')

    expect(requested).toBe('preview')
    window.removeEventListener(ZEN_SET_PANE_MODE_EVENT, handler)
  })
})
