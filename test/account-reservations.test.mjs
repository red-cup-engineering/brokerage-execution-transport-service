import assert from 'node:assert/strict';
import test from 'node:test';
import {createLiveExecutionAndReconciliationProvider, assessCurrentExecutionCapacity} from '../src/execute-intent.mjs';
const scopes = ['account:read','positions:read','orders:read','orders:live','activities:read'];
const contract = {id:'contract',type:'PrincipalBrokerageServiceContract',venue:'alpaca-trading-live',accountReference:'account',scopes,validUntil:'2097-01-01',capital:{currency:'USD'},risk:{maximumOrderNotional:60,maximumLossAmount:60,maximumAggregateNotional:75,concentrationLimit:1,shorting:false}};
const grant = {id:'grant',type:'RevocableBrokerageAuthorityGrant',venue:'alpaca-trading-live',adapter:'alpaca-trading-live',accountReference:'account',principalContract:'contract',revoked:false,scopes,validUntil:'2097-01-01'};
const receipt = payload => ({id:'receipt',status:200,payload});
const account = {id:'account',status:'ACTIVE',currency:'USD',equity:'100',buying_power:'100'};
const intent = id => ({id,type:'AggressiveBrokerageOrderIntent',contract:'contract',symbol:'SPY',side:'buy',notional:50,maximumLoss:50});
test('resting orders reserve sleeve exposure even when broker buying power is larger',()=>{
 assert.throws(()=>assessCurrentExecutionCapacity({contract,intent:intent('second'),accountReceipt:receipt(account),positionsReceipt:receipt([]),openOrdersReceipt:receipt([{symbol:'SPY',side:'buy',notional:'50'}])}),/aggregate-exposure/);
 assert.throws(()=>assessCurrentExecutionCapacity({contract,intent:intent('second'),accountReceipt:receipt(account),positionsReceipt:receipt([]),openOrdersReceipt:receipt(Array.from({length:500},()=>({})))}),/complete-bounded/);
});
test('distinct concurrent intents cannot each spend the same account capacity',async()=>{
 const orders=[];
 const adapter={
  readAccount:async()=>receipt(account),listPositions:async()=>receipt([]),listActivities:async()=>receipt([]),
  listOpenOrders:async()=>receipt([...orders]),
  getOrderByClientOrderId:async({clientOrderId})=>{const order=orders.find(o=>o.client_order_id===clientOrderId);return order?receipt(order):{status:404};},
  placeOrder:async({order})=>{await new Promise(resolve=>setImmediate(resolve));orders.push({...order,status:'new'});return receipt(order);},
 };
 const execute=createLiveExecutionAndReconciliationProvider({adapter,clock:()=> '2096-01-01T00:00:00Z',resolveLiveExecutionRecords:async refs=>({contract,authorityGrant:grant,intent:intent(refs.intentReference)})});
 const results=await Promise.allSettled(['first','second'].map(id=>execute({contractReference:'contract',authorityGrantReference:'grant',intentReference:id})));
 assert.equal(orders.length,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.match(results.find(r=>r.status==='rejected').reason.message,/aggregate-exposure/);
});
