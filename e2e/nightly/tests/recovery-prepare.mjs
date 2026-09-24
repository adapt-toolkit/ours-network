import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { attachOursClient } from '@ours.network/sdk/client';
import { nodes } from './topology.mjs';
const clients=[];
const attach=async side=>{const c=await attachOursClient({...nodes[side],expectedInstanceId:nodes[side].instanceId,sessionMode:'external',leaseToken:randomUUID(),requestSignal:AbortSignal.timeout(90000)});clients.push(c);return c;};
async function wait(fn){const deadline=Date.now()+30000;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,200));}throw Error('Recovery fixture readiness timed out');}
try {
 const a=await attach('a'),b=await attach('b');
 for(const [c,name] of [[a,'RecoveryA'],[b,'RecoveryB']])await c.createRootIdentity({name,bio:'recovery fixture',exposeLocal:false,localAutoAccept:true,skipIfRootExists:false});
 const identities=[await a.currentIdentity(),await b.currentIdentity()];
 const invite=await b.generateInvite();const peer=await a.addContact({invite:invite.blob});
 await wait(async()=> (await a.listContacts()).contacts.length>0 && (await b.listContacts()).contacts.length>0);
 const body=`durable-${randomUUID()}`,bytes=`durable-file-${randomUUID()}`;
 const message=await a.sendMessage({contact:peer.display,text:body});
 const file=await a.sendFile({contact:peer.display,data_base64:Buffer.from(bytes).toString('base64'),filename:'durable.txt',mime:'text/plain'});
 assert.equal(message.sent,true);assert.equal(file.sent,true);
 await wait(async()=> (await b.listIncomingMessages()).some(x=>x.wire_id===message.wire_id) && (await b.listIncomingFiles()).some(x=>x.wire_id===file.wire_id));
 writeFileSync('/tmp/recovery.json',JSON.stringify({identities:identities.map(x=>({name:x.name,cid:x.cid})),body,bytes,message:message.wire_id,file:file.wire_id,peer:peer.display,credentialHashes:Object.values(nodes).map(n=>createHash('sha256').update(readFileSync(n.credentialPath)).digest('hex'))}),{mode:0o600});
 console.log('Recovery fixture persisted: two roots, contact, unread message and file.');
} finally {for(const c of clients){await c.releaseLease();await c.close();}}
