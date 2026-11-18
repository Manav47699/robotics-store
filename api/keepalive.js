// Vercel Cron (see "crons" in vercel.json) calls this once a day. It calls
// public.keepalive_ping() (migration 0003), which writes a heartbeat row to a hidden
// table and deletes the previous one, so the free Supabase project is never paused
// for inactivity. Independent of GitHub Actions. The store's data is untouched.
module.exports = async (req, res) => {
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const cfg = await (await fetch(`https://${host}/js/config.js`)).text();
    const url = (cfg.match(/https:\/\/[a-z0-9]+\.supabase\.co/) || [])[0];
    const key = (cfg.match(/sb_publishable_[A-Za-z0-9_-]+/) || [])[0];
    if (!url || !key) throw new Error('could not read Supabase URL/key from js/config.js');
    const r = await fetch(`${url}/rest/v1/rpc/keepalive_ping`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_source: 'vercel-cron' }),
    });
    const body = await r.text();
    res.status(r.ok ? 200 : 502).json({ ok: r.ok, status: r.status, heartbeat: r.ok ? JSON.parse(body) : undefined, at: new Date().toISOString() });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
};
