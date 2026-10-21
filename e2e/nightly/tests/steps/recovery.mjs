import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash,randomUUID } from 'node:crypto';
import { Given,Then } from '@cucumber/cucumber';
import { attach,nodes,until,recordEvidence } from './common.mjs';
Given('both daemons have restarted after committed messages and files',async function(){
 this.fixture=JSON.parse(readFileSync('/tmp/recovery.json','utf8'));
 this.a=await attach(this,nodes.a);this.b=await attach(this,nodes.b);
 for(const [index,c] of [this.a,this.b].entries()){
  const expected=this.fixture.identities[index];await c.chooseIdentity({name:expected.name,force:false});
  assert.equal((await c.currentIdentity()).cid,expected.cid);
 }
});
Then('their identities credentials contacts history and file bytes are unchanged',async function(){
 const f=this.fixture;
 assert.deepEqual(Object.values(nodes).map(n=>createHash('sha256').update(readFileSync(n.credentialPath)).digest('hex')),f.credentialHashes);
 assert.ok((await this.a.listContacts()).contacts.some(x=>x.name===f.peer || x.display===f.peer));
 assert.ok((await this.b.listIncomingMessages()).some(x=>x.wire_id===f.message));
 assert.ok((await this.b.listIncomingFiles()).some(x=>x.wire_id===f.file));
 assert.equal((await this.b.getHistoryItem({wire_id:f.message})).body,f.body);
 assert.equal(Buffer.from(await this.b.fetchFile(f.file)).toString(),f.bytes);
 assert.equal((await this.b.getFiles({wire_ids:[f.file]})).files.length,1);
 recordEvidence(this,'Restart invariants',{identities:2,unreadMessagePreserved:true,unreadFilePreserved:true,fileBytesEqual:true,credentialUnchanged:true});
});
Then('the preserved contact can exchange a new encrypted message',async function(){
 const text=`post-restart-${randomUUID()}`;const sent=await this.a.sendMessage({contact:this.fixture.peer,text});assert.equal(sent.sent,true);
 await until('post-restart encrypted delivery',async()=> (await this.b.listIncomingMessages()).some(x=>x.wire_id===sent.wire_id)?true:undefined);
 assert.equal((await this.b.getHistoryItem({wire_id:sent.wire_id})).body,text);
});
