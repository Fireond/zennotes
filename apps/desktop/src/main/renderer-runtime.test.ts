import { describe, expect, it } from 'vitest'
import { resolveDevelopmentRendererUrl } from './renderer-runtime'

describe('resolveDevelopmentRendererUrl', () => {
  it('uses electron-vite renderer URLs in development', () => {
    expect(resolveDevelopmentRendererUrl(false, ' http://localhost:5173/ ')).toBe(
      'http://localhost:5173/'
    )
  })

  it('treats a blank development URL as unset', () => {
    expect(resolveDevelopmentRendererUrl(false, '   ')).toBeUndefined()
    expect(resolveDevelopmentRendererUrl(false, undefined)).toBeUndefined()
  })

  it('ignores inherited development URLs in packaged builds', () => {
    expect(resolveDevelopmentRendererUrl(true, 'http://localhost:5175/')).toBeUndefined()
  })
})
