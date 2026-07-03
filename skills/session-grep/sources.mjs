import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function defaultSessionSources(home = os.homedir()) {
  return [
    { source: 'claude', root: path.join(home, '.claude/projects') },
    { source: 'codex', root: path.join(home, '.codex/sessions') },
    { source: 'codex', root: path.join(home, '.codex/archived_sessions') },
  ];
}

function expandHome(p, home) {
  return p.startsWith('~/') ? path.join(home, p.slice(2)) : p;
}

function sourceConfigPaths({ env, cwd, home }) {
  if (env.SESSION_GREP_SOURCES_FILE) return [env.SESSION_GREP_SOURCES_FILE];
  return [
    path.join(cwd, 'session_sources.json'),
    path.join(cwd, '.session-grep/session_sources.json'),
    env.SESSION_GREP_HOME && path.join(env.SESSION_GREP_HOME, 'session_sources.json'),
    path.join(home, '.session-grep/session_sources.json'),
  ].filter(Boolean);
}

function readSourceConfig(options) {
  for (const file of sourceConfigPaths(options)) {
    try {
      if (fs.existsSync(file)) return { path: file, config: JSON.parse(fs.readFileSync(file, 'utf8')) || {} };
    } catch {
      return { path: file, config: {} };
    }
  }
  return { path: null, config: {} };
}

export function loadSessionSources({
  knownSources,
  rootOverrides = [],
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
} = {}) {
  if (rootOverrides.length) {
    return { configPath: null, roots: rootOverrides.map((root) => ({ source: 'auto', root })) };
  }

  const known = new Set(knownSources ?? []);
  const { path: configPath, config } = readSourceConfig({ env, cwd, home });
  const disable = new Set((Array.isArray(config.disable) ? config.disable : []).filter((s) => typeof s === 'string'));
  const roots = defaultSessionSources(home).filter((r) => known.has(r.source) && !disable.has(r.source));

  for (const entry of Array.isArray(config.add) ? config.add : []) {
    if (entry && known.has(entry.source) && typeof entry.root === 'string' && entry.root.trim()) {
      roots.push({ source: entry.source, root: expandHome(entry.root.trim(), home) });
    }
  }

  const seen = new Set();
  return {
    configPath,
    roots: roots.filter((r) => {
      const key = `${r.source}\0${r.root}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  };
}

export function configuredSourceOf(file, sourceMap, knownSources) {
  const known = new Set(knownSources ?? []);
  const resolvedFile = path.resolve(file);
  let best = null;
  for (const entry of sourceMap.roots) {
    if (entry.source === 'auto' || !known.has(entry.source)) continue;
    const root = path.resolve(entry.root);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolvedFile === root || resolvedFile.startsWith(prefix)) {
      if (!best || root.length > best.root.length) best = { source: entry.source, root };
    }
  }
  return best?.source ?? null;
}
