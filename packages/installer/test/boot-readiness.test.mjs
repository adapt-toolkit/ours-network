import test from 'node:test';
import assert from 'node:assert/strict';
import { reportBootReadiness } from '../lib/boot-readiness.mjs';
for (const variant of ['enabled','disabled','rootless-no-linger','remote','desktop']) test(`boot prerequisite diagnostic: ${variant}`, async()=>{
 const messages=[], calls=[];
 const effects={platform:{platform:'linux'},env:{},out:m=>messages.push(m),run:async(cmd,args)=>{
  calls.push([cmd,...args]);
  if(cmd==='docker'&&args[0]==='context')return {stdout:JSON.stringify([{Endpoints:{docker:{Host:variant==='remote'?'ssh://remote':variant==='desktop'?'unix:///home/test/.docker/desktop/docker.sock':'unix:///var/run/docker.sock'}}}])};
  if(cmd==='docker')return {stdout:JSON.stringify(variant==='rootless-no-linger'?['name=rootless']:[])};
  if(cmd==='systemctl'&&variant==='disabled')throw Error('disabled');
  return {stdout:cmd==='loginctl'?'no':'enabled'};
 }};
 await reportBootReadiness(effects,{mode:'docker'});
 assert(calls.every(call=>!call.includes('enable')&&!call.includes('start')&&!call.includes('restart')));
 assert.match(messages.join('\n'),variant==='enabled'?/boot service is enabled/:['remote','desktop'].includes(variant)?/cannot be verified/:/boot is not verified/);
});
