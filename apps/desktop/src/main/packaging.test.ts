import { readFileSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PACKAGED_CLI_RUNTIME_PACKAGES } from '../../electron.vite.config'
import desktopPackage from '../../package.json'

interface ExtraResource {
  from: string
  to: string
  filter?: string[]
}

const require = createRequire(import.meta.url)
const tikzJaxPackagePath = require.resolve('node-tikzjax/package.json')
const tikzJaxRoot = dirname(tikzJaxPackagePath)

function expectNonEmptyTikzJaxFile(relativePath: string): void {
  const file = statSync(join(tikzJaxRoot, relativePath))
  expect(file.isFile(), `${relativePath} should be a file`).toBe(true)
  expect(file.size, `${relativePath} should not be empty`).toBeGreaterThan(0)
}

describe('desktop packaging', () => {
  it('ships the CLI chunks beside the unpacked CLI launcher', () => {
    const resources = desktopPackage.build.extraResources as ExtraResource[]

    expect(resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ from: 'out/main/cli.js', to: 'cli.js' }),
        expect.objectContaining({ from: 'out/main/chunks', to: 'chunks' })
      ])
    )
  })

  it('bundles CLI-only package dependencies instead of resolving them from Resources', () => {
    expect(PACKAGED_CLI_RUNTIME_PACKAGES).toContain('@modelcontextprotocol/sdk')
  })

  it('ships node-tikzjax as a production dependency with its TeX runtime', () => {
    expect(desktopPackage.dependencies).toHaveProperty('node-tikzjax')

    const tikzJaxPackage = JSON.parse(readFileSync(tikzJaxPackagePath, 'utf8')) as {
      files?: string[]
      license?: string
    }
    expect(tikzJaxPackage.files).toEqual(expect.arrayContaining(['css', 'dist', 'tex']))
    expect(tikzJaxPackage.license).toBe('LPPL-1.3c')

    for (const relativePath of [
      'LICENSE',
      'dist/index.js',
      'dist/bootstrap.js',
      'tex/core.dump.gz',
      'tex/tex.wasm.gz',
      'tex/tex_files.tar.gz'
    ]) {
      expectNonEmptyTikzJaxFile(relativePath)
    }
  })

  it('bundles every BaKoMa font referenced by the desktop TikZ stylesheet and its license', () => {
    const rendererEntry = readFileSync(new URL('../renderer/main.tsx', import.meta.url), 'utf8')
    expect(rendererEntry).toContain("import 'node-tikzjax/css/fonts.css'")

    const fontsCss = readFileSync(join(tikzJaxRoot, 'css/fonts.css'), 'utf8')
    const fontPaths = Array.from(fontsCss.matchAll(/url\(['\"]?([^)'\"]+)['\"]?\)/g), (match) => match[1])

    expect(fontPaths.length).toBeGreaterThan(100)
    expect(new Set(fontPaths).size).toBe(fontPaths.length)
    for (const fontPath of fontPaths) {
      expect(fontPath).toMatch(/^bakoma\/ttf\/[^/]+\.ttf$/)
      expectNonEmptyTikzJaxFile(join('css', fontPath))
    }

    expectNonEmptyTikzJaxFile('css/bakoma/LICENCE')
    const fontLicense = readFileSync(join(tikzJaxRoot, 'css/bakoma/LICENCE'), 'utf8')
    expect(fontLicense).toContain('BaKoMa Fonts Licence')
    expect(fontLicense).toContain('Permission to copy and distribute these fonts')
  })

  it('ships the Raycast extension source without vendored dependencies', () => {
    const resources = desktopPackage.build.extraResources as ExtraResource[]
    const raycastResource = resources.find((resource) => resource.to === 'raycast/zennotes')

    expect(raycastResource).toMatchObject({
      from: '../../integrations/raycast',
      to: 'raycast/zennotes'
    })
    expect(raycastResource?.filter).toEqual(
      expect.arrayContaining(['package.json', 'package-lock.json', 'src/**', '!node_modules/**'])
    )
  })
})
