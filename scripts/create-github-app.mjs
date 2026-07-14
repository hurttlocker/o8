#!/usr/bin/env node
/**
 * Create the public "o8" GitHub App via GitHub's App Manifest flow.
 *
 *   node scripts/create-github-app.mjs            # create under your user account
 *   node scripts/create-github-app.mjs o8-run     # create under an organization
 *
 * What happens:
 *   1. A local page opens with the app manifest pre-filled; you click ONE
 *      button ("Create GitHub App") on github.com while signed in.
 *   2. GitHub redirects back here with a one-time code; the script exchanges
 *      it for the app's credentials (id, slug, private key, client id).
 *   3. The private key is written to ~/.o8/o8-github-app.pem (0600) — it is
 *      NEVER printed. The script prints the Railway env vars to set on the
 *      license server, which is the only place the key belongs.
 *
 * The manifest is the source of truth for the App's permission set — change it
 * here, not ad-hoc in the GitHub UI, so the install screen stays reviewable.
 */
import { createServer } from 'node:http';
import { writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const ORG = process.argv[2] || null;
const PORT = 8477;

const manifest = {
  name: 'o8',
  url: 'https://o8.run',
  description: 'The governance layer for autonomous engineering teams.',
  public: true,
  redirect_url: `http://localhost:${PORT}/callback`,
  default_permissions: {
    contents: 'write',
    issues: 'write',
    pull_requests: 'write',
    checks: 'read',
    actions: 'read',
    metadata: 'read',
  },
  default_events: [],
};

const target = ORG
  ? `https://github.com/organizations/${ORG}/settings/apps/new`
  : 'https://github.com/settings/apps/new';

const formPage = `<!doctype html><meta charset="utf-8"><title>Create the o8 GitHub App</title>
<body style="font-family:-apple-system,sans-serif;max-width:560px;margin:80px auto;line-height:1.5">
<h2>Create the o8 GitHub App</h2>
<p>Owner: <b>${ORG ? `organization ${ORG}` : 'your user account'}</b></p>
<p>This submits the manifest below to GitHub — you'll land on a page with one
<b>Create GitHub App</b> button. Click it, and GitHub sends the credentials back
to this script automatically.</p>
<form action="${target}" method="post">
  <input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, '&#39;')}'>
  <button type="submit" style="font-size:16px;padding:10px 22px;cursor:pointer">Continue to GitHub</button>
</form>
<pre style="background:#f4f4f4;padding:12px;border-radius:8px;font-size:12px">${JSON.stringify(manifest, null, 2)}</pre>
</body>`;

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(formPage);
    return;
  }
  if (url.pathname === '/callback') {
    const code = url.searchParams.get('code');
    if (!code) {
      res.writeHead(400).end('missing code');
      return;
    }
    try {
      const convert = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
        method: 'POST',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if (!convert.ok) throw new Error(`conversion → HTTP ${convert.status}: ${await convert.text()}`);
      const app = await convert.json();

      const pemPath = join(homedir(), '.o8', 'o8-github-app.pem');
      mkdirSync(join(homedir(), '.o8'), { recursive: true });
      writeFileSync(pemPath, app.pem, { mode: 0o600 });

      console.log('\n✓ GitHub App created');
      console.log(`  name:   ${app.name}  (slug: ${app.slug})`);
      console.log(`  id:     ${app.id}`);
      console.log(`  owner:  ${app.owner?.login}`);
      console.log(`  key:    ${pemPath}  (0600 — never commit, never print)`);
      console.log('\nSet these on the LICENSE SERVER (Railway → o8-license-server → Variables):');
      console.log(`  GITHUB_APP_ID=${app.id}`);
      console.log(`  GITHUB_APP_SLUG=${app.slug}`);
      console.log(`  GITHUB_APP_PRIVATE_KEY=<paste the contents of ${pemPath}>`);
      console.log('\nInstall page users will hit: https://github.com/apps/' + app.slug + '/installations/new');

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<body style="font-family:sans-serif;margin:80px auto;max-width:520px"><h2>Done — o8 app created.</h2><p>Credentials captured. Close this tab; the rest is in the terminal.</p></body>');
    } catch (err) {
      console.error('conversion failed:', err.message);
      res.writeHead(500).end('conversion failed — see terminal');
    } finally {
      setTimeout(() => server.close(() => process.exit(0)), 500);
    }
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Open http://localhost:${PORT} — one click there, one click on GitHub.`);
  try {
    execFileSync('open', [`http://localhost:${PORT}`]);
  } catch {
    /* non-macOS: open manually */
  }
});
