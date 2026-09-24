import assert from "node:assert/strict";
import test from "node:test";
import { executeAdmittedIntent, validateExecutionRequest } from "../src/execute-intent.mjs";

const now = "2096-01-01T00:00:00.000Z";
const contract = { id: "contract", type: "PrincipalBrokerageServiceContract", scopes: ["orders:live"], validUntil: "2097-01-01T00:00:00.000Z", risk: { maximumOrderNotional: 10, maximumLossAmount: 10 } };
const grant = { id: "grant", type: "RevocableBrokerageAuthorityGrant", revoked: false, scopes: ["orders:live"], principalContract: "contract", validUntil: "2097-01-01T00:00:00.000Z" };
const intent = { id: "intent", type: "AggressiveBrokerageOrderIntent", contract: "contract", symbol: "SPY", side: "buy", notional: 1, maximumLoss: 1 };

test("execution reaches placeOrder only after one current orders:live authority", async (t) => {
  let calls = 0;
  const adapter = { async placeOrder() { calls += 1; return { id: "venue", status: "accepted" }; } };
  const rejected = [
    ["revoked grant", { ...grant, revoked: true }, intent],
    ["absent orders:live scope", { ...grant, scopes: undefined }, intent],
    ["wrong orders:live scope", { ...grant, scopes: ["orders:paper"] }, intent],
    ["expired grant", { ...grant, validUntil: "2000-01-01T00:00:00.000Z" }, intent],
    ["forged authority binding", { ...grant, principalContract: "another-contract" }, intent],
    ["forged contract-bound intent", grant, { ...intent, contract: "forged" }],
  ];
  for (const [name, authorityGrant, candidate] of rejected) {
    await t.test(name, async () => {
      await assert.rejects(executeAdmittedIntent({ contract, authorityGrant, intent: candidate, adapter, now }), /authority|expired|contract/u);
      assert.equal(calls, 0);
    });
  }
  await t.test("accepted authority is the sole venue effect", async () => {
    const receipt = await executeAdmittedIntent({ contract, authorityGrant: grant, intent, adapter, now });
    assert.equal(calls, 1);
    assert.equal(receipt.credentialsExported, false);
  });
  assert.throws(() => validateExecutionRequest({ contract, authorityGrant: grant, intent: { ...intent, contract: "forged" }, now }), /contract/u);
});
