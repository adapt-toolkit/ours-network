import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {__testables} from '../lib/effects.mjs';
test('custom executable path with spaces is probed as argv, never shell interpolated',()=>{
 const home=mkdtempSync(join(tmpdir(),'ours-client-probe-')),path=join(home,'codex custom');
 writeFileSync(path,'#!/bin/sh\ncase "$1" in --version) echo "codex-cli 0.162.1";; plugin) echo "marketplace add";; *) exit 2;; esac\n');chmodSync(path,0o700);
 const result=__testables.detectDrivenHarness({name:'codex',command:'codex',label:'Codex'},{PATH:'/nonexistent',HOME:home,CODEX_PATH:path,SHELL:'/bin/sh'});
 assert.equal(result.status,'ok');assert.equal(result.command,path);
 const absent=__testables.detectDrivenHarness({name:'codex',command:'codex',label:'Codex'},{PATH:'/nonexistent',HOME:home,CODEX_PATH:join(home,'missing'),SHELL:'/bin/sh'});assert.notEqual(absent.status,'ok');
});
