import test from 'node:test';
import assert from 'node:assert/strict';
import { realEffects } from '../lib/effects.mjs';
import { commandFailure, installerFailure, redactDiagnostic } from '../lib/diagnostics.mjs';

test('real failed command retains the first cause and every diagnostic line', async () => {
  const effects=realEffects({env:{},out:()=>{}});
  const lines=['Original failure: dependency unavailable','context line 1','context line 2','context line 3','context line 4'];
  await assert.rejects(effects.run(process.execPath,['-e',`process.stderr.write(${JSON.stringify(lines.join('\n'))});process.exit(7)`]),error=>{
    assert.match(error.message,/Exit code: 7/);
    for(const line of lines)assert(error.message.includes(line));
    return true;
  });
});

test('sensitive command preserves nested CLI stage and reason but never credential stdout or environment secrets', async () => {
  const secret='private-test-secret-never-print',token='x'.repeat(43);
  const effects=realEffects({env:{OURS_API_TOKEN:secret},out:()=>{}});
  const detail={oursInstallerError:{stage:'official-cli',message:`Official OURS CLI operation failed (access-init; exit=1): Existing daemon state requires explicit --migrate. token=${token}; ${secret}`}};
  const script=`process.stdout.write('credential-stdout-must-never-print');process.stderr.write(${JSON.stringify(JSON.stringify(detail)+'\nOURS client setup refused: legacy fallback')});process.exit(1)`;
  await assert.rejects(effects.run(process.execPath,['-e',script],{sensitive:true}),error=>{
    assert.match(error.message,/Stage: official-cli/);
    assert.match(error.message,/Existing daemon state requires explicit --migrate/);
    assert.match(error.message,/Exit code: 1/);
    assert(!error.message.includes('legacy fallback'));
    for(const value of [secret,token,'credential-stdout-must-never-print',script])assert(!error.message.includes(value));
    return true;
  });
});

for(const stage of ['daemon-provenance','mcp-directory','mcp-profile'])test(`sensitive ${stage} retains actionable reason`,()=>{
  const detail={oursInstallerError:{stage,message:'Existing build marker differs from runtime generation'}};
  const error=commandFailure('docker',['compose','run','access','access-init'],{status:1,stderr:JSON.stringify(detail),stdout:'issued-secret'},{sensitive:true,env:{}});
  assert(error.message.includes(`Stage: ${stage}`));assert.match(error.message,/Existing build marker differs/);assert(!error.message.includes('issued-secret'));
});

test('unknown sensitive stderr is withheld rather than relabelled safe',()=>{
  const error=commandFailure('docker',['compose'],{status:125,stdout:'credential-bytes',stderr:'raw private data'},{sensitive:true,env:{}});
  assert.match(error.message,/Exit code: 125/);assert.match(error.message,/no structured reason/);
  assert(!error.message.includes('raw private data'));assert(!error.message.includes('credential-bytes'));
});

test('timeout and signal preserve system evidence without leaking captured credential output',async()=>{
  const effects=realEffects({env:{},out:()=>{}});
  await assert.rejects(effects.run(process.execPath,['-e','setInterval(()=>{},1000)'],{timeout:100,sensitive:true}),error=>{
    assert.match(error.message,/System error: ETIMEDOUT/);assert.match(error.message,/Signal: SIGTERM/);assert.match(error.message,/timed out/);return true;
  });
});

test('top-level causes retain useful context and redact credential forms',()=>{
  const secret='a'.repeat(64),payload='p'.repeat(200);
  const error=new Error(`Workspace setup failed --setup-workspace ${payload}`,{cause:new Error(`Master invalid: token=${secret}; Bearer ${'b'.repeat(43)}`)});
  const text=installerFailure(error,{});
  assert.match(text,/Workspace setup failed/);assert.match(text,/Master invalid/);
  assert(!text.includes(secret));assert(!text.includes(payload));assert(!text.includes('b'.repeat(43)));
  assert.match(redactDiagnostic('https://user:private@host.test/path',{}),/https:\/\/\[redacted\]@host.test/);
});


test('interactive launch errors retain original cause and terminal failure context',async()=>{
  const effects=realEffects({env:{},out:()=>{}});
  await assert.rejects(effects.runInteractive('/missing-ours-fleet-diagnostic-fixture',[]),error=>{
    assert.equal(error.cause.code,'ENOENT');assert.match(error.message,/System error: ENOENT/);return true;
  });
});


test('short credential assignments and terminal controls cannot leak into feedback',()=>{
  const text=redactDiagnostic('\x1b[31mcredential="private-short-value"\x1b[0m\naccess_token=short-access; refresh_token=short-refresh; detail=visible',{});
  for(const secret of ['private-short-value','short-access','short-refresh','\x1b'])assert(!text.includes(secret));
  assert(text.includes('\n'));assert(text.includes('detail=visible'));
});
