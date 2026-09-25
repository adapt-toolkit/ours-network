import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { realEffects } from '../lib/effects.mjs';
import { bindPodman, runContainer, nativeBuildCommands } from '../lib/container-engine.mjs';
import { qualifyPodman, PROBE_IMAGE } from '../lib/podman-preflight.mjs';
const options={skip:process.env.OURS_TEST_PODMAN!=='1',timeout:180000};
test('rootless Podman capabilities preserve service subpath boundaries',options,async()=>{
 const e=realEffects(),record={mode:'docker',containerEngine:'podman'};
 await bindPodman(e,record);await qualifyPodman(e,record);
});
test('native Podman build supports secret/cache mounts without persisting the secret',options,async()=>{
 const root=mkdtempSync(join(tmpdir(),'ours-build-secret-'));
 const image=`localhost/ours-build-secret-${randomUUID()}:test`;
 const secret=randomUUID();
 const e=realEffects({env:{...process.env,OURS_SYNTHETIC_BUILD_TOKEN:secret}}),record={mode:'docker',containerEngine:'podman'};
 await bindPodman(e,record);
 try {
  writeFileSync(join(root,'Dockerfile'),`FROM ${PROBE_IMAGE}\nRUN --mount=type=secret,id=github_token --mount=type=cache,target=/cache,sharing=locked test -s /run/secrets/github_token && touch /cache/probe\nUSER 101:101\n`,{mode:0o600});
  const config={services:{test:{image,platform:'linux/amd64',build:{context:root,secrets:[{source:'token',target:'github_token'}]}}},secrets:{token:{environment:'OURS_SYNTHETIC_BUILD_TOKEN'}}};
  for(const args of nativeBuildCommands(config,['test'],e.env)) {
   assert.ok(!JSON.stringify(args).includes(secret));
   const built=await runContainer(e,record,args,{timeout:120000});assert.ok(!built.stdout.includes(secret));
  }
  const inspect=await runContainer(e,record,['image','inspect',image]);
  assert.ok(!inspect.stdout.includes(secret));assert.match(JSON.parse(inspect.stdout)[0].Id,/^sha256:[a-f0-9]{64}$/);
  const history=await runContainer(e,record,['history','--no-trunc',image]);assert.ok(!history.stdout.includes(secret));
  await runContainer(e,record,['run','--rm','--network','none','--read-only','--cap-drop','ALL','--entrypoint','/bin/sh',image,'-ec','test ! -e /run/secrets/github_token; test ! -e /cache/probe']);
 }finally{
  try { const found=await runContainer(e,record,['image','exists',image],{allowCodes:[1]});if(found.code===0)await runContainer(e,record,['image','rm',image]); }
  finally{rmSync(root,{recursive:true,force:true})}
 }
});
