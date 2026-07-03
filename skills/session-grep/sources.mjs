import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

function readJson(file) {
  try {
    if (fs.existsSync(file)) return { path: file, config: JSON.parse(fs.readFileSync(file, 'utf8')) || null };
  } catch {
    return { path: file, config: null };
  }
  return { path: null, config: null };
}

function readLocalConfig(options) {
  for (const file of sourceConfigPaths(options)) {
    const result = readJson(file);
    if (result.path) return result;
  }
  return { path: null, config: null };
}

function rootEntries(config) {
  if (Array.isArray(config)) return config;
  if (Array.isArray(config?.roots)) return config.roots;
  return [];
}

function normalizeEntries(entries, known, home) {
  return entries.flatMap((entry) => {
    const type = entry?.type ?? entry?.source;
    if (!known.has(type) || typeof entry?.root !== 'string' || !entry.root.trim()) return [];
    return [{ type, root: expandHome(entry.root.trim(), home) }];
  });
}

function dedupe(roots) {
  const seen = new Set();
  return roots.filter((r) => {
    const key = `${r.type}\0${r.root}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function loadSessionSources({
  knownSources,
  rootOverrides = [],
  env = process.env,
  cwd = process.cwd(),
  home = os.homedir(),
  defaultConfigPath,
} = {}) {
  if (rootOverrides.length) {
    return { defaultPath: null, configPath: null, roots: rootOverrides.map((root) => ({ type: 'auto', root })) };
  }

  const known = new Set(knownSources ?? []);
  const defaults = normalizeEntries(rootEntries(readJson(defaultConfigPath).config), known, home);
  const { path: configPath, config } = readLocalConfig({ env, cwd, home });
  let roots = defaults;

  if (Array.isArray(config) || Array.isArray(config?.roots)) {
    roots = normalizeEntries(rootEntries(config), known, home);
  } else if (config && typeof config === 'object') {
    const disable = new Set((Array.isArray(config.disable) ? config.disable : []).filter((s) => typeof s === 'string'));
    roots = defaults.filter((r) => !disable.has(r.type));
    roots.push(...normalizeEntries(Array.isArray(config.add) ? config.add : [], known, home));
  }

  return { defaultPath: defaultConfigPath ?? null, configPath, roots: dedupe(roots) };
}

export function configuredSourceOf(file, sourceMap, knownSources) {
  const known = new Set(knownSources ?? []);
  const resolvedFile = path.resolve(file);
  let best = null;
  for (const entry of sourceMap.roots) {
    if (entry.type === 'auto' || !known.has(entry.type)) continue;
    const root = path.resolve(entry.root);
    const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (resolvedFile === root || resolvedFile.startsWith(prefix)) {
      if (!best || root.length > best.root.length) best = { type: entry.type, root };
    }
  }
  return best?.type ?? null;
}
