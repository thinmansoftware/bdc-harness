import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';

const root = resolve(import.meta.dir, '../../..');
// No raw caller exemptions: the OAuth usage endpoint already sends Bearer.
const RAW_CALLERS: readonly string[] = [];
function scan(file: string, source: string): string[] {
  if (!/@anthropic-ai\/(sdk|claude-agent-sdk)|api\.anthropic\.com/.test(source)) return [];
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const errors: string[] = [];
  const report = (node: ts.Node, rule: string): void => {
    errors.push(
      `${file}:${ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1}: ${rule}`
    );
  };
  const constants = new Map<string, ts.Expression>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      constants.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, collect);
  };
  collect(ast);
  const expand = (node: ts.Node, depth = 0): string => {
    if (depth > 12) return '';
    if (ts.isIdentifier(node) && constants.has(node.text))
      return expand(constants.get(node.text)!, depth + 1);
    const children: string[] = [];
    ts.forEachChild(node, child => {
      children.push(expand(child, depth + 1));
    });
    return node.getText(ast) + ' ' + children.join(' ');
  };
  const property = (node: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
    const entry = node.properties.find(p => p.name?.getText(ast).replace(/['"]/g, '') === name);
    if (entry && ts.isShorthandPropertyAssignment(entry)) return entry.name;
    return entry && ts.isPropertyAssignment(entry) ? entry.initializer : undefined;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node)) {
      const name = node.name.getText(ast).replace(/['"]/g, '');
      if (['temperature', 'top_p', 'top_k'].includes(name)) report(node, 'sampling parameter');
    }
    if (ts.isObjectLiteralExpression(node)) {
      const role = property(node, 'role')?.getText(ast);
      const content = property(node, 'content');
      const text = content ? expand(content) : '';
      if (role === "'assistant'" || role === '"assistant"') {
        if (/type\s*:\s*['"]document['"]/.test(text)) report(node, 'assistant document');
      }
      if (role === "'user'" || role === '"user"') {
        if (/citations\s*:/.test(text)) report(node, 'user citations');
      }
    }
    if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      /api\.anthropic\.com/.test(expand(node.arguments[0])) &&
      !RAW_CALLERS.includes(file)
    ) {
      const headers = node.arguments[1] ? expand(node.arguments[1]) : '';
      if (!/['"]?Authorization['"]?\s*:\s*[`'"]Bearer /i.test(headers))
        report(node, 'missing Authorization Bearer');
    }

    if (
      ts.isCallExpression(node) &&
      /(?:^|\.)completions\.create$/.test(node.expression.getText(ast))
    )
      report(node, 'Text Completions');
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return errors;
}
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    return entry.isDirectory()
      ? sources(path)
      : /\.ts$/.test(path) && !/\.(test|spec)\.ts$/.test(path)
        ? [path]
        : [];
  });
}
test('anthropic_packages_current', () => {
  const read = (path: string): any => JSON.parse(readFileSync(join(root, path), 'utf8'));
  const installed = read('node_modules/@anthropic-ai/claude-agent-sdk/package.json');
  expect(read('package.json').dependencies['@anthropic-ai/claude-agent-sdk']).toBe(
    read('packages/providers/package.json').dependencies['@anthropic-ai/claude-agent-sdk']
  );
  const lock = readFileSync(join(root, 'bun.lock'), 'utf8');
  expect(lock).toContain('@anthropic-ai/sdk@1.');
  // XO decision (a), WO #4895: pi-ai's isolated 0.x copy is allowed.
  const entries = lock.split('\n').filter(line => /"@anthropic-ai\/sdk": \[/.test(line));
  expect(entries.length).toBe(1);
  expect(entries[0]).toContain('@anthropic-ai/sdk@1.7.0');
  // Amended Stop 17: only SDK copies directly beneath pi-ai are exempt.
  const oldSdkEntries = lock.split('\n').filter(line => /\["@anthropic-ai\/sdk@0\./.test(line));
  expect(oldSdkEntries.length).toBeGreaterThan(0);
  for (const entry of oldSdkEntries) {
    const key = /^\s*"([^"]+)":/.exec(entry)?.[1];
    expect(key?.endsWith('@mariozechner/pi-ai/@anthropic-ai/sdk')).toBe(true);
  }
  expect(read('packages/providers/package.json').dependencies['@anthropic-ai/sdk']).toBe('^1.7.0');
  // Resolve from every first-party TypeScript importer, including tests.
  for (const pkg of readdirSync(join(root, 'packages'))) {
    const dir = join(root, 'packages', pkg, 'src');
    const walk = (path: string): string[] =>
      readdirSync(path, { withFileTypes: true }).flatMap(entry => {
        const next = join(path, entry.name);
        return entry.isDirectory() ? walk(next) : /\.tsx?$/.test(next) ? [next] : [];
      });
    if (!existsSync(dir)) continue;
    for (const file of walk(dir)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('@anthropic-ai/sdk')) continue;
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isStringLiteral(node) &&
          node.text === '@anthropic-ai/sdk' &&
          (ts.isImportDeclaration(node.parent) ||
            ts.isExportDeclaration(node.parent) ||
            (ts.isCallExpression(node.parent) &&
              (node.parent.expression.kind === ts.SyntaxKind.ImportKeyword ||
                node.parent.expression.getText(ast) === 'require')))
        ) {
          const resolved = Bun.resolveSync('@anthropic-ai/sdk/package.json', file);
          expect(JSON.parse(readFileSync(resolved, 'utf8')).version.startsWith('1.')).toBe(true);
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }
  }
  const [major, minor, patch] = installed.claudeCodeVersion.split('.').map(Number);
  expect(major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 290)))).toBe(true);
});
test('claude_calls_follow_2026_10_21_api', () => {
  const files = readdirSync(join(root, 'packages')).flatMap(pkg => {
    try {
      return sources(join(root, 'packages', pkg, 'src'));
    } catch {
      return [];
    }
  });
  expect(files.flatMap(file => scan(file, readFileSync(file, 'utf8')))).toEqual([]);
  const judge = readFileSync(
    join(root, 'packages/server/src/dispatch/duty-officer-judge.ts'),
    'utf8'
  );
  // Freeze the call graph: definition plus the two non-Claude rung calls only.
  expect(judge.match(/chatCompletions\(/g)?.length).toBe(3);
  for (const name of ['openRouterRung', 'xaiRung']) {
    expect(judge.slice(judge.indexOf(`function ${name}(`)).split('\nfunction ')[0]).toContain(
      'chatCompletions('
    );
  }
  expect(
    judge.slice(judge.indexOf('async function defaultClaudeComplete(')).split('\nfunction ')[0]
  ).toContain('provider.sendQuery(');
});
test('migration_scanner_catches_violations', () => {
  for (const source of [
    `import Anthropic from '@anthropic-ai/sdk'; client.messages.create({temperature: 0});`,
    `import Anthropic from '@anthropic-ai/sdk'; const x = {role: 'assistant', content: [{type: 'document'}]};`,
    `import Anthropic from '@anthropic-ai/sdk'; const x = {role: 'user', content: [{type: 'text', citations: [{}]}]};`,
    `import Anthropic from '@anthropic-ai/sdk'; client.completions.create({});`,
    `fetch('https://api.anthropic.com/v1/messages', {headers: {'x-api-key': 'synthetic'}});`,
    `const other = {Authorization: 'Bearer internal'}; fetch('https://api.anthropic.com/v1/messages', {headers: {'x-api-key': 'synthetic'}});`,
    `import Anthropic from '@anthropic-ai/sdk'; const content = [{type: 'document'}]; const msg = {role: 'assistant', content};`,
  ])
    expect(scan('synthetic.ts', source).length).toBeGreaterThan(0);
  expect(
    scan(
      'valid.ts',
      `import Anthropic from '@anthropic-ai/sdk'; const req = {messages: [{role: 'user', content: [{type: 'document'}]}, {role: 'assistant', content: [{type:'text',text:'ok'}]}]};`
    )
  ).toEqual([]);
});
