// CloudFormation template samples shared by the scope unit cases and the scope fuzz properties
// (test/fuzz/transport-qualification/scope/, Owner amendment A-11).

// Each logical id's stable identity: its stack-relative construct path (configuration-projection.ts).
export const LOGICAL_ID_IDENTITIES = new Map([
  ['LedgerA1B2', 'ExperimentCore/Ledger/Resource'],
  ['QueueC3D4', 'ExperimentCore/Queue/Resource'],
]);

/** Members every plain object inherits from `Object.prototype`; the policy path pattern admits them. */
export const PROTOTYPE_MEMBER_NAMES = [
  'constructor',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
] as const;
