import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {selectServerPorts} from '../lib/server-ports.mjs';
import {__testables} from '../lib/effects.mjs';
test('fresh server avoids occupied daemon port and reserved peer ports',async()=>{
 const occupied=createServer();occupied.listen(0,'127.0.0.1');await once(occupied,'listening');
 const port=occupied.address().port;
 try {
   const record={port,coworkPort:3052,messengerPort:8420};
   selectServerPorts(record,__testables.portTakenSync);assert.notEqual(record.port,port);assert.equal(occupied.listening,true);
   assert.equal(__testables.portTakenSync(record.port),false);
   const collision={port:3050,coworkPort:3052,messengerPort:8420};selectServerPorts(collision,n=>n===3050);assert.equal(collision.port,3052);assert.equal(collision.coworkPort,3053);
   assert.throws(()=>selectServerPorts({port,coworkPort:3052,messengerPort:8420},__testables.portTakenSync,['port']),/unavailable/);
 } finally {await new Promise(resolve=>occupied.close(resolve));}
});
