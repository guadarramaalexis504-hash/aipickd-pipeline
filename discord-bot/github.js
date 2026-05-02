#!/usr/bin/env node
/**
 * AIPickd Discord Bot — GitHub Actions API
 * Permite al bot disparar el pipeline y ver el estado de los runs,
 * todo sin necesidad de tener la laptop prendida.
 */

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const REPO_OWNER    = 'guadarramaalexis504-hash';
const REPO_NAME     = 'aipickd-pipeline';
const WORKFLOW_FILE = 'generate.yml';

async function ghFetch(path, options = {}) {
  const r = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!r.ok) throw new Error(`GitHub API ${r.status}: ${await r.text()}`);
  // 204 No Content — no body
  if (r.status === 204) return null;
  return r.json();
}

/**
 * Dispara un workflow_dispatch en el pipeline de generación.
 * @param {number} genCount - cuántos artículos generar (1-5)
 */
async function triggerPipelineRun(genCount = 1) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN no configurado en Railway');
  const count = Math.min(Math.max(Math.round(genCount), 1), 5);
  await ghFetch(
    `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      body: JSON.stringify({ ref: 'main', inputs: { gen_count: String(count) } }),
    }
  );
  return { triggered: true, gen_count: count, message: `Pipeline disparado: ${count} artículo(s)` };
}

/**
 * Devuelve los últimos 5 runs del pipeline con su estado.
 */
async function getLatestRuns() {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN no configurado en Railway');
  const data = await ghFetch(
    `/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=5`
  );
  return (data.workflow_runs || []).map((run) => ({
    status:     run.status,
    conclusion: run.conclusion || 'in_progress',
    started:    run.created_at?.slice(0, 16).replace('T', ' ') + ' UTC',
    duration_min: run.updated_at
      ? Math.round((new Date(run.updated_at) - new Date(run.created_at)) / 60000)
      : null,
    url: run.html_url,
  }));
}

module.exports = { triggerPipelineRun, getLatestRuns };
