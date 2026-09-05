import { createHash } from "node:crypto";
import { verifySignedRecord } from "@red-cup-engineering/strategy-evaluation-service";
import { EMPTY_WITNESS_ROOT, identifyJsonSemanticContent } from "@red-cup-engineering/semantic-content-identify-service";
const canonical = (v) => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
const identify = (body) => ({ id: identifyJsonSemanticContent({
  objectKind: "brokerage.execution-transport.record",
  value: body,
  witnessRoot: EMPTY_WITNESS_ROOT,
}).id, ...body });
export function validateExecutionRequest({ contract, authorityGrant, intent, revocation, now = new Date().toISOString() }) {
  if (!Number.isFinite(Date.parse(now))) throw new TypeError("execution-time-required");
  if (contract?.type !== "PrincipalBrokerageServiceContract" || intent?.type !== "AggressiveBrokerageOrderIntent" || intent.contract !== contract.id) throw new TypeError("contract-bound-intent-required");
  if (authorityGrant?.type !== "RevocableBrokerageAuthorityGrant" || authorityGrant.revoked !== false || revocation?.effective === true
    || !contract.scopes.includes("orders:live") || !authorityGrant.scopes?.includes("orders:live") || authorityGrant.principalContract !== contract.id) throw new TypeError("live-order-authority-refused");
  if (Date.parse(now) >= Date.parse(contract.validUntil) || Date.parse(now) >= Date.parse(authorityGrant.validUntil)) throw new TypeError("live-order-authority-expired");
  if (intent.notional > contract.risk.maximumOrderNotional || intent.maximumLoss > contract.risk.maximumLossAmount) throw new RangeError("execution-limit-exceeded");
  return Object.freeze({ contract, authorityGrant, intent, revocation: revocation ?? null, now });
}
export async function executeAdmittedIntent({ contract, authorityGrant, intent, revocation, adapter, now = new Date().toISOString() }) {
  validateExecutionRequest({ contract, authorityGrant, intent, revocation, now });
  if (typeof adapter?.placeOrder !== "function") throw new TypeError("venue-adapter-required");
  const venueReceipt = await adapter.placeOrder({ grant: authorityGrant, order: { symbol: intent.symbol, side: intent.side, notional: intent.notional, type: "market", time_in_force: "day", client_order_id: intent.id.slice(-32) }, now });
  return Object.freeze(identify({ type: "BrokerageExecutionTransportReceipt", version: 1, contract: contract.id, authorityGrant: authorityGrant.id,
    intent: intent.id, venueReceipt: venueReceipt.id, venueStatus: venueReceipt.status, transportedAt: now, strategySelectedByTransport: false,
    credentialsExported: false, customerAssetsOwned: false }));
}

