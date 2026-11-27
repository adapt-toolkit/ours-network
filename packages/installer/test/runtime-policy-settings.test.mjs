import test from 'node:test';import assert from 'node:assert/strict';
import {runFleetPhase} from '../lib/orchestrate.mjs';import {fx,OURS} from './fake-effects.mjs';
for(const capable of [false,true])test(`explicit runtime settings require matching Fleet capability (${capable})`,async()=>{
 const path='/private/runtime-settings.json';
 const effects=fx({json:{[path]:{runtimePolicy:'installed-v1'}},text:{'/home/me/fleet.yaml':'api_version: ours.network/fleet/v2\n'},fleetCapabilities:capable?['init.runtime-policy-v1']:[]});
 const row=await runFleetPhase({dryRun:false,channel:'latest',acquiredFleet:'/exact/fleet',fleetSettingsPath:path},effects,{target:{stateDir:OURS,port:3050},isDefaultStateDir:true});
 assert.equal(row.state,capable?'installed':'failed',effects.recorder.out.join('\n'));
 assert.equal(effects.recorder.ran.some(args=>args[0]==='/exact/fleet' && args[1]==='init'),capable);
});
