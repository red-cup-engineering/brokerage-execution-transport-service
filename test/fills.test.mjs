import test from 'node:test';
import assert from 'node:assert/strict';
import {correlateOrderFills,readOrderFills} from '../src/fills.mjs';
const order={id:'fe060a1b-5b45-4eba-ba46-c3a3345d8255',symbol:'ETH/USD',side:'buy',filled_qty:'0.3'};
const fill=(id,qty,price='2500.01')=>({id,activity_type:'FILL',order_id:order.id,symbol:'ETHUSD',side:'buy',qty,price,transaction_time:'2026-10-07T00:00:00Z'});
test('partial fills reconcile exact fractional quantities without inventing profit',()=>{
 const result=correlateOrderFills(order,[fill('a','0.1'),fill('b','0.2','2500.02')]);
 assert.equal(result.disposition,'order-fills-correlated');assert.equal(result.filledQuantity,'0.3');assert.equal(result.grossCashFlowUsd,'-750.005');assert.equal(result.realizedPnlUsd,null);assert.equal(result.feesReconciled,false);
 assert.equal(correlateOrderFills(order,[fill('a','0.1')]).disposition,'pending');
 assert.equal(correlateOrderFills(order,[fill('a','0.1'),fill('b','0.2')],{complete:false}).disposition,'pending');
});
test('foreign, duplicated, excessive and malformed fills cannot establish reconciliation',()=>{
 assert.throws(()=>correlateOrderFills(order,[{...fill('a','0.3'),order_id:'another'}]),/mismatch/);
 assert.throws(()=>correlateOrderFills(order,[fill('a','0.1'),fill('a','0.2')]),/duplicate/);
 assert.throws(()=>correlateOrderFills(order,[fill('a','0.4')]),/exceeds/);
 assert.throws(()=>correlateOrderFills(order,[fill('a','NaN')]),/decimal/);
});
test('bounded pagination records every page and rejects a looping cursor',async()=>{
 const page=Array.from({length:100},(_,i)=>fill('row'+i,'0.001'));let calls=0;
 const result=await readOrderFills({listActivities:async request=>{assert.equal(request.orderId,order.id);assert.equal(request.pageSize,100);calls++;if(calls===1)return{id:'r1',status:200,payload:page};assert.equal(request.pageToken,'row99');return{id:'r2',status:200,payload:[fill('last','0.2')]};}},{orderId:order.id});
 assert.equal(result.complete,true);assert.deepEqual(result.pageReceipts,['r1','r2']);assert.equal(correlateOrderFills(order,result.payload).disposition,'order-fills-correlated');
 await assert.rejects(readOrderFills({listActivities:async()=>({id:'loop',status:200,payload:page})},{orderId:order.id}),/did-not-advance/);
});
