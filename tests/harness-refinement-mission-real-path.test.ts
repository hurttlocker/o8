import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { advanceExperiment, createExperiment } from '@/lib/harness/improvement/engine';
import { createImprovementJournal } from '@/lib/harness/improvement/journal';
import { createImprovementNamespace, type ImprovementNamespaceLaunch } from '@/lib/harness/improvement/namespace';
import type { ImprovementManifest } from '@/lib/harness/improvement/types';
import { canonical, digest } from '@/lib/harness/improvement/validation';

const roots: string[] = [];
const source = resolve('src/lib');
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'o8-refinement-mission-test-')); roots.push(root);
  const repository = join(root, 'repo'); mkdirSync(repository, { mode: 0o700 });
  const git = (...args: string[]) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q'); git('config', 'user.name', 'Isolated Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(repository, 'README.md'), 'Isolated held mission fixture.\n'); git('add', 'README.md'); git('commit', '-qm', 'fixture');
  const launch = createImprovementNamespace({ parentDirectory: root, repository, experimentId: 'held-fixture' });
  const manifest: ImprovementManifest = { id: 'held-fixture', repository, baselineRevision: git('rev-parse', 'HEAD'),
    contractDigest: 'b'.repeat(64), verifierDigest: 'c'.repeat(64), permissionsDigest: 'd'.repeat(64),
    runtime: 'codex', model: 'gpt-5.4', effort: 'high', provenance: 'native', mode: 'parallel', k: 1,
    maxStages: 30, maxStageWallMs: 1000, maxInputBytes: 100000,
    baseline: { instructions: 'Preserve permissions and review.', memory: 'Fixture memory.', skills: 'Fixture text skill.', toolGuidance: 'Use read-only inspection first.' },
    tasks: [{ id: 'A', domain: 'code', prompt: 'Inspect the isolated README and propose a small edit.' }] };
  const initial = createExperiment(manifest); const pending = advanceExperiment(initial);
  const journal = createImprovementJournal(join(launch.namespace.root, 'harness-refinement'));
  journal.append(initial, null); journal.append(pending, 0);
  return { root, repository, launch, pending, git };
}
function child(launch: ImprovementNamespaceLaunch, code: string, env: Record<string, string | undefined> = {}): Record<string, unknown> {
  const script = join(launch.namespace.root, `fixture-${Math.random().toString(16).slice(2)}.cts`);
  writeFileSync(script, `const source = ${JSON.stringify(source)};\n(async () => {\n${code}\n})().then(value => { console.log('FIXTURE_RESULT=' + JSON.stringify({ok:true,value})); process.exit(0); }).catch(error => { const errors=[]; for(let e=error;e;e=e.cause) errors.push(String(e.message)); console.log('FIXTURE_RESULT=' + JSON.stringify({ok:false,errors})); process.exit(0); });\n`, { mode: 0o600 });
  const output = execFileSync(process.execPath, ['--import', resolve('scripts/register-server-only-stub.mjs'), '--import', 'tsx', script], {
    cwd: process.cwd(), env: { ...process.env, ...launch.env, ...env }, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output.split('\n').findLast((line) => line.startsWith('FIXTURE_RESULT='))!.slice('FIXTURE_RESULT='.length));
}
function prepareCode(requestId: string): string {
  return `const { prepareImprovementMission } = require(source + '/harness/improvement/mission-preparation.ts');
    return await prepareImprovementMission({experimentId:'held-fixture', requestId:${JSON.stringify(requestId)}});`;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('trusted held refinement mission through dedicated process and real persisted entry point', () => {
  it('initializes a fresh private namespace without changing this process or importing app state', () => {
    const before = { ...process.env }; const { launch } = fixture();
    expect(process.env).toEqual(before);
    expect(lstatSync(launch.namespace.root).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(launch.namespace.root, '.refinement-namespace.json')).mode & 0o777).toBe(0o400);
    const result = child(launch, `const ns = require(source + '/harness/improvement/namespace.ts');
      const proof = ns.requireImprovementNamespace();
      return {id:proof.id, appStateLoaded:Object.keys(require.cache).some(path => /\\/lib\\/(db|orchestrator|lane)\\//.test(path))};`);
    expect(result).toEqual({ ok: true, value: { id: launch.namespace.id, appStateLoaded: false } });
    expect(existsSync(join(launch.namespace.root, 'cortex-ide.db'))).toBe(false);
  });

  it('rejects writable markers and inconsistent environment pins before app state is loaded', () => {
    const { launch, pending } = fixture();
    chmodSync(join(launch.namespace.root, '.refinement-namespace.json'), 0o600);
    expect(child(launch, prepareCode(pending.pending!.id)).ok).toBe(false);
    expect(existsSync(join(launch.namespace.root, 'cortex-ide.db'))).toBe(false);
    chmodSync(join(launch.namespace.root, '.refinement-namespace.json'), 0o400);
    expect(child(launch, prepareCode(pending.pending!.id), { CORTEX_IDE_DB_PATH: join(launch.namespace.root, 'wrong.db') }).ok).toBe(false);
  });

  it('creates one actual held packet with exact candidate text and refuses restart or launch', () => {
    const { launch, pending, repository, git } = fixture();
    const result = child(launch, prepareCode(pending.pending!.id));
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { status: 'held', namespaceId: launch.namespace.id } });
    const stored = JSON.parse(readFileSync(join(launch.namespace.root, 'orchestrator-state.json'), 'utf8'));
    const packet = stored.mission.packets[0];
    expect(stored.mission.packets).toHaveLength(1);
    expect(packet).toMatchObject({ id: `harness-refinement-${digest('held-fixture')}-${digest(pending.pending!.id)}`,
      runtime: 'codex', assignedModel: 'gpt-5.4', queueState: 'held', status: 'blocked', mergeHold: true, useBrain: false,
      workspaceTargetPath: repository, workerRouting: { selectedEffort: 'high' } });
    expect(packet.issue.body).toContain(pending.pending!.prompt);
    expect(packet.issue.body).toContain(canonical(pending.pending!.harness));
    expect(packet.prompt).toContain(packet.issue.body);
    expect(packet.orchestratorThreadId).toBeUndefined(); expect(packet.lane).toBeNull();
    const binding = JSON.parse(readFileSync(join(launch.namespace.root, 'harness-refinement-packets', `${digest(packet.id)}.binding.json`), 'utf8'));
    expect(binding.mountDigest).toBe(digest({ schema: 'o8/refinement-text-mount/v1', requestDigest: digest(pending.pending), harness: pending.pending!.harness, prompt: packet.prompt }));
    const before = readFileSync(join(launch.namespace.root, 'orchestrator-state.json'), 'utf8');
    const again = child(launch, prepareCode(pending.pending!.id)); expect(again.ok).toBe(false);
    expect(readFileSync(join(launch.namespace.root, 'orchestrator-state.json'), 'utf8')).toBe(before);
    const guard = child(launch, `const { assertImprovementPacketLaunch } = require(source + '/harness/improvement/launch-guard.ts');
      assertImprovementPacketLaunch({ packetId:${JSON.stringify(packet.id)}, repository:${JSON.stringify(repository)}, runtime:'codex', model:'gpt-5.4', effort:'high', boundary:'dispatch' }); return 'unexpected';`);
    expect(guard.ok).toBe(false);
    const credential = child(launch, `const auth = require(source + '/auth/packet-worker-token.ts');
      const token = auth.mintPacketWorkerToken(${JSON.stringify(packet.id)});
      const identity = auth.resolvePacketWorkerToken(token); return {packetId:identity?.packetId};`);
    expect(credential).toEqual({ ok:true, value:{packetId:packet.id} });
    expect(git('status', '--porcelain')).toBe('');
  });

  it('rejects an existing current mission without archiving, resetting or creating a binding', () => {
    const { launch, pending } = fixture(); const target = join(launch.namespace.root, 'orchestrator-state.json');
    const content = JSON.stringify({ version: 1, mission: { missionId: 'unrelated', packets: [] } }); writeFileSync(target, content, { mode: 0o600 });
    const result = child(launch, prepareCode(pending.pending!.id));
    expect(result.ok).toBe(false); expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/existing current mission/i)]));
    expect(readFileSync(target, 'utf8')).toBe(content);
    expect(existsSync(join(launch.namespace.root, 'harness-refinement-packets'))).toBe(false);
  });

  it('reaches held packet preparation through the authenticated API in the dedicated child', () => {
    const { launch, pending, repository } = fixture();
    const result = child(launch, `const fs = require('node:fs');
      const token = 'isolated-refinement-route-fixture-0123456789';
      fs.writeFileSync(process.env.O8_DATA_DIR + '/ws-token', token + '\\n', {mode:0o600});
      const { NextRequest } = require(source + '/../../node_modules/next/server');
      const { POST } = require(source + '/../app/api/harness/route.ts');
      const body = ${JSON.stringify({ action: 'refinement_prepare_packet', repoPath: repository,
        id: 'held-fixture', requestId: pending.pending!.id, expectedRevision: pending.revision })};
      const request = credential => new NextRequest('http://localhost/api/harness', {method:'POST',
        headers:{host:'localhost','content-type':'application/json',authorization:'Bearer '+credential},body:JSON.stringify(body)});
      const denied = await POST(request('not-the-operator'));
      const before = fs.existsSync(process.env.O8_DATA_DIR + '/orchestrator-state.json');
      const response = await POST(request(token));
      const payload = await response.json();
      const snapshot = fs.readFileSync(process.env.O8_DATA_DIR + '/orchestrator-state.json','utf8');
      const duplicate = await POST(request(token));
      const observation = await POST(new NextRequest('http://localhost/api/harness', {method:'POST',
        headers:{host:'localhost','content-type':'application/json',authorization:'Bearer '+token},
        body:JSON.stringify({...body,action:'refinement_observe_artifacts',packetId:payload.result.packetId,
          surfaceId:'missing-owned-surface',runId:'missing-owned-run'})}));
      return {denied:denied.status,before,status:response.status,payload,duplicate:duplicate.status,
        observationStatus:observation.status,observation:await observation.json(),
        unchanged:snapshot===fs.readFileSync(process.env.O8_DATA_DIR + '/orchestrator-state.json','utf8')};`);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { denied: 403, before: false,
      status: 200, payload: { ok: true, result: { status: 'held', namespaceId: launch.namespace.id } },
      observationStatus: 200, observation: { ok: true, result: { status: 'held', authorizesExecution: false } },
      duplicate: 400, unchanged: true } });
    const stored = JSON.parse(readFileSync(join(launch.namespace.root, 'orchestrator-state.json'), 'utf8'));
    expect(stored.mission.packets).toHaveLength(1);
    expect(stored.mission.packets[0]).toMatchObject({ queueState: 'held', status: 'blocked', mergeHold: true, lane: null });
  });

  it('rejects unsafe database files before importing the database module', () => {
    const { root, launch, pending } = fixture(); const target = join(root, 'unrelated.db'); writeFileSync(target, 'sentinel', { mode: 0o600 });
    symlinkSync(target, join(launch.namespace.root, 'cortex-ide.db'));
    const result = child(launch, `const { prepareImprovementMission } = require(source + '/harness/improvement/mission-preparation.ts');
      let error; try { await prepareImprovementMission({experimentId:'held-fixture',requestId:${JSON.stringify(pending.pending!.id)}}); } catch(e) { error = String(e.message); }
      return {error, dbLoaded:!!require.cache[require.resolve(source + '/db/index.ts')]};`);
    expect(result).toMatchObject({ ok: true, value: { error: expect.stringMatching(/unsafe namespace database/i), dbLoaded: false } });
    expect(readFileSync(target, 'utf8')).toBe('sentinel');
  });

  it('rejects a namespace beneath the source repo and symlinked namespace parents', () => {
    const { root, repository } = fixture();
    expect(() => createImprovementNamespace({ parentDirectory: repository, repository, experimentId: 'other' })).toThrow(/outside/i);
    const link = join(root, 'linked'); symlinkSync(root, link);
    expect(() => createImprovementNamespace({ parentDirectory: link, repository, experimentId: 'other' })).toThrow(/symlink/i);
  });

  it('rejects a loaded database pin belonging to another app namespace', () => {
    const { root, launch, pending } = fixture(); const other = join(root, 'other'); mkdirSync(other, { mode: 0o700 });
    const result = child(launch, `const pins = ${JSON.stringify(launch.env)}; process.env.O8_DATA_DIR=${JSON.stringify(other)}; process.env.CORTEX_IDE_DB_PATH=${JSON.stringify(join(other, 'cortex-ide.db'))};
      require(source + '/db/index.ts'); Object.assign(process.env,pins);
      ${prepareCode(pending.pending!.id)}`);
    expect(result.ok).toBe(false); expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/loaded database belongs/i)]));
    expect(existsSync(join(launch.namespace.root, 'harness-refinement-packets'))).toBe(false);
  });

  it('refuses existing mission and lane registry rows before any preparation writes', () => {
    for (const table of ['missions', 'lanes']) {
      const { launch, pending, repository } = fixture();
      const seeded = child(launch, `const db = require(source + '/db/index.ts').getSqlite();
        if (${JSON.stringify(table)} === 'missions') db.prepare('INSERT INTO missions (id,repo_path,created_at,updated_at) VALUES (?,?,?,?)').run('unrelated',${JSON.stringify(repository)},1,1);
        else db.prepare('INSERT INTO lanes (id,label,repo_path,branch,base_branch,runtime,status,ownership,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('unrelated','Fixture',${JSON.stringify(repository)},'main','main','codex','completed','app','now','now');
        return db.prepare('SELECT * FROM ${table}').all();`);
      expect(seeded.ok, JSON.stringify(seeded)).toBe(true);
      const result = child(launch, prepareCode(pending.pending!.id));
      expect(result.ok).toBe(false); expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/existing mission or lane registry/i)]));
      expect(existsSync(join(launch.namespace.root, 'harness-refinement-packets'))).toBe(false);
      const after = child(launch, `const Database = require(source + '/../../node_modules/better-sqlite3');
        const db = new Database(process.env.CORTEX_IDE_DB_PATH, { readonly:true, fileMustExist:true });
        try { return db.prepare('SELECT * FROM ${table}').all(); } finally { db.close(); }`);
      expect(after).toEqual(seeded);
    }
  });

  it('refuses pre-existing packet bindings rather than silently retrying a partial preparation', () => {
    const { launch, pending } = fixture();
    const staged = child(launch, `const ns = require(source + '/harness/improvement/namespace.ts').requireImprovementNamespace();
      const draft = await require(source + '/harness/improvement/mission-capability.ts').deriveImprovementMissionDraft(ns);
      return require(source + '/harness/improvement/launch-guard.ts').prepareImprovementPacketBinding({experimentId:'held-fixture', requestId:${JSON.stringify(pending.pending!.id)},mountDigest:draft.mountDigest});`);
    expect(staged.ok, JSON.stringify(staged)).toBe(true);
    const result = child(launch, prepareCode(pending.pending!.id));
    expect(result.ok).toBe(false); expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/existing packet registry/i)]));
    expect(existsSync(join(launch.namespace.root, '.mission-preparation.json'))).toBe(false);
  });

  it('preserves an existing branch and durable partial outcome without retrying createMission', () => {
    const { launch, pending, git } = fixture();
    const staged = child(launch, `const ns = require(source + '/harness/improvement/namespace.ts').requireImprovementNamespace();
      const draft = await require(source + '/harness/improvement/mission-capability.ts').deriveImprovementMissionDraft(ns);
      const branch = require(source + '/orchestrator/operator-mission-service/shared.ts').branchTargetForMissionIssue(draft.input.issues[0], 'issue', 60);
      require('node:child_process').execFileSync('git',['-C',ns.repository,'branch',branch]); return branch;`);
    expect(staged.ok, JSON.stringify(staged)).toBe(true);
    const result = child(launch, prepareCode(pending.pending!.id));
    expect(result.ok).toBe(false); expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/requires reconciliation/i)]));
    expect(existsSync(join(launch.namespace.root, '.mission-preparation.json'))).toBe(true);
    expect(existsSync(join(launch.namespace.root, '.mission-admission.json'))).toBe(false);
    expect(existsSync(join(launch.namespace.root, 'orchestrator-state.json'))).toBe(false);
    const branch = String(staged.value); const revision = git('rev-parse', `refs/heads/${branch}`);
    const again = child(launch, prepareCode(pending.pending!.id));
    expect(again.ok).toBe(false); expect(again.errors).toEqual(expect.arrayContaining([expect.stringMatching(/previous preparation requires reconciliation/i)]));
    expect(git('rev-parse', `refs/heads/${branch}`)).toBe(revision);
  });

  it('rejects changed base and dirty source without creating a packet binding', () => {
    for (const changedBase of [false, true]) {
      const { launch, pending, repository, git } = fixture(); writeFileSync(join(repository, 'README.md'), 'Changed source.');
      if (changedBase) { git('add', 'README.md'); git('commit', '-qm', 'changed'); }
      const result = child(launch, prepareCode(pending.pending!.id));
      expect(result.ok).toBe(false); expect(result.errors).toEqual(expect.arrayContaining([expect.stringMatching(/baseline revision differs/i)]));
      expect(existsSync(join(launch.namespace.root, 'harness-refinement-packets'))).toBe(false);
    }
  });

  it('does not accept JSON-copied authority or repeated capability use at createMission', () => {
    const { launch, pending } = fixture();
    const result = child(launch, `const ns = require(source + '/harness/improvement/namespace.ts').requireImprovementNamespace();
      const caps = require(source + '/harness/improvement/mission-capability.ts');
      const draft = await caps.deriveImprovementMissionDraft(ns);
      const binding = require(source + '/harness/improvement/launch-guard.ts').prepareImprovementPacketBinding({experimentId:'held-fixture',requestId:${JSON.stringify(pending.pending!.id)},mountDigest:draft.mountDigest});
      const input = await caps.bindImprovementMissionCapability(ns,binding,draft);
      const { createMission } = require(source + '/orchestrator/operator-mission-service/mission.ts');
      let copiedError; try { await createMission(JSON.parse(JSON.stringify(input))); } catch(e) { copiedError=String(e.message); }
      const before = require('node:fs').existsSync(ns.root + '/orchestrator-state.json');
      const receipt = await createMission(input);
      let repeatedError; try { await createMission(input); } catch(e) { repeatedError=String(e.message); }
      return {copiedError,before,frozen:Object.isFrozen(input)&&Object.isFrozen(input.issues[0]),repeatedError,receipt};`);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, value: { copiedError: expect.stringMatching(/nonserialized trusted/i), before: false,
      frozen: true, repeatedError: expect.stringMatching(/already entered|reconcile/i) } });
  });
});
