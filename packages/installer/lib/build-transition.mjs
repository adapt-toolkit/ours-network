import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { validateInstallation } from './plan.mjs';
import { info, ok, warn } from './ui.mjs';

/** The caller holds the installation lock; installation.json owns retry state. */
export async function serverBuildTransition(record, args, effects) {
  validateInstallation(record, record.root);
  const stage = async (label, action) => {
    effects.out?.(info(label));
    try { const result = await action(); effects.out?.(ok(`${label} complete`)); return result; }
    catch (error) { effects.out?.(warn(`Server ${args.operation} stopped during ${label.toLowerCase()}.`)); throw error; }
  };
  const path = join(record.root, 'installation.json');
  const save = transition => {
    record = { ...record, buildTransition: transition };
    validateInstallation(record, record.root);
    effects.writeJson(path, JSON.stringify(record, null, 2) + '\n');
  };
  let transition = record.buildTransition;
  if (!transition) {
    const candidate = await stage('Prepare the updated runtime', () => effects.prepareServerBuild(record, args));
    try {
      await stage('Verify package and stored-state compatibility', () => effects.checkServerBuild(record, candidate, !!args.compatible, args.operation));
      transition = { operation: args.operation, candidate, compatible: !!args.compatible,
        ...(args.sources ? { sourcePolicyHash: createHash('sha256').update(readFileSync(args.sources)).digest('hex') } : {}),
        runningServices: await effects.serverLifecycle(record, 'status'), phase: 'prepared' };
      save(transition);
    } catch (error) {
      await effects.discardServerBuild(candidate);
      throw error;
    }
  } else {
    const suppliedHash = args.sources ? createHash('sha256').update(readFileSync(args.sources)).digest('hex') : null;
    if (args.operation !== transition.operation || (args.sources && suppliedHash !== transition.sourcePolicyHash)) {
      throw new Error('Resume the retained server update/rebuild without substituting sources');
    }
  }
  const { candidate, runningServices } = transition;
  // A failed readiness check can leave some new services running. Every retry
  // excludes those writers again and retains the original requested running set.
  await stage('Stop services before updating stored state', () => effects.retireServerBuildRuntime(record));
  if (transition.phase === 'prepared') {
    await stage('Update stored state while retaining identities and credentials', () => effects.updateServerBuildState(record, candidate, transition.compatible, transition.operation));
    transition = { ...transition, phase: 'state-updated' };
    save(transition);
  }
  if (transition.phase === 'state-updated') {
    await stage('Activate the prepared runtime', () => effects.publishServerBuild(record, candidate));
    transition = { ...transition, phase: 'runtime-activated' };
    save(transition);
  }
  await stage('Verify retained state and identities', () => effects.validateServerBuildState(record));
  await stage('Restore previously running services and check readiness', () => effects.serverLifecycle(record, 'start', runningServices));
  const completed = { ...record, sourcePolicyHash: candidate.sourcePolicyHash };
  delete completed.buildTransition;
  effects.writeJson(path, JSON.stringify(completed, null, 2) + '\n');
  try { await effects.discardServerBuild(candidate); }
  catch { effects.out('Server update completed; temporary build artifacts could not be removed.'); }
  return completed;
}
