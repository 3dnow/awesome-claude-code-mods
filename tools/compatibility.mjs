import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import ts from 'typescript'

const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs']
const controls = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/
const inside = (root, file) => {
  const path = relative(root, file)
  return path !== '..' && !path.startsWith('../') && !isAbsolute(path)
}

export function uiRewriteReview(repoRoot, pluginRoot, modules, hooks) {
  if (!hooks.some(h => h.event === 'ui.render' || h.event === '*')) return []
  const boundary = realpathSync(repoRoot)
  const plugin = realpathSync(pluginRoot)
  const seen = new Set(), evidence = []
  function sourceFile(path) {
    const candidates = [path]
    if (!extname(path)) candidates.push(...extensions.flatMap(ext => [path + ext, join(path, 'index' + ext)]))
    if (/\.[cm]?jsx?$/.test(path)) candidates.push(path.replace(/\.[cm]?jsx?$/, '.ts'), path.replace(/\.[cm]?jsx?$/, '.tsx'))
    for (const candidate of candidates) {
      if (!inside(boundary, resolve(candidate))) continue
      try {
        const real = realpathSync(candidate)
        if (inside(boundary, real) && statSync(real).isFile() && extensions.includes(extname(real)) && !real.endsWith('.d.ts')) return real
      } catch {}
    }
    return null
  }
  function visit(path) {
    const file = sourceFile(path)
    if (!file || seen.has(file)) return
    seen.add(file)
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
    const imports = []
    function walk(node) {
      if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
        if (controls.test(node.text)) evidence.push({ file: relative(boundary, file), line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 })
      }
      if ((ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly) || (ts.isExportDeclaration(node) && !node.isTypeOnly)) {
        if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        if (node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text)
      }
      ts.forEachChild(node, walk)
    }
    walk(source)
    for (const specifier of imports) if (specifier.startsWith('.')) visit(resolve(dirname(file), specifier))
  }
  for (const module of modules) if (typeof module === 'string') visit(resolve(plugin, 'hooks', module))
  const locations = [...new Map(evidence.map(e => [`${e.file}:${e.line}`, e])).values()]
    .sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return locations.length ? [{
    code: 'ui-control-characters',
    message: 'UI hook source contains control-character strings. Review any values passed to next() as rewritten props.text; the scanner does not trace whether these strings reach that call.',
    evidence: locations,
  }] : []
}

export function marketplacesFor(repoRoot, pluginRoot) {
  const boundary = realpathSync(repoRoot), plugin = realpathSync(pluginRoot)
  const paths = []
  for (let dir = plugin; inside(boundary, dir); dir = dirname(dir)) {
    const path = join(dir, '.claude-plugin/marketplace.json')
    if (existsSync(path) && inside(boundary, realpathSync(path))) {
      try {
        const manifest = JSON.parse(readFileSync(path, 'utf8'))
        if (manifest.plugins?.some(p => typeof p.source === 'string' && p.source.startsWith('./') && resolve(dir, p.source) === plugin)) paths.push(path)
      } catch {}
    }
    if (dir === boundary) break
  }
  return paths
}
