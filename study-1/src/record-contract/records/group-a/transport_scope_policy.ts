// `transport_scope_policy` (BR-RUA-028): the committed declaration of what a transport probe
// qualifies. Paths are normalized POSIX paths relative to the Study 1 project root.

export interface ConfigurationProjectionPolicy {
  /** snake_case name of the projection, for example `provider_function`. */
  readonly projection_id: string;
  /** CloudFormation resource type, for example `AWS::Lambda::Function`. */
  readonly resource_type: string;
  /** Dot-separated property paths, for example `Properties.Timeout`. */
  readonly property_paths: readonly [string, ...string[]];
}

export interface TransportScopePolicy {
  readonly schema_version: 1;
  readonly record_type: 'transport_scope_policy';
  readonly entry_points: readonly [string, ...string[]];
  readonly source_roots: readonly [string, ...string[]];
  readonly configuration_projections: readonly [ConfigurationProjectionPolicy, ...ConfigurationProjectionPolicy[]];
  readonly runtime_properties: readonly string[];
  /** npm package names whose resolved versions belong to the scope. */
  readonly dependencies: readonly [string, ...string[]];
}
