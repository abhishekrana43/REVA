/**
 * Nia Service — interfaces with the Nia API (apigcp.trynia.ai) to index
 * GitHub repositories and perform semantic code search for PR review context.
 */

const BASE_URL = 'https://apigcp.trynia.ai/v2';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headers() {
  const key = process.env.NIA_API_KEY;
  if (!key) {
    throw new Error('NIA_API_KEY is not set in the environment');
  }
  return {
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

async function niaFetch(path, options = {}) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Nia API ${options.method ?? 'GET'} ${path} → ${res.status}: ${body}`);
  }

  return res.json();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// indexRepo
// ---------------------------------------------------------------------------

/**
 * Ensure a GitHub repository is indexed in Nia and return its source_id.
 *
 * 1. Try to resolve the repo by identifier (fast path for already-indexed repos).
 * 2. If not found, create a new source and wait for indexing to complete.
 *
 * @param {string} repoFullName  e.g. "owner/repo"
 * @returns {Promise<string>} source_id
 */
export async function indexRepo(repoFullName) {
  // --- Fast path: check if already indexed via resolve endpoint ---
  const existing = await findExistingSource(repoFullName);
  if (existing) {
    // If the source exists and is already indexed, return immediately.
    if (existing.status === 'indexed' || existing.status === 'ready') {
      return existing.id;
    }
    // Source exists but is still indexing — poll for completion.
    return pollUntilIndexed(existing.id);
  }

  // --- Create a new source ---
  const created = await niaFetch('/sources', {
    method: 'POST',
    body: JSON.stringify({
      type: 'repository',
      url: `https://github.com/${repoFullName}`,
    }),
  });

  return pollUntilIndexed(created.id);
}

/**
 * Look up a source by its identifier (owner/repo). Returns the source object
 * if found, or null.
 */
async function findExistingSource(repoFullName) {
  // First try the resolve endpoint — fastest and most precise.
  try {
    const resolved = await niaFetch(
      `/sources/resolve?identifier=${encodeURIComponent(repoFullName)}&type=repository`,
    );
    if (resolved?.id) {
      // Resolve returns a minimal object; fetch full details for status.
      return niaFetch(`/sources/${resolved.id}`);
    }
  } catch {
    // resolve returns 404 when unknown — fall through to list search.
  }

  // Fallback: search the list endpoint.
  try {
    const list = await niaFetch(
      `/sources?query=${encodeURIComponent(repoFullName)}&type=repository&limit=5`,
    );
    const match = list.items?.find(
      (s) => s.identifier === repoFullName || s.identifier === `https://github.com/${repoFullName}`,
    );
    return match ?? null;
  } catch {
    return null;
  }
}

/**
 * Poll GET /sources/{id} until status is 'indexed' (or 'ready').
 * Times out after 10 minutes.
 */
