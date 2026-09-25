import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const script=fileURLToPath(new URL('../assets/gateway-entrypoint.sh',import.meta.url));
function render(resolvers){
 const root=mkdtempSync(join(tmpdir(),'ours-dns-test-'));
 try {
  writeFileSync(join(root,'nginx'),'#!/bin/sh\nif [ "$1" = "-t" ]; then exit 0; fi\ncat "$2"\nrm -f "$2"\n',{mode:0o700});
  writeFileSync(join(root,'resolv.conf'),resolvers);
  writeFileSync(join(root,'template'),'resolver @@OURS_RESOLVERS@@ valid=5s;\nproxy_pass $upstream;\n');
  return spawnSync('/bin/sh',[script],{encoding:'utf8',env:{PATH:root+':'+process.env.PATH,OURS_RESOLV_CONF:join(root,'resolv.conf'),OURS_NGINX_TEMPLATE:join(root,'template')}});
 }finally{rmSync(root,{recursive:true,force:true})}
}
test('runtime resolver preserves nginx variables, formats multiple IPv4/IPv6 and deduplicates',()=>{
 const result=render('nameserver 127.0.0.11\nnameserver 2001:db8::1\nnameserver ::ffff:192.0.2.1\nnameserver 127.0.0.11\n');
 assert.equal(result.status,0,result.stderr);
 assert.equal(result.stdout,'resolver 127.0.0.11 [2001:db8::1] [::ffff:192.0.2.1] valid=5s;\nproxy_pass $upstream;\n');
});
test('invalid and injected DNS never enters nginx configuration',()=>{
 for(const value of ['','1.2.3.999','1.2.3.4;include','::1;',':::','1:2:3:4:5:6:7:8:9','1::2::3','1:2:3:4:5:6:7:8::','01.2.3.4','fe80::1%eth0']){
  const result=render('nameserver '+value+'\n');assert.notEqual(result.status,0,value);assert.match(result.stderr,/no valid runtime DNS/);
 }
});