const reference = (value, label) => { if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label}-required`); return value; };
export function createExecutionTransportProvider({ resolveExecutionRecords, adapter, clock = () => new Date().toISOString() }) {
  if (typeof resolveExecutionRecords !== "function" || typeof adapter?.placeOrder !== "function") throw new TypeError("execution-resolver-and-adapter-required");
  const resolve = async (request) => {
    const references = Object.freeze({ contractReference: reference(request?.contractReference, "contract-reference"), authorityGrantReference: reference(request?.authorityGrantReference, "authority-grant-reference"), intentReference: reference(request?.intentReference, "intent-reference") });
    const records = await resolveExecutionRecords(references);
    if (records?.contract?.id !== references.contractReference || records?.authorityGrant?.id !== references.authorityGrantReference || records?.intent?.id !== references.intentReference) throw new TypeError("execution-resolved-record-reference-mismatch");
    const now = clock(); validateExecutionRequest({ ...records, now }); return { references, records, now };
  };
  const provider = async (request) => { const { records, now } = await resolve(request); return executeAdmittedIntent({ ...records, adapter, now }); };
  Object.defineProperties(provider, { originatingActor: { value: "urn:ame:brokerage-execution-transport-service", enumerable: true },
    preflight: { value: async (request) => { await resolve(request); }, enumerable: true },
    externalEvidence: { value: (_request, output) => [{ uri: `urn:brokerage:venue-execution:${encodeURIComponent(output.venueReceipt)}`, digest: output.id }], enumerable: true } });
  return Object.freeze(provider);
}

const paperClientOrderId = ({ contract, intent }) => `paper-${createHash("sha256").update(`${contract.id}:${intent.id}`).digest("hex").slice(0, 48)}`;
function validatePaperExecution({ contract, authorityGrant, intent, revocation, now, trustedPromotionActorKeys }) {
  if (contract?.type !== "PrincipalBrokerageServiceContract" || intent?.type !== "AggressiveBrokerageOrderIntent" || intent.contract !== contract.id) throw new TypeError("contract-bound-paper-intent-required");
  if (contract.venue !== "alpaca-trading-paper" || authorityGrant?.type !== "RevocableBrokerageAuthorityGrant" || authorityGrant.adapter !== "alpaca-trading-paper" || authorityGrant.revoked !== false || revocation?.effective === true || authorityGrant.principalContract !== contract.id) throw new TypeError("paper-order-authority-refused");
  const required = ["account:read", "positions:read", "orders:read", "orders:paper", "activities:read"];
  if (required.some((scope) => !contract.scopes?.includes(scope) || !authorityGrant.scopes?.includes(scope))) throw new TypeError("paper-order-scope-refused");
  const executionTime = Date.parse(now), contractExpiry = Date.parse(contract.validUntil), grantExpiry = Date.parse(authorityGrant.validUntil);
  if (![executionTime, contractExpiry, grantExpiry].every(Number.isFinite)) throw new TypeError("paper-order-authority-time-invalid");
  if (executionTime >= contractExpiry || executionTime >= grantExpiry) throw new TypeError("paper-order-authority-expired");
  if (intent.notional > contract.risk.maximumOrderNotional || intent.maximumLoss > contract.risk.maximumLossAmount) throw new RangeError("paper-execution-limit-exceeded");
  if (contract.scopes.includes("strategy:obsmetrologia-paper-promotion")) {
    const certificate = verifySignedRecord(intent.promotionCertificate, "ObsmetrologiaPaperPromotionCertificate", "promotionActor", trustedPromotionActorKeys, "obsmetrologia-promotion");
    if (certificate.id !== intent.promotionCertificate.id || certificate.candidate !== intent.strategyCandidate || certificate.paperPromotionEstablished !== true || certificate.liveReadinessEstablished !== false) throw new TypeError("obsmetrologia-paper-promotion-invalid");
  }
}
const TERMINAL_PAPER_ORDER_STATUSES = new Set(["filled", "canceled", "expired", "rejected"]);
function correlatedOrder(receipt, clientOrderId, phase) {
  if (receipt?.status === 404) return null;
  if (!Number.isInteger(receipt?.status) || receipt.status < 200 || receipt.status >= 300) throw new TypeError(`${phase}-order-lookup-refused`);
  if (receipt.payload?.client_order_id !== clientOrderId) throw new TypeError(`${phase}-order-client-id-mismatch`);
  return receipt;
}
export function createPaperExecutionAndReconciliationProvider({ resolvePaperExecutionRecords, adapter, trustedPromotionActorKeys = {}, clock = () => new Date().toISOString() }) {
  if (typeof resolvePaperExecutionRecords !== "function" || !["readAccount", "listPositions", "getOrderByClientOrderId", "placeOrder", "listActivities"].every((method) => typeof adapter?.[method] === "function")) throw new TypeError("paper-execution-resolver-and-adapter-required");
  const locks = new Map();
  const resolve = async (request) => {
    const references = Object.freeze({ contractReference: reference(request?.contractReference, "contract-reference"), authorityGrantReference: reference(request?.authorityGrantReference, "authority-grant-reference"), intentReference: reference(request?.intentReference, "intent-reference") });
    const records = await resolvePaperExecutionRecords(references);
    if (records?.contract?.id !== references.contractReference || records?.authorityGrant?.id !== references.authorityGrantReference || records?.intent?.id !== references.intentReference) throw new TypeError("paper-execution-resolved-record-reference-mismatch");
    const now = clock(); validatePaperExecution({ ...records, now, trustedPromotionActorKeys }); return { references, records, now };
  };
  const pending = ({ records, now, clientOrderId, placement, reason, order = null, idempotent = false }) => Object.freeze(identify({ type: "AlpacaPaperExecutionAndReconciliationReceipt", version: 1, contract: records.contract.id, authorityGrant: records.authorityGrant.id, intent: records.intent.id, clientOrderId, idempotent, placementReceipt: placement?.id ?? null, placementStatus: placement?.status ?? null, orderReceipt: order?.id ?? null, orderVenueStatus: order?.payload?.status ?? null, accountReceipt: null, positionsReceipt: null, activitiesReceipt: null, observationsComplete: false, activityCorrelationClaimed: false, orderObservationDisposition: "pending", accountReconciliationDisposition: "pending", pendingReason: reason, observedAt: now, strategySelectedByTransport: false, credentialsExported: false, liveVenueEffect: false }));
  const executeLocked = async (request) => {
    const first = await resolve(request), clientOrderId = paperClientOrderId(first.records);
    const initialReceipt = await adapter.getOrderByClientOrderId({ grant: first.records.authorityGrant, clientOrderId, now: first.now });
    let order = correlatedOrder(initialReceipt, clientOrderId, "initial"), placement = null, idempotent = Boolean(order);
    if (!order) {
      const second = await resolve(request); // exact active authority immediately before the sole venue effect
      try { placement = await adapter.placeOrder({ grant: second.records.authorityGrant, order: { symbol: second.records.intent.symbol, side: second.records.intent.side, notional: second.records.intent.notional, type: "market", time_in_force: "day", client_order_id: clientOrderId }, operationAuthorizationReference: second.records.intent.id, now: second.now }); }
      catch { placement = null; }
      let post;
      try { post = await resolve(request); }
      catch { return pending({ records: second.records, now: second.now, clientOrderId, placement, reason: "post-effect-authority-unavailable" }); }
      let postReceipt;
      try { postReceipt = await adapter.getOrderByClientOrderId({ grant: post.records.authorityGrant, clientOrderId, now: post.now }); }
      catch { return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-lookup-unavailable" }); }
      if (postReceipt.status !== 404 && (!Number.isInteger(postReceipt.status) || postReceipt.status < 200 || postReceipt.status >= 300)) return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-lookup-refused" });
      order = correlatedOrder(postReceipt, clientOrderId, "post-effect");
      if (!order) return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-not-yet-observed" });
      first.records = post.records; first.now = post.now;
    }
    let observationAuthority;
    try { observationAuthority = await resolve(request); }
    catch { return pending({ records: first.records, now: first.now, clientOrderId, placement, order, idempotent, reason: "observation-authority-unavailable" }); }
    const observations = await Promise.allSettled([adapter.readAccount({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now }), adapter.listPositions({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now }), adapter.listActivities({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now })]);
    const complete = observations.every((result) => result.status === "fulfilled" && result.value.status >= 200 && result.value.status < 300);
    const terminal = TERMINAL_PAPER_ORDER_STATUSES.has(String(order.payload?.status ?? "").toLowerCase());
    return Object.freeze(identify({ type: "AlpacaPaperExecutionAndReconciliationReceipt", version: 1, contract: observationAuthority.records.contract.id, authorityGrant: observationAuthority.records.authorityGrant.id, intent: observationAuthority.records.intent.id, clientOrderId, idempotent, placementReceipt: placement?.id ?? null, placementStatus: placement?.status ?? null, orderReceipt: order.id, orderVenueStatus: order.payload.status, accountReceipt: observations[0].status === "fulfilled" ? observations[0].value.id : null, positionsReceipt: observations[1].status === "fulfilled" ? observations[1].value.id : null, activitiesReceipt: observations[2].status === "fulfilled" ? observations[2].value.id : null, observationsComplete: complete, activityCorrelationClaimed: false, orderObservationDisposition: terminal ? "terminal-order-observed" : "pending", accountReconciliationDisposition: "pending", pendingReason: terminal ? "account-content-not-correlated" : "order-nonterminal", observedAt: observationAuthority.now, strategySelectedByTransport: false, credentialsExported: false, liveVenueEffect: false }));
  };
  const provider = async (request) => {
    const references = { contract: { id: reference(request?.contractReference, "contract-reference") }, intent: { id: reference(request?.intentReference, "intent-reference") } };
    reference(request?.authorityGrantReference, "authority-grant-reference");
    const clientOrderId = paperClientOrderId(references), prior = locks.get(clientOrderId) ?? Promise.resolve();
    let release; const held = new Promise((resolveHeld) => { release = resolveHeld; }); const chain = prior.then(() => held); locks.set(clientOrderId, chain);
    await prior;
    try { return await executeLocked(request); }
    finally { release(); if (locks.get(clientOrderId) === chain) locks.delete(clientOrderId); }
  };
  Object.defineProperties(provider, { originatingActor: { value: "urn:ame:brokerage-execution-transport-service", enumerable: true }, preflight: { value: async (request) => { await resolve(request); }, enumerable: true }, externalEvidence: { value: (_request, output) => [{ uri: `urn:brokerage:paper-execution:${encodeURIComponent(output.clientOrderId)}`, digest: output.id }], enumerable: true } });
  return Object.freeze(provider);
}

const liveClientOrderId = ({ contract, intent }) => `live-${createHash("sha256").update(`${contract.id}:${intent.id}`).digest("hex").slice(0, 48)}`;
function validateLiveExecution({ contract, authorityGrant, intent, revocation, now }) {
  if (contract?.type !== "PrincipalBrokerageServiceContract" || intent?.type !== "AggressiveBrokerageOrderIntent" || intent.contract !== contract.id) throw new TypeError("contract-bound-live-intent-required");
  if (contract.venue !== "alpaca-trading-live" || authorityGrant?.type !== "RevocableBrokerageAuthorityGrant" || authorityGrant.adapter !== "alpaca-trading-live" || authorityGrant.revoked !== false || revocation?.effective === true || authorityGrant.principalContract !== contract.id) throw new TypeError("live-order-authority-refused");
  const required = ["account:read", "positions:read", "orders:read", "orders:live", "activities:read"];
  if (required.some((scope) => !contract.scopes?.includes(scope) || !authorityGrant.scopes?.includes(scope))) throw new TypeError("live-order-scope-refused");
  const executionTime = Date.parse(now), contractExpiry = Date.parse(contract.validUntil), grantExpiry = Date.parse(authorityGrant.validUntil);
  if (![executionTime, contractExpiry, grantExpiry].every(Number.isFinite)) throw new TypeError("live-order-authority-time-invalid");
  if (executionTime >= contractExpiry || executionTime >= grantExpiry) throw new TypeError("live-order-authority-expired");
  if (intent.notional > contract.risk.maximumOrderNotional || intent.maximumLoss > contract.risk.maximumLossAmount) throw new RangeError("live-execution-limit-exceeded");
}
export function createLiveExecutionAndReconciliationProvider({ resolveLiveExecutionRecords, adapter, clock = () => new Date().toISOString() }) {
  if (typeof resolveLiveExecutionRecords !== "function" || !["readAccount", "listPositions", "getOrderByClientOrderId", "placeOrder", "listActivities"].every((method) => typeof adapter?.[method] === "function")) throw new TypeError("live-execution-resolver-and-adapter-required");
  const locks = new Map();
  const resolve = async (request) => {
    const references = Object.freeze({ contractReference: reference(request?.contractReference, "contract-reference"), authorityGrantReference: reference(request?.authorityGrantReference, "authority-grant-reference"), intentReference: reference(request?.intentReference, "intent-reference") });
    const records = await resolveLiveExecutionRecords(references);
    if (records?.contract?.id !== references.contractReference || records?.authorityGrant?.id !== references.authorityGrantReference || records?.intent?.id !== references.intentReference) throw new TypeError("live-execution-resolved-record-reference-mismatch");
    const now = clock(); validateLiveExecution({ ...records, now }); return { references, records, now };
  };
  const pending = ({ records, now, clientOrderId, placement, reason, order = null, idempotent = false }) => Object.freeze(identify({ type: "AlpacaLiveExecutionAndReconciliationReceipt", version: 1, contract: records.contract.id, authorityGrant: records.authorityGrant.id, intent: records.intent.id, clientOrderId, idempotent, placementReceipt: placement?.id ?? null, placementStatus: placement?.status ?? null, orderReceipt: order?.id ?? null, orderVenueStatus: order?.payload?.status ?? null, accountReceipt: null, positionsReceipt: null, activitiesReceipt: null, observationsComplete: false, activityCorrelationClaimed: false, orderObservationDisposition: "pending", accountReconciliationDisposition: "pending", pendingReason: reason, observedAt: now, strategySelectedByTransport: false, credentialsExported: false, liveVenueEffect: true }));
  const executeLocked = async (request) => {
    const first = await resolve(request), clientOrderId = liveClientOrderId(first.records);
    const initialReceipt = await adapter.getOrderByClientOrderId({ grant: first.records.authorityGrant, clientOrderId, now: first.now });
    let order = correlatedOrder(initialReceipt, clientOrderId, "initial"), placement = null, idempotent = Boolean(order);
    if (!order) {
      const second = await resolve(request); // exact active authority immediately before the sole venue effect
      try { placement = await adapter.placeOrder({ grant: second.records.authorityGrant, order: { symbol: second.records.intent.symbol, side: second.records.intent.side, notional: second.records.intent.notional, type: "market", time_in_force: "day", client_order_id: clientOrderId }, operationAuthorizationReference: second.records.intent.id, now: second.now }); }
      catch { placement = null; }
      let post;
      try { post = await resolve(request); }
      catch { return pending({ records: second.records, now: second.now, clientOrderId, placement, reason: "post-effect-authority-unavailable" }); }
      let postReceipt;
      try { postReceipt = await adapter.getOrderByClientOrderId({ grant: post.records.authorityGrant, clientOrderId, now: post.now }); }
      catch { return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-lookup-unavailable" }); }
      if (postReceipt.status !== 404 && (!Number.isInteger(postReceipt.status) || postReceipt.status < 200 || postReceipt.status >= 300)) return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-lookup-refused" });
      order = correlatedOrder(postReceipt, clientOrderId, "post-effect");
      if (!order) return pending({ records: post.records, now: post.now, clientOrderId, placement, reason: "post-order-not-yet-observed" });
      first.records = post.records; first.now = post.now;
    }
    let observationAuthority;
    try { observationAuthority = await resolve(request); }
    catch { return pending({ records: first.records, now: first.now, clientOrderId, placement, order, idempotent, reason: "observation-authority-unavailable" }); }
    const observations = await Promise.allSettled([adapter.readAccount({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now }), adapter.listPositions({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now }), adapter.listActivities({ grant: observationAuthority.records.authorityGrant, now: observationAuthority.now })]);
    const complete = observations.every((result) => result.status === "fulfilled" && result.value.status >= 200 && result.value.status < 300);
    const terminal = TERMINAL_PAPER_ORDER_STATUSES.has(String(order.payload?.status ?? "").toLowerCase());
    return Object.freeze(identify({ type: "AlpacaLiveExecutionAndReconciliationReceipt", version: 1, contract: observationAuthority.records.contract.id, authorityGrant: observationAuthority.records.authorityGrant.id, intent: observationAuthority.records.intent.id, clientOrderId, idempotent, placementReceipt: placement?.id ?? null, placementStatus: placement?.status ?? null, orderReceipt: order.id, orderVenueStatus: order.payload.status, accountReceipt: observations[0].status === "fulfilled" ? observations[0].value.id : null, positionsReceipt: observations[1].status === "fulfilled" ? observations[1].value.id : null, activitiesReceipt: observations[2].status === "fulfilled" ? observations[2].value.id : null, observationsComplete: complete, activityCorrelationClaimed: false, orderObservationDisposition: terminal ? "terminal-order-observed" : "pending", accountReconciliationDisposition: "pending", pendingReason: terminal ? "account-content-not-correlated" : "order-nonterminal", observedAt: observationAuthority.now, strategySelectedByTransport: false, credentialsExported: false, liveVenueEffect: true }));
  };
  const provider = async (request) => {
    const references = { contract: { id: reference(request?.contractReference, "contract-reference") }, intent: { id: reference(request?.intentReference, "intent-reference") } };
    reference(request?.authorityGrantReference, "authority-grant-reference");
    const clientOrderId = liveClientOrderId(references), prior = locks.get(clientOrderId) ?? Promise.resolve();
    let release; const held = new Promise((resolveHeld) => { release = resolveHeld; }); const chain = prior.then(() => held); locks.set(clientOrderId, chain);
    await prior;
    try { return await executeLocked(request); }
    finally { release(); if (locks.get(clientOrderId) === chain) locks.delete(clientOrderId); }
  };
  Object.defineProperties(provider, { originatingActor: { value: "urn:ame:brokerage-execution-transport-service", enumerable: true }, preflight: { value: async (request) => { await resolve(request); }, enumerable: true }, externalEvidence: { value: (_request, output) => [{ uri: `urn:brokerage:live-execution:${encodeURIComponent(output.clientOrderId)}`, digest: output.id }], enumerable: true } });
  return Object.freeze(provider);
}