async function pollUntilIndexed(sourceId) {
  const POLL_INTERVAL_MS = 30_000;
  const MAX_WAIT_MS = 10 * 60 * 1000;
  const deadline = Date.now() + MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const source = await niaFetch(`/sources/${sourceId}`);
    const status = source.status;

    if (status === 'indexed' || status === 'ready') {
      return sourceId;
    }

    if (status === 'failed' || status === 'error') {
      throw new Error(`Nia source ${sourceId} indexing failed (status: ${status})`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error(`Nia source ${sourceId} indexing timed out after 10 minutes`);
}

// ---------------------------------------------------------------------------
// searchRepo
// ---------------------------------------------------------------------------

/**
 * Perform a semantic search against a specific indexed source.
 *
 * Uses the unified /search endpoint in "query" mode, scoped to the
 * given repository. Returns the synthesized content and source file paths.
 *
 * @param {string} sourceId  The Nia source id
 * @param {string} query     Natural-language search query
 * @param {number} maxChunks Maximum number of result chunks (default 8)
 * @returns {Promise<Array<{content: string, file_path: string, score: number}>>}
 */
export async function searchRepo(sourceId, query, maxChunks = 8) {
  // Fetch the source metadata so we can scope the search by identifier.
  const source = await niaFetch(`/sources/${sourceId}`);
  const repoIdentifier = source.identifier ?? source.display_name ?? sourceId;

  const result = await niaFetch('/search', {
    method: 'POST',
    body: JSON.stringify({
      mode: 'query',
      messages: [{ role: 'user', content: query }],
      repositories: [repoIdentifier],
    }),
  });

  // Nia returns { content: string, sources: string[] (file paths) }
  const chunks = [];

  if (result.content) {
    // The sources array contains file path strings
    const filePaths = Array.isArray(result.sources) ? result.sources : [];

    // Create one chunk with the full synthesized content and all source files
    chunks.push({
      content: result.content,
      file_path: filePaths.slice(0, maxChunks).join(', '),
      score: 1,
    });
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// buildContextForDiff
// ---------------------------------------------------------------------------

/**
 * Build rich context for a PR diff by extracting identifiers from the changed
 * code and searching for their definitions / usages in the indexed repo.
 *
 * This is the core intelligence function that gives the AI reviewer
 * understanding of the broader codebase context around a set of changes.
 *
 * @param {string} sourceId  The Nia source id for the repository
 * @param {string} diff      The unified diff text (e.g. from `git diff`)
 * @returns {Promise<Array<{content: string, file_path: string, score: number}>>}
 *          Top 10 context chunks ranked by relevance.
 */
export async function buildContextForDiff(sourceId, diff) {
  const { filePaths, identifiers } = parseDiff(diff);

  // Build targeted search queries from the extracted identifiers.
  const queries = buildSearchQueries(filePaths, identifiers);

  // Run searches in parallel (bounded concurrency to avoid rate limits).
  const CONCURRENCY = 3;
  const allChunks = [];

  for (let i = 0; i < queries.length; i += CONCURRENCY) {
    const batch = queries.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map((q) => searchRepo(sourceId, q, 5)),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        allChunks.push(...result.value);
      }
    }
  }

  // Deduplicate by content (using a fingerprint of the first 200 chars + file path).
  const seen = new Set();
  const unique = [];

  for (const chunk of allChunks) {
    const fingerprint = `${chunk.file_path}::${chunk.content.slice(0, 200)}`;
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      unique.push(chunk);
    }
  }

  // Boost chunks whose file_path appears in the diff (adjacent-file relevance).
  for (const chunk of unique) {
    if (chunk.file_path && filePaths.some((fp) => chunk.file_path.includes(fp))) {
      chunk.score *= 1.25;
    }
  }

  // Sort by score descending, return top 10.
  return unique
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Diff Parsing
// ---------------------------------------------------------------------------

function normalizeDiffPath(rawPath) {
  if (!rawPath) return null;

  let path = rawPath.trim().split("\t", 1)[0].trim();
  path = path.replace(/^"(.*)"$/, "$1");
  path = path.replace(/\s+\([^)]+\)$/, "");

  if (path === "/dev/null") {
    return null;
  }

  if (path.startsWith("a/") || path.startsWith("b/")) {
    path = path.slice(2);
  }

  return path || null;
}

function addDiffPath(filePaths, rawPath) {
  const normalized = normalizeDiffPath(rawPath);
  if (normalized) {
    filePaths.add(normalized);
  }
}

/**
 * Parse a unified diff to extract changed file paths and meaningful
 * identifiers (function names, class names, variable names, imports).
 */
function parseDiff(diff) {
  const filePaths = new Set();
  const identifiers = new Set();

  const lines = diff.split('\n');

  for (const line of lines) {
    const gitDiffMatch = line.match(/^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/);
    if (gitDiffMatch) {
      addDiffPath(filePaths, gitDiffMatch[1]);
      addDiffPath(filePaths, gitDiffMatch[2]);
      continue;
    }

    const renameMatch = line.match(/^rename (?:from|to)\s+(.+)$/);
    if (renameMatch) {
      addDiffPath(filePaths, renameMatch[1]);
      continue;
    }

    // Extract file paths from diff headers.
    // Matches: +++ b/path/to/file.js or --- a/path/to/file.js
    const fileMatch = line.match(/^(?:\+\+\+|---)\s+(.+)/);
    if (fileMatch) {
      addDiffPath(filePaths, fileMatch[1]);
      continue;
    }

    // Only look at added/removed lines for identifiers (skip context lines).
    if (!line.startsWith('+') && !line.startsWith('-')) continue;
    // Skip diff metadata lines.
    if (line.startsWith('+++') || line.startsWith('---')) continue;

    const code = line.slice(1); // strip the +/- prefix

    // Function declarations / definitions
    // JS/TS: function foo(, const foo = (, async function bar(
    // Python: def foo(
    // Go: func Foo(
    // Rust: fn foo(
    // Java/C#: public void foo(, private static int bar(
    const funcPatterns = [
      /(?:function\s+)(\w+)\s*\(/g,
      /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)\s*=>|function)/g,
      /(?:def\s+)(\w+)\s*\(/g,
      /(?:func\s+)(\w+)\s*\(/g,
      /(?:fn\s+)(\w+)\s*\(/g,
      /(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:\w+\s+)+(\w+)\s*\(/g,
    ];

    for (const pattern of funcPatterns) {
      let m;
      while ((m = pattern.exec(code)) !== null) {
        if (m[1] && m[1].length > 2) identifiers.add(m[1]);
      }
    }

    // Class declarations
    const classMatch = code.match(/(?:class|interface|struct|enum|trait|type)\s+(\w+)/);
    if (classMatch && classMatch[1]?.length > 2) {
      identifiers.add(classMatch[1]);
    }

    // Import identifiers (JS/TS/Python)
    // import { Foo, Bar } from '...'
    const importBrackets = code.match(/import\s+\{([^}]+)\}/);
    if (importBrackets) {
      importBrackets[1].split(',').forEach((id) => {
        const cleaned = id.trim().split(/\s+as\s+/)[0].trim();
        if (cleaned.length > 2) identifiers.add(cleaned);
      });
    }

    // import Foo from '...'
    const importDefault = code.match(/import\s+(\w+)\s+from\s/);
    if (importDefault && importDefault[1].length > 2) {
      identifiers.add(importDefault[1]);
    }

    // from module import Foo, Bar (Python)
    const pyImport = code.match(/from\s+\S+\s+import\s+(.+)/);
    if (pyImport) {
      pyImport[1].split(',').forEach((id) => {
        const cleaned = id.trim().split(/\s+as\s+/)[0].trim();
        if (cleaned.length > 2 && /^\w+$/.test(cleaned)) identifiers.add(cleaned);
      });
    }

    // Method calls that look significant: foo.barMethod(
    const methodCalls = code.matchAll(/(\w{3,})\.(\w{3,})\s*\(/g);
    for (const mc of methodCalls) {
      identifiers.add(mc[2]);
    }
  }

  // Remove common noise words / built-ins that aren't useful for search.
  const NOISE = new Set([
    'use', 'get', 'set', 'new', 'this', 'self', 'null', 'true', 'false',
    'undefined', 'return', 'const', 'let', 'var', 'for', 'while', 'map',
    'filter', 'reduce', 'forEach', 'push', 'pop', 'slice', 'splice',
    'length', 'toString', 'valueOf', 'constructor', 'prototype', 'console',
    'log', 'error', 'warn', 'info', 'debug', 'test', 'describe', 'expect',
    'require', 'module', 'exports', 'default', 'string', 'number', 'boolean',
    'object', 'array', 'void', 'int', 'float', 'double', 'char', 'bool',
    'String', 'Number', 'Boolean', 'Object', 'Array', 'Promise', 'Error',
    'Math', 'Date', 'JSON', 'RegExp', 'Map', 'Set', 'async', 'await',
    'then', 'catch', 'finally', 'throw', 'try', 'else', 'elif', 'None',
    'True', 'False', 'pass', 'break', 'continue', 'yield', 'from', 'import',
    'class', 'function', 'print', 'range', 'list', 'dict', 'tuple',
  ]);

  const filteredIdentifiers = [...identifiers].filter((id) => !NOISE.has(id));

  return {
    filePaths: [...filePaths],
    identifiers: filteredIdentifiers,
  };
}

/**
 * Build a set of targeted search queries from extracted file paths
 * and identifiers. Groups related identifiers to minimize API calls.
 */
function buildSearchQueries(filePaths, identifiers) {
  const queries = [];

  // 1. File-level context queries — ask about the purpose of changed files.
  //    Group files to reduce query count.
  if (filePaths.length > 0) {
    const fileGroups = [];
    for (let i = 0; i < filePaths.length; i += 3) {
      fileGroups.push(filePaths.slice(i, i + 3));
    }
    for (const group of fileGroups.slice(0, 3)) {
      queries.push(
        `Implementation and purpose of ${group.join(', ')}`,
      );
    }
  }

  // 2. Identifier-based queries — search for definitions and usages.
  //    Group 2-3 related identifiers per query.
  if (identifiers.length > 0) {
    const idGroups = [];
    for (let i = 0; i < identifiers.length; i += 2) {
      idGroups.push(identifiers.slice(i, i + 2));
    }
    for (const group of idGroups.slice(0, 5)) {
      queries.push(group.join(' '));
    }
  }

  // 3. If we have very few queries, add a general diff-summary query.
  if (queries.length === 0) {
    queries.push('main entry point and core architecture');
  }

  // Cap total queries to keep latency reasonable.
  return queries.slice(0, 8);
}
