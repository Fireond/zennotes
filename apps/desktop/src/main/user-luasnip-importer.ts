import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import luaparse, {
  type BinaryExpression,
  type CallExpression,
  type Chunk,
  type Expression,
  type FunctionDeclaration,
  type Identifier,
  type Statement,
  type TableConstructorExpression
} from 'luaparse'
import type {
  UserLuaSnipImportOptions,
  UserSnippet,
  UserSnippetContext,
  UserSnippetDiagnostic,
  UserSnippetNode
} from '@zennotes/bridge-contract/user-config'

type Located = { loc?: { start: { line: number } }; range?: [number, number] }
type Binding =
  | { kind: 'reference'; path: string }
  | { kind: 'function'; value: FunctionDeclaration }

export interface StaticLuaSnipImport {
  snippets: UserSnippet[]
  diagnostics: UserSnippetDiagnostic[]
  dependencies: string[]
  nextOrder: number
}

class UnsupportedLuaSnip extends Error {
  constructor(
    readonly code: string,
    readonly node: Located,
    message: string
  ) {
    super(message)
  }
}

const BUILTIN_REFERENCES: Record<string, string> = {
  s: 'luasnip.snippet',
  sn: 'luasnip.snippet_node',
  t: 'luasnip.text_node',
  i: 'luasnip.insert_node',
  f: 'luasnip.function_node',
  d: 'luasnip.dynamic_node',
  c: 'luasnip.choice_node',
  r: 'luasnip.restore_node',
  fmt: 'luasnip.extras.fmt.fmt',
  fmta: 'luasnip.extras.fmt.fmta',
  rep: 'luasnip.extras.rep',
  line_begin: 'luasnip.extras.expand_conditions.line_begin'
}

const CALL_KIND_BY_REFERENCE: Record<string, string> = {
  'luasnip.snippet': 's',
  'luasnip.snippet_node': 'sn',
  'luasnip.text_node': 't',
  'luasnip.insert_node': 'i',
  'luasnip.function_node': 'f',
  'luasnip.dynamic_node': 'd',
  'luasnip.choice_node': 'c',
  'luasnip.restore_node': 'r',
  'luasnip.extras.fmt.fmt': 'fmt',
  'luasnip.extras.fmt.fmta': 'fmta',
  'luasnip.extras.rep': 'rep'
}

function lineOf(node: Located): number {
  return node.loc?.start.line ?? 1
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2))
  }
  return value
}

