'use strict';
// Growth signals: companies advertising jobs right now (UK), via the Adzuna jobs API.
// Each workspace adds its own free Adzuna API key in Settings.

async function searchJobs(ws, { what, where, days = 14, fetchImpl = fetch }) {
  if (!ws.adzuna_app_id || !ws.adzuna_app_key) {
    throw new Error('Add your free Adzuna API key in Settings → Growth signals first.');
  }
  const q = new URLSearchParams({
    app_id: ws.adzuna_app_id, app_key: ws.adzuna_app_key,
    results_per_page: '50', what: String(what || ''), max_days_old: String(days), sort_by: 'date'
  });
  if (where) q.set('where', String(where));
  const res = await fetchImpl('https://api.adzuna.com/v1/api/jobs/gb/search/1?' + q.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error('The jobs search failed (' + res.status + '). Check your Adzuna key.');
  const data = await res.json();
  return (data.results || [])
    .filter((j) => j.company && j.company.display_name && !/recruit|staffing|personnel|resourcing|agency/i.test(j.company.display_name))
    .map((j) => ({
      company: String(j.company.display_name).trim(),
      job_title: String(j.title || '').replace(/<[^>]+>/g, '').trim(),
      location: j.location && j.location.display_name ? j.location.display_name : '',
      posted_at: String(j.created || '').slice(0, 10),
      url: j.redirect_url || ''
    }))
    .filter((j) => j.url);
}

function saveSignals(db, wsId, jobs) {
  let added = 0;
  for (const j of jobs) {
    const r = db.run(`INSERT OR IGNORE INTO signals (workspace_id, company, job_title, location, posted_at, url, source, created_at)
                      VALUES (?,?,?,?,?,?, 'Adzuna', ?)`, wsId, j.company, j.job_title, j.location, j.posted_at, j.url, Date.now());
    added += Number(r.changes || 0);
  }
  return added;
}

/** Ready-made opening line and source text for a lead created from a signal. */
function leadFromSignal(signal) {
  return {
    personal_line: `I saw you're hiring for a ${signal.job_title}${signal.location ? ' in ' + signal.location : ''}.`,
    source: `${signal.company}'s public job advert (${signal.job_title})`
  };
}

module.exports = { searchJobs, saveSignals, leadFromSignal };
