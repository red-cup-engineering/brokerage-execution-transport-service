import assert from 'node:assert/strict';
import test from 'node:test';
import {createLiveExecutionAndReconciliationProvider, assessCurrentExecutionCapacity} from '../src/execute-intent.mjs';
const scopes = ['account:read','positions:read','orders:read','orders:live','activities:read'];
const contract = {id:'contract',type:'PrincipalBrokerageServiceContract',venue:'alpaca-trading-live',accountReference:'account',scopes,validUntil:'2097-01-01',capital:{currency:'USD'},risk:{maximumOrderNotional:60,maximumLossAmount:60,maximumAggregateNotional:75,concentrationLimit:1,shorting:false}};
const grant = {id:'grant',type:'RevocableBrokerageAuthorityGrant',venue:'alpaca-trading-live',adapter:'alpaca-trading-live',accountReference:'account',principalContract:'contract',revoked:false,scopes,validUntil:'2097-01-01'};
const receipt = payload => ({id:'receipt',status:200,payload});
const account = {id:'account',status:'ACTIVE',currency:'USD',equity:'100',cash:'100',buying_power:'100',non_marginable_buying_power:'100',multiplier:'1',shorting_enabled:false};
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

test('live default cash mandate refuses margin-powered buys and incomplete unborrowed balances', () => {
 const observe = (a, c=contract, request=intent('cash')) => assessCurrentExecutionCapacity({
   contract:c, intent:request, accountReceipt:receipt(a),positionsReceipt:receipt([]),openOrdersReceipt:receipt([]),
 });
 const funded=observe(account);
 assert.equal(funded.cashOnly,true);
 assert.equal(funded.unborrowedBuyingPower,100);
 assert.throws(()=>observe({...account,cash:'10',non_marginable_buying_power:'10',buying_power:'200'}),/insufficient-unborrowed-cash/);
 assert.throws(()=>observe({...account,non_marginable_buying_power:undefined}),/complete-unborrowed-cash-observation-required/);
 assert.throws(()=>observe({...account,cash:null}),/complete-unborrowed-cash-observation-required/);
 assert.throws(()=>observe({...account,multiplier:'4'}),/unleveraged-live-account-required/);
 assert.throws(()=>observe({...account,shorting_enabled:true}),/unleveraged-live-account-required/);
 assert.throws(()=>observe({...account,cash:'0',non_marginable_buying_power:'0'}, {...contract,risk:{...contract.risk,shorting:true}}, {...intent('short'),side:'sell'}),/sell-would-create-unapproved-short-position/);
 const explicitlyLeveraged={...contract,risk:{...contract.risk,allowBorrowedFunds:true}};
 assert.equal(observe({...account,cash:'10',non_marginable_buying_power:'10',buying_power:'200',multiplier:'4',shorting_enabled:true},explicitlyLeveraged).cashOnly,false);
});
