// @vitest-environment jsdom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from './SettingsModal'

const mocks = vi.hoisted(() => {
  const state = new Proxy(
    {
      autoCalendarPanel: true,
      calendarShowWeekNumbers: true,
      calendarWeekStart: 'monday',
      customTemplates: [],
      darkSidebar: false,
      editorFontSize: 16,
      editorLineHeight: 1.6,
      fzfBinaryPath: null,
      hideBuiltinTemplates: false,
      interfaceFont: null,
      keymapOverrides: {} as Record<string, string | null>,
      lineNumberMode: 'off',
      monoFont: null,
      previewMaxWidth: 760,
      quickNoteTitlePrefix: null,
      remoteWorkspaceInfo: null,
      remoteWorkspaceProfiles: [],
      ripgrepBinaryPath: null,
      resetKeymapBinding: vi.fn(),
      setKeymapBinding: vi.fn(),
      setSettingsOpen: vi.fn(),
      setVaultSettings: vi.fn(),
      showSidebarChevrons: true,
      systemFolderLabels: {},
      textFont: null,
      themeFamily: 'apple',
      themeId: 'apple-light',
      themeMode: 'light',
      vault: { root: '/tmp/zennotes-test-vault', name: 'Test Vault' },
      vaultSettings: {
        primaryNotesLocation: 'inbox',
        dailyNotes: { enabled: true, directory: 'Daily Not' },
        weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
        monthlyNotes: { enabled: false, directory: 'Monthly Notes' },
        folderIcons: {}
      },
      vaultTextSearchBackend: 'auto',
      vimInsertEscape: '',
      vimMode: false,
      whichKeyHintMode: 'timed',
      whichKeyHintTimeoutMs: 1200,
      whichKeyHints: true,
      workspaceMode: 'local'
    },
    {
      get(target, property: string) {
        if (property in target) return target[property as keyof typeof target]
        return vi.fn()
      }
    }
  )

  return {
    state,
    resetKeymapBinding: state.resetKeymapBinding,
    setKeymapBinding: state.setKeymapBinding,
    setSettingsOpen: state.setSettingsOpen,
    setVaultSettings: state.setVaultSettings
  }
})

vi.mock('../store', () => ({
  useStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state)
}))

vi.mock('../lib/system-fonts', () => ({
  hasSystemFontAccess: () => false,
  listSystemFonts: vi.fn().mockResolvedValue([])
}))

vi.mock('../lib/app-update-state', () => ({
  useAppUpdateState: () => ({ phase: 'idle', message: 'Manual check' })
}))

vi.mock('@zennotes/bridge-contract/bridge', () => ({
  getZenBridge: () => ({
    getAppInfo: () => ({
      runtime: 'desktop',
      version: '2.4.0',
      description: 'ZenNotes',
      homepage: 'https://github.com/ZenNotes/zennotes/releases/latest'
    }),
    getCapabilities: () => ({
      supportsCustomTemplates: true,
      supportsRemoteWorkspace: false
    })
  })
}))

function changeInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function blurInput(input: HTMLInputElement): void {
  input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
}

describe('SettingsModal date note directories', () => {
  let root: Root
  let host: HTMLDivElement

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.state.keymapOverrides = {}
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    Object.defineProperty(window, 'zen', {
      configurable: true,
      value: {
        getVaultTextSearchCapabilities: vi.fn().mockResolvedValue({ ripgrep: false, fzf: false }),
        checkForAppUpdates: vi.fn().mockResolvedValue({ phase: 'idle', message: 'Manual check' })
      }
    })
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      })
    })
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('does not restore the default daily directory while the field is being cleared', async () => {
    await act(async () => {
      root.render(createElement(SettingsModal))
    })

    const search = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.placeholder === 'Search settings…'
    )
    expect(search).toBeTruthy()

    await act(async () => {
      changeInput(search!, 'daily notes directory')
    })

    const dailyDirectory = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.value === 'Daily Not'
    )
    expect(dailyDirectory).toBeTruthy()

    await act(async () => {
      changeInput(dailyDirectory!, '')
    })

    expect(mocks.setVaultSettings).not.toHaveBeenCalled()
  })

  it('keeps the full-screen backdrop filter-free and renders a selected category', async () => {
    await act(async () => {
      root.render(createElement(SettingsModal))
    })

    const backdrop = host.querySelector<HTMLElement>('[data-settings-modal-backdrop]')
    expect(backdrop).toBeTruthy()
    expect(backdrop?.className).not.toContain('backdrop-blur')

    const keymapButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Keymap'
    )
    expect(keymapButton).toBeTruthy()

    await act(async () => {
      keymapButton!.click()
    })

    expect(host.textContent).toContain('Shortcut editor')
  })

  it('saves an explicit unbound keymap separately from restoring its default', async () => {
    await act(async () => {
      root.render(createElement(SettingsModal))
    })

    const keymapButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Keymap'
    )
    await act(async () => {
      keymapButton!.click()
    })

    const row = host.querySelector<HTMLElement>('[data-keymap-id="global.searchNotes"]')
    expect(row).toBeTruthy()
    const changeButton = [...row!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Change…'
    )
    await act(async () => {
      changeButton!.click()
    })

    const unbindButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Unbind'
    )
    await act(async () => {
      unbindButton!.click()
    })
    expect(document.body.textContent).toContain('Unbound')

    const saveButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Save unbound'
    )
    await act(async () => {
      saveButton!.click()
    })

    expect(mocks.setKeymapBinding).toHaveBeenCalledWith('global.searchNotes', null)
    expect(mocks.resetKeymapBinding).not.toHaveBeenCalled()
  })

  it('shows an unbound row as modified and can restore its default', async () => {
    mocks.state.keymapOverrides = { 'global.searchNotes': null }
    await act(async () => {
      root.render(createElement(SettingsModal))
    })

    const keymapButton = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Keymap'
    )
    await act(async () => {
      keymapButton!.click()
    })

    const row = host.querySelector<HTMLElement>('[data-keymap-id="global.searchNotes"]')
    expect(row?.textContent).toContain('Unbound')
    const restoreButton = [...row!.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.trim() === 'Restore default'
    )
    expect(restoreButton?.disabled).toBe(false)

    await act(async () => {
      restoreButton!.click()
    })
    expect(mocks.resetKeymapBinding).toHaveBeenCalledWith('global.searchNotes')
    expect(mocks.setKeymapBinding).not.toHaveBeenCalled()
  })

  it('saves the daily directory when the edit is committed', async () => {
    await act(async () => {
      root.render(createElement(SettingsModal))
    })

    const search = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.placeholder === 'Search settings…'
    )
    expect(search).toBeTruthy()

    await act(async () => {
      changeInput(search!, 'daily notes directory')
    })

    const dailyDirectory = [...host.querySelectorAll<HTMLInputElement>('input')].find(
      (input) => input.value === 'Daily Not'
    )
    expect(dailyDirectory).toBeTruthy()

    await act(async () => {
      changeInput(dailyDirectory!, 'inbox/Journal')
    })

    expect(mocks.setVaultSettings).not.toHaveBeenCalled()

    await act(async () => {
      blurInput(dailyDirectory!)
    })

    expect(mocks.setVaultSettings).toHaveBeenCalledWith({
      primaryNotesLocation: 'inbox',
      dailyNotes: { enabled: true, directory: 'inbox/Journal' },
      weeklyNotes: { enabled: false, directory: 'Weekly Notes' },
      monthlyNotes: { enabled: false, directory: 'Monthly Notes' },
      folderIcons: {}
    })
  })
})
