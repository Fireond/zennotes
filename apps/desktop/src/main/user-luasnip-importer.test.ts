import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { importLuaSnipStatic } from './user-luasnip-importer'

const tempDirectories: string[] = []

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'zennotes-luasnip-'))
  tempDirectories.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true }))
  )
})

describe('static LuaSnip importer', () => {
  it('imports the supported AST subset, Unicode, inherited groups, and never executes Lua', async () => {
    const root = await tempRoot()
    const marker = path.join(root, 'executed')
    await fs.mkdir(path.join(root, 'markdown'))
    await fs.mkdir(path.join(root, 'tex_shared'))
    await fs.writeFile(
      path.join(root, 'all.lua'),
      `local ls = require("luasnip")
local s = ls.snippet
local f = ls.function_node
return { s("date", f(function() return os.date("%D - %H:%M") end)) }
`
    )
    await fs.writeFile(
      path.join(root, 'markdown', 'sample.lua'),
      `local ls = require("luasnip")
local s, sn, t, i, d = ls.snippet, ls.snippet_node, ls.text_node, ls.insert_node, ls.dynamic_node
local fmta = require("luasnip.extras.fmt").fmta
local line_begin = require("luasnip.extras.expand_conditions").line_begin
local tex = require("util.latex")
local get_visual = function(args, parent)
  if #parent.snippet.env.SELECT_RAW > 0 then return sn(nil, t(parent.snippet.env.SELECT_RAW))
  else return sn(nil, i(1)) end
end
os.execute(${JSON.stringify(`touch ${marker}`)})
return {
  s({ trig = "；b", snippetType = "autosnippet" }, fmta("**<>**", i(1)), { condition = tex.in_text_md }),
  s({ trig = "bal", snippetType = "autosnippet" }, fmta([[\n    \\begin{aligned}\n      <>\n    \\end{aligned}\n  ]], { d(1, get_visual) }), { condition = line_begin * tex.in_mathzone_md }),
  s({ trig = "#(%d)", regTrig = true, wordTrig = false, snippetType = "autosnippet" },
    fmta("<> ", { f(function(_, snip) local n = tonumber(snip.captures[1]); return string.rep("#", n) end) }),
    { condition = tex.in_text })
}
`
    )
    await fs.writeFile(
      path.join(root, 'tex_shared', 'capture.lua'),
      `local tex = require("util.latex")
return { s({ trig = "bb(%w)", regTrig = true, snippetType = "autosnippet" },
        f(function(_, snip) return string.upper(snip.captures[1]) end),
        { condition = tex.in_mathzone }),
  s({ trig = "cd", snippetType = "autosnippet" }, t("tikzcd"), { condition = tex.in_env("tikzcd") }) }
`
    )

    const imported = await importLuaSnipStatic(
      { root, filetype: 'markdown', extend: ['tex_shared'] },
      root
    )

    expect(await fs.stat(marker).catch(() => null)).toBeNull()
    expect(imported.snippets).toHaveLength(6)
    expect(imported.snippets.find((snippet) => snippet.trigger.value === '；b')?.body).toEqual([
      { type: 'text', text: '**' },
      { type: 'insert', index: 1 },
      { type: 'text', text: '**' }
    ])
    expect(imported.snippets.find((snippet) => snippet.trigger.value === 'bal')).toMatchObject({
      context: { type: 'and' },
      body: [
        { type: 'text', text: '\\begin{aligned}\n  ' },
        {
          type: 'selected',
          index: 1,
          whenSelected: 'text',
          whenEmpty: 'insert'
        },
        { type: 'text', text: '\n\\end{aligned}' }
      ]
    })
    expect(
      imported.snippets.find((snippet) => snippet.trigger.value === '#(%d)')?.body
    ).toContainEqual({
      type: 'capture',
      index: 1,
      transform: 'repeat-hashes'
    })
    expect(imported.snippets.find((snippet) => snippet.trigger.value === 'bb(%w)')?.body).toEqual([
      { type: 'capture', index: 1, transform: 'upper' }
    ])
    expect(imported.snippets.find((snippet) => snippet.trigger.value === 'date')?.body).toEqual([
      { type: 'date', format: '%D - %H:%M' }
    ])
    expect(imported.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'unsupported-top-level'
      })
    )
    expect(imported.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: 'warning',
        code: 'condition-evaluated-at-load'
      })
    )
  })

  const realRoot = process.env.ZENNOTES_LUASNIP_TEST_ROOT ?? ''
  const hasRealCorpus = !!realRoot && existsSync(realRoot)

  it.runIf(hasRealCorpus)('imports the effective local Markdown corpus', async () => {
    const imported = await importLuaSnipStatic(
      { root: realRoot, filetype: 'markdown', extend: ['tex_shared'] },
      realRoot
    )

    expect(imported.snippets).toHaveLength(415)
    expect(imported.snippets.filter((snippet) => snippet.auto)).toHaveLength(407)
    expect(imported.snippets.filter((snippet) => !snippet.auto)).toHaveLength(8)
    expect(imported.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])
  })
})