function decodeLuaString(raw: string): string {
  const long = raw.match(/^\[(=*)\[/)
  if (long) {
    const marker = long[1]
    const openLength = marker.length + 2
    const closeLength = marker.length + 2
    let value = raw.slice(openLength, raw.length - closeLength)
    if (value.startsWith('\r\n')) value = value.slice(2)
    else if (value.startsWith('\n') || value.startsWith('\r')) value = value.slice(1)
    return value
  }

  const quote = raw[0]
  if ((quote !== '"' && quote !== "'") || raw.at(-1) !== quote) {
    throw new Error(`Unsupported Lua string literal ${raw}.`)
  }
  let value = ''
  for (let index = 1; index < raw.length - 1; index += 1) {
    const char = raw[index]
    if (char !== '\\') {
      value += char
      continue
    }
    index += 1
    const escaped = raw[index]
    if (escaped === undefined) break
    const simple: Record<string, string> = {
      a: '\x07',
      b: '\b',
      f: '\f',
      n: '\n',
      r: '\r',
      t: '\t',
      v: '\v',
      '\\': '\\',
      '"': '"',
      "'": "'"
    }
    if (simple[escaped] !== undefined) {
      value += simple[escaped]
      continue
    }
    if (escaped === '\n') {
      value += '\n'
      continue
    }
    if (escaped === '\r') {
      if (raw[index + 1] === '\n') index += 1
      value += '\n'
      continue
    }
    if (escaped === 'z') {
      while (/\s/u.test(raw[index + 1] ?? '')) index += 1
      continue
    }
    if (escaped === 'x' && /^[0-9a-fA-F]{2}$/u.test(raw.slice(index + 1, index + 3))) {
      value += String.fromCharCode(Number.parseInt(raw.slice(index + 1, index + 3), 16))
      index += 2
      continue
    }
    if (/\d/u.test(escaped)) {
      const digits = (escaped + raw.slice(index + 1, index + 3)).match(/^\d{1,3}/u)?.[0] ?? escaped
      value += String.fromCharCode(Number.parseInt(digits, 10))
      index += digits.length - 1
      continue
    }
    value += escaped
  }
  return value
}

function stringLiteral(expression: Expression, label: string): string {
  if (expression.type !== 'StringLiteral') {
    throw new UnsupportedLuaSnip(
      'unsupported-expression',
      expression,
      `${label} must be a literal string.`
    )
  }
  return decodeLuaString(expression.raw)
}

function numberLiteral(expression: Expression, label: string): number {
  if (expression.type !== 'NumericLiteral' || !Number.isSafeInteger(expression.value)) {
    throw new UnsupportedLuaSnip(
      'unsupported-expression',
      expression,
      `${label} must be an integer literal.`
    )
  }
  return expression.value
}

function booleanLiteral(expression: Expression, label: string): boolean {
  if (expression.type !== 'BooleanLiteral') {
    throw new UnsupportedLuaSnip(
      'unsupported-expression',
      expression,
      `${label} must be a boolean literal.`
    )
  }
  return expression.value
}

function tableValues(expression: Expression, label: string): Expression[] {
  if (expression.type !== 'TableConstructorExpression') {
    throw new UnsupportedLuaSnip(
      'unsupported-expression',
      expression,
      `${label} must be a literal table.`
    )
  }
  return expression.fields.map((field) => {
    if (field.type !== 'TableValue') {
      throw new UnsupportedLuaSnip(
        'unsupported-table-key',
        field,
        `${label} must use consecutive, unkeyed values.`
      )
    }
    return field.value
  })
}

function tableFields(expression: Expression, label: string): Map<string, Expression> {
  if (expression.type !== 'TableConstructorExpression') {
    throw new UnsupportedLuaSnip(
      'unsupported-expression',
      expression,
      `${label} must be a literal table.`
    )
  }
  const fields = new Map<string, Expression>()
  for (const field of expression.fields) {
    if (field.type === 'TableKeyString') fields.set(field.key.name, field.value)
    else if (field.type === 'TableKey' && field.key.type === 'StringLiteral') {
      fields.set(decodeLuaString(field.key.raw), field.value)
    }
  }
  return fields
}

function processMultiline(value: string): string {
  const lines = value.split('\n')
  if (/^\s*$/u.test(lines[0] ?? '')) lines.shift()
  if (lines.length && /^\s*$/u.test(lines.at(-1) ?? '')) lines.pop()
  let indent = Number.POSITIVE_INFINITY
  for (const line of lines) {
    const match = line.match(/^\s*\S/u)
    if (match) indent = Math.min(indent, match[0].length - 1)
  }
  if (Number.isFinite(indent)) {
    for (let index = 0; index < lines.length; index += 1) lines[index] = lines[index].slice(indent)
  }
  return lines.join('\n')
}

function appendNodes(target: UserSnippetNode[], nodes: UserSnippetNode[]): void {
  for (const node of nodes) {
    const previous = target.at(-1)
    if (previous?.type === 'text' && node.type === 'text') previous.text += node.text
    else target.push(node)
  }
}

class LuaFileImporter {
  private readonly environment = new Map<string, Binding>()
  readonly diagnostics: UserSnippetDiagnostic[] = []
  readonly snippets: UserSnippet[] = []

  constructor(
    private readonly filename: string,
    private readonly source: string,
    private order: number
  ) {
    for (const [name, reference] of Object.entries(BUILTIN_REFERENCES)) {
      this.environment.set(name, { kind: 'reference', path: reference })
    }
  }

  import(): number {
    let chunk: Chunk
    try {
      chunk = luaparse.parse(this.source, {
        luaVersion: '5.1',
        locations: true,
        ranges: true,
        comments: false,
        encodingMode: 'none'
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const line = Number(message.match(/\[(\d+):\d+\]/u)?.[1] ?? 1)
      this.diagnostic('error', 'lua-parse-error', { loc: { start: { line } } }, message)
      return this.order
    }

    let returned: Extract<Statement, { type: 'ReturnStatement' }> | null = null
    for (const statement of chunk.body) {
      if (statement.type === 'LocalStatement') {
        statement.variables.forEach((variable, index) => {
          const initial = statement.init[index]
          if (!initial) return
          const binding = this.binding(initial)
          if (binding) this.environment.set(variable.name, binding)
        })
      } else if (statement.type === 'FunctionDeclaration' && statement.isLocal) {
        if (statement.identifier?.type === 'Identifier') {
          this.environment.set(statement.identifier.name, {
            kind: 'function',
            value: statement
          })
        }
      } else if (statement.type === 'ReturnStatement') {
        returned = statement
        break
      } else {
        this.diagnostic(
          'warning',
          'unsupported-top-level',
          statement,
          `Ignored unsupported top-level ${statement.type}; Lua was not executed.`
        )
      }
    }

    if (!returned) {
      this.diagnostic(
        'error',
        'missing-return',
        chunk,
        'LuaSnip file does not return a snippet table.'
      )
      return this.order
    }

    returned.arguments.forEach((argument, returnIndex) => {
      let values: Expression[]
      try {
        values = tableValues(argument, `Return value ${returnIndex + 1}`)
      } catch (error) {
        this.recordUnsupported(error, argument)
        return
      }
      for (const expression of values) {
        const declarationOrder = this.order++
        try {
          if (this.callKind(expression) !== 's' || expression.type !== 'CallExpression') {
            throw new UnsupportedLuaSnip(
              'unsupported-return-value',
              expression,
              'Returned values must be direct LuaSnip snippet calls.'
            )
          }
          this.snippets.push(this.parseSnippet(expression, returnIndex === 1, declarationOrder))
        } catch (error) {
          this.recordUnsupported(error, expression)
        }
      }
    })
    return this.order
  }

  private parseSnippet(call: CallExpression, autosnippetList: boolean, order: number): UserSnippet {
    if (call.arguments.length < 2) {
      throw new UnsupportedLuaSnip('invalid-snippet', call, 'Snippet requires a trigger and body.')
    }
    const contextExpression = call.arguments[0]
    let trigger: string
    let pattern = false
    let wordTrig = true
    let auto = autosnippetList
    let priority = 1000

    if (contextExpression.type === 'StringLiteral') {
      trigger = decodeLuaString(contextExpression.raw)
    } else {
      const context = tableFields(contextExpression, 'Snippet context')
      const triggerExpression = context.get('trig')
      if (!triggerExpression) {
        throw new UnsupportedLuaSnip(
          'invalid-snippet',
          contextExpression,
          'Snippet context is missing trig.'
        )
      }
      trigger = stringLiteral(triggerExpression, 'trig')
      if (context.has('regTrig')) pattern = booleanLiteral(context.get('regTrig')!, 'regTrig')
      if (context.has('wordTrig')) wordTrig = booleanLiteral(context.get('wordTrig')!, 'wordTrig')
      if (context.has('priority')) priority = numberLiteral(context.get('priority')!, 'priority')
      if (context.has('snippetType')) {
        const snippetType = stringLiteral(context.get('snippetType')!, 'snippetType')
        if (snippetType !== 'snippet' && snippetType !== 'autosnippet') {
          throw new UnsupportedLuaSnip(
            'invalid-snippet-type',
            context.get('snippetType')!,
            `Unsupported snippetType ${snippetType}.`
          )
        }
        auto = snippetType === 'autosnippet'
      }
    }

    const body = this.parseNode(call.arguments[1])
    let snippetContext: UserSnippetContext = { type: 'always' }
    const optsExpression = call.arguments[2]
    if (optsExpression) {
      const options = tableFields(optsExpression, 'Snippet options')
      const condition = options.get('condition')
      if (condition) snippetContext = this.parseCondition(condition)
    }

    const source = { file: this.filename, line: lineOf(call) }
    return {
      id: `${this.filename}:${source.line}:${order}`,
      trigger: { kind: pattern ? 'lua-pattern' : 'literal', value: trigger },
      auto,
      wordTrig,
      priority,
      order,
      source,
      context: snippetContext,
      body
    }
  }

  private parseCondition(expression: Expression): UserSnippetContext {
    if (expression.type === 'BinaryExpression' && expression.operator === '*') {
      const all = [
        this.parseCondition(expression.left),
        this.parseCondition(expression.right)
      ].flatMap((condition) => (condition.type === 'and' ? condition.all : [condition]))
      return { type: 'and', all }
    }

    const reference = this.reference(expression)
    const conditions: Record<string, UserSnippetContext> = {
      'util.latex.in_mathzone': { type: 'math' },
      'util.latex.in_text': { type: 'text' },
      'util.latex.in_mathzone_md': { type: 'markdown-math' },
      'util.latex.in_text_md': { type: 'markdown-text' },
      'util.latex.in_tikzcd': { type: 'tikzcd' },
      'luasnip.extras.expand_conditions.line_begin': { type: 'line-begin' }
    }
    if (reference && conditions[reference]) return conditions[reference]

    if (expression.type === 'CallExpression') {
      const called = this.reference(expression.base)
      if (
        called === 'util.latex.in_env' &&
        expression.arguments.length === 1 &&
        expression.arguments[0].type === 'StringLiteral' &&
        decodeLuaString(expression.arguments[0].raw) === 'tikzcd'
      ) {
        this.diagnostic(
          'warning',
          'condition-evaluated-at-load',
          expression,
          'tex.in_env("tikzcd") is evaluated while loading Lua; normalized to the intended runtime tikzcd condition.'
        )
        return { type: 'tikzcd' }
      }
    }

    throw new UnsupportedLuaSnip(
      'unsupported-condition',
      expression,
      'Unsupported executable LuaSnip condition; Lua was not executed.'
    )
  }

  private parseNode(expression: Expression): UserSnippetNode[] {
    if (expression.type === 'TableConstructorExpression') {
      const nodes: UserSnippetNode[] = []
      for (const value of tableValues(expression, 'Snippet node list'))
        appendNodes(nodes, this.parseNode(value))
      return nodes
    }
    if (expression.type !== 'CallExpression') {
      throw new UnsupportedLuaSnip(
        'unsupported-node',
        expression,
        `Unsupported LuaSnip node expression ${expression.type}.`
      )
    }

    const kind = this.callKind(expression)
    switch (kind) {
      case 't':
        return [{ type: 'text', text: this.textNodeValue(expression.arguments[0]) }]
      case 'i': {
        const index = numberLiteral(expression.arguments[0], 'Insert-node index')
        const defaultExpression = expression.arguments[1]
        return [
          {
            type: 'insert',
            index,
            ...(defaultExpression ? { default: this.textNodeValue(defaultExpression) } : {})
          }
        ]
      }
      case 'sn':
        if (!expression.arguments[1]) {
          throw new UnsupportedLuaSnip(
            'invalid-snippet-node',
            expression,
            'snippetNode is missing its body.'
          )
        }
        return this.parseNode(expression.arguments[1])
      case 'c': {
        const index = numberLiteral(expression.arguments[0], 'Choice-node index')
        const choices = tableValues(expression.arguments[1], 'Choice list').map((choice) =>
          this.parseNode(choice)
        )
        return [{ type: 'choice', index, choices }]
      }
      case 'rep':
        return [
          {
            type: 'mirror',
            index: numberLiteral(expression.arguments[0], 'Mirror index')
          }
        ]
      case 'f':
        return [this.parseFunctionNode(expression)]
      case 'd':
        return [this.parseDynamicNode(expression)]
      case 'fmta':
        return this.parseFormatNode(expression, '<', '>')
      case 'fmt':
        return this.parseFormatNode(expression, '{', '}')
      case 'r':
        throw new UnsupportedLuaSnip(
          'unsupported-restore-node',
          expression,
          'restoreNode is not supported by the native snippet engine.'
        )
      default:
        throw new UnsupportedLuaSnip(
          'unsupported-node',
          expression,
          'Unknown or executable Lua expression in snippet body; Lua was not executed.'
        )
    }
  }

  private parseFunctionNode(call: CallExpression): UserSnippetNode {
    const fn = this.functionValue(call.arguments[0])
    if (!fn) {
      throw new UnsupportedLuaSnip(
        'unsupported-function-node',
        call,
        'functionNode requires a literal known function.'
      )
    }
    const captures = new Map<string, number>()
    for (const statement of fn.body) {
      if (statement.type !== 'LocalStatement') continue
      statement.variables.forEach((variable, index) => {
        const capture = this.captureIndex(statement.init[index], captures)
        if (capture !== null) captures.set(variable.name, capture)
      })
    }
    const returned = fn.body.find((statement) => statement.type === 'ReturnStatement')
    if (!returned || returned.type !== 'ReturnStatement' || returned.arguments.length !== 1) {
      throw new UnsupportedLuaSnip(
        'unsupported-function-node',
        fn,
        'Unsupported functionNode body.'
      )
    }
    const result = returned.arguments[0]
    const directCapture = this.captureIndex(result, captures)
    if (directCapture !== null) return { type: 'capture', index: directCapture, transform: 'copy' }

    if (result.type === 'CallExpression') {
      const called = this.reference(result.base)
      if (called === 'string.upper') {
        const capture = this.captureIndex(result.arguments[0], captures)
        if (capture !== null) return { type: 'capture', index: capture, transform: 'upper' }
      }
      if (called === 'string.rep' && result.arguments.length >= 2) {
        const repeated = stringLiteral(result.arguments[0], 'string.rep value')
        const capture = this.captureIndex(result.arguments[1], captures)
        if (repeated === '#' && capture !== null) {
          return {
            type: 'capture',
            index: capture,
            transform: 'repeat-hashes'
          }
        }
      }
      if (called === 'os.date' && result.arguments.length === 1) {
        return {
          type: 'date',
          format: stringLiteral(result.arguments[0], 'os.date format')
        }
      }
    }

    throw new UnsupportedLuaSnip(
      'unsupported-function-node',
      fn,
      'Unsupported functionNode code; only capture copy/upper/hash-repeat and os.date are imported.'
    )
  }

  private parseDynamicNode(call: CallExpression): UserSnippetNode {
    const index = numberLiteral(call.arguments[0], 'Dynamic-node index')
    const fn = this.functionValue(call.arguments[1])
    if (!fn) {
      throw new UnsupportedLuaSnip(
        'unsupported-dynamic-node',
        call,
        'dynamicNode requires a known literal function.'
      )
    }
    const ifStatement = fn.body.find((statement) => statement.type === 'IfStatement')
    if (!ifStatement || ifStatement.type !== 'IfStatement' || ifStatement.clauses.length < 2) {
      throw new UnsupportedLuaSnip(
        'unsupported-dynamic-node',
        fn,
        'Unsupported dynamicNode function body.'
      )
    }
    const selected = this.returnedWrapperMode(ifStatement.clauses[0].body)
    const empty = this.returnedWrapperMode(ifStatement.clauses.at(-1)?.body ?? [])
    if (!selected || !empty) {
      throw new UnsupportedLuaSnip(
        'unsupported-dynamic-node',
        fn,
        'Only SELECT_RAW get_visual dynamic nodes are supported.'
      )
    }
    return {
      type: 'selected',
      index,
      whenSelected: selected,
      whenEmpty: empty
    }
  }

  private returnedWrapperMode(statements: Statement[]): 'text' | 'insert' | null {
    const returned = statements.find((statement) => statement.type === 'ReturnStatement')
    if (!returned || returned.type !== 'ReturnStatement') return null
    const wrapper = returned.arguments[0]
    if (wrapper?.type !== 'CallExpression' || this.callKind(wrapper) !== 'sn') return null
    let child = wrapper.arguments[1]
    if (child?.type === 'TableConstructorExpression')
      child = tableValues(child, 'get_visual result')[0]
    if (child?.type !== 'CallExpression') return null
    const kind = this.callKind(child)
    return kind === 't' ? 'text' : kind === 'i' ? 'insert' : null
  }

  private parseFormatNode(call: CallExpression, left: string, right: string): UserSnippetNode[] {
    if (call.arguments.length < 2) {
      throw new UnsupportedLuaSnip(
        'invalid-format-node',
        call,
        'fmt/fmta requires a template and arguments.'
      )
    }
    const template = processMultiline(stringLiteral(call.arguments[0], 'Format template'))
    const rawArguments =
      call.arguments[1].type === 'TableConstructorExpression'
        ? tableValues(call.arguments[1], 'Format arguments')
        : [call.arguments[1]]
    const argumentsByIndex = new Map<number, UserSnippetNode[]>()
    rawArguments.forEach((argument, index) =>
      argumentsByIndex.set(index + 1, this.parseNode(argument))
    )

    const result: UserSnippetNode[] = []
    let text = ''
    let cursor = 0
    let lastIndex = 0
    const flush = (): void => {
      if (text) appendNodes(result, [{ type: 'text', text }])
      text = ''
    }
    while (cursor < template.length) {
      const char = template[cursor]
      if (char === left) {
        if (template[cursor + 1] === left) {
          text += left
          cursor += 2
          continue
        }
        const close = template.indexOf(right, cursor + 1)
        if (close < 0) {
          throw new UnsupportedLuaSnip(
            'invalid-format-node',
            call,
            'Format placeholder is missing a closing delimiter.'
          )
        }
        const placeholder = template.slice(cursor + 1, close)
        let argumentIndex: number
        if (!placeholder) argumentIndex = ++lastIndex
        else if (/^\d+$/u.test(placeholder)) {
          argumentIndex = Number(placeholder)
          lastIndex = argumentIndex
        } else {
          throw new UnsupportedLuaSnip(
            'unsupported-format-placeholder',
            call,
            `Named format placeholder ${placeholder} is not supported.`
          )
        }
        const nodes = argumentsByIndex.get(argumentIndex)
        if (!nodes) {
          throw new UnsupportedLuaSnip(
            'invalid-format-node',
            call,
            `Format placeholder ${argumentIndex} has no matching argument.`
          )
        }
        flush()
        appendNodes(result, structuredClone(nodes))
        cursor = close + 1
        continue
      }
      if (char === right) {
        if (template[cursor + 1] !== right) {
          throw new UnsupportedLuaSnip(
            'invalid-format-node',
            call,
            'Unescaped closing format delimiter.'
          )
        }
        text += right
        cursor += 2
        continue
      }
      text += char
      cursor += 1
    }
    flush()
    return result
  }

  private textNodeValue(expression: Expression | undefined): string {
    if (!expression) return ''
    if (expression.type === 'StringLiteral') return decodeLuaString(expression.raw)
    if (expression.type === 'TableConstructorExpression') {
      return tableValues(expression, 'textNode lines')
        .map((line) => stringLiteral(line, 'textNode line'))
        .join('\n')
    }
    throw new UnsupportedLuaSnip(
      'unsupported-text-node',
      expression,
      'textNode content must be literal text.'
    )
  }

  private captureIndex(
    expression: Expression | undefined,
    locals: Map<string, number>
  ): number | null {
    if (!expression) return null
    if (expression.type === 'Identifier') return locals.get(expression.name) ?? null
    if (
      expression.type === 'IndexExpression' &&
      expression.index.type === 'NumericLiteral' &&
      expression.base.type === 'MemberExpression' &&
      expression.base.identifier.name === 'captures'
    ) {
      return expression.index.value
    }
    if (expression.type === 'CallExpression' && this.reference(expression.base) === 'tonumber') {
      return this.captureIndex(expression.arguments[0], locals)
    }
    return null
  }

  private binding(expression: Expression): Binding | null {
    if (expression.type === 'FunctionDeclaration') return { kind: 'function', value: expression }
    if (expression.type === 'CallExpression' && this.reference(expression.base) === 'require') {
      if (expression.arguments.length === 1 && expression.arguments[0].type === 'StringLiteral') {
        return {
          kind: 'reference',
          path: decodeLuaString(expression.arguments[0].raw)
        }
      }
      return null
    }
    const reference = this.reference(expression)
    return reference ? { kind: 'reference', path: reference } : null
  }

  private functionValue(expression: Expression | undefined): FunctionDeclaration | null {
    if (!expression) return null
    if (expression.type === 'FunctionDeclaration') return expression
    if (expression.type === 'Identifier') {
      const binding = this.environment.get(expression.name)
      return binding?.kind === 'function' ? binding.value : null
    }
    return null
  }

  private reference(expression: Expression): string | null {
    if (expression.type === 'Identifier') {
      const binding = this.environment.get(expression.name)
      return binding?.kind === 'reference' ? binding.path : expression.name
    }
    if (expression.type === 'MemberExpression') {
      const base = this.reference(expression.base)
      return base ? `${base}.${expression.identifier.name}` : null
    }
    if (expression.type === 'IndexExpression' && expression.index.type === 'StringLiteral') {
      const base = this.reference(expression.base)
      return base ? `${base}.${decodeLuaString(expression.index.raw)}` : null
    }
    return null
  }

  private callKind(expression: Expression): string | null {
    if (expression.type !== 'CallExpression') return null
    const reference = this.reference(expression.base)
    return reference ? (CALL_KIND_BY_REFERENCE[reference] ?? null) : null
  }

  private recordUnsupported(error: unknown, fallback: Located): void {
    if (error instanceof UnsupportedLuaSnip) {
      this.diagnostic('error', error.code, error.node, error.message)
      return
    }
    const message = error instanceof Error ? error.message : String(error)
    this.diagnostic('error', 'import-error', fallback, message)
  }

  private diagnostic(
    severity: UserSnippetDiagnostic['severity'],
    code: string,
    node: Located,
    message: string
  ): void {
    this.diagnostics.push({
      severity,
      code,
      message,
      source: { file: this.filename, line: lineOf(node) }
    })
  }
}

async function isDirectory(filename: string): Promise<boolean> {
  try {
    return (await fs.stat(filename)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(filename: string): Promise<boolean> {
  try {
    return (await fs.stat(filename)).isFile()
  } catch {
    return false
  }
}

function groupName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.+-]+$/u.test(value)) {
    throw new Error(`${label} must be a non-empty LuaSnip filetype name.`)
  }
  return value
}

/** Parse a deliberately restricted LuaSnip subset. No Lua code or require() target is executed. */
export async function importLuaSnipStatic(
  options: UserLuaSnipImportOptions,
  configDirectory: string,
  startOrder = 0
): Promise<StaticLuaSnipImport> {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('LuaSnip import options must be an object.')
  }
  if (typeof options.root !== 'string' || !options.root.trim()) {
    throw new Error('LuaSnip import root must be a non-empty path.')
  }
  const expandedRoot = expandHome(options.root.trim())
  const root = path.resolve(configDirectory, expandedRoot)
  if (!(await isDirectory(root)))
    throw new Error(`LuaSnip root does not exist or is not a directory: ${root}`)

  const filetype = groupName(options.filetype, 'LuaSnip filetype')
  if (options.extend !== undefined && !Array.isArray(options.extend)) {
    throw new Error('LuaSnip extend must be an array of filetype names.')
  }
  const groups = [
    filetype,
    ...(options.extend ?? []).map((name, index) => groupName(name, `LuaSnip extend[${index}]`)),
    'all'
  ].filter((group, index, all) => all.indexOf(group) === index)

  const dependencies = new Set<string>()
  const files: string[] = []
  for (const group of groups) {
    const singleFile = path.join(root, `${group}.lua`)
    if (await isFile(singleFile)) {
      dependencies.add(singleFile)
      files.push(singleFile)
    }
    const directory = path.join(root, group)
    if (await isDirectory(directory)) {
      dependencies.add(directory)
      const entries = await fs.readdir(directory, { withFileTypes: true })
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (path.extname(entry.name) !== '.lua') continue
        const filename = path.join(directory, entry.name)
        if (!entry.isFile() && !(await isFile(filename))) continue
        dependencies.add(filename)
        files.push(filename)
      }
    }
  }

  const snippets: UserSnippet[] = []
  const diagnostics: UserSnippetDiagnostic[] = []
  let nextOrder = startOrder
  for (const filename of files) {
    const source = await fs.readFile(filename, 'utf8')
    const importer = new LuaFileImporter(filename, source, nextOrder)
    nextOrder = importer.import()
    snippets.push(...importer.snippets)
    diagnostics.push(...importer.diagnostics)
  }

  return {
    snippets,
    diagnostics,
    dependencies: [...dependencies].sort(),
    nextOrder
  }
}
