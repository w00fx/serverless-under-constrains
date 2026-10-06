// What the discovery surfaces of the leak audit report (BR-RUA-051, design §9.14) and the port
// that queries them. Production binds the port to the AWS listing and describe APIs
// (`aws/aws-discovery-surfaces.ts`); tests bind it to `StubDiscoverySurfaces`.
//
// A discovered resource is named the way CloudFormation records it in the resource manifest
// (its physical id), so manifest membership is a plain comparison (BR-RUA-050). Resources that
// CloudFormation never records (a durable execution, a DLQ message, a treatment item) use the
// service-qualified pseudo types of `resource-types.ts`.

import type { StructuredReason, UtcMillis } from '../record-contract/primitives.ts';
import type { LeakAuditSurface } from '../record-contract/records/group-c/vocabulary.ts';

/** One `key=value` resource tag as the service returned it. */
export interface ResourceTag {
  readonly key: string;
  readonly value: string;
}

/**
 * What is known about a resource's tags:
 * - `tagged`: the tags were read (possibly an empty list);
 * - `untaggable`: the resource type supports no tags (a durable execution, for example);
 * - `unknown`: the tags could not be read, so no tag-based ownership rule can hold.
 */
export type TagObservation =
  | { readonly kind: 'tagged'; readonly tags: readonly ResourceTag[] }
  | { readonly kind: 'untaggable' }
  | { readonly kind: 'unknown'; readonly reason: StructuredReason };

/** One resource a discovery surface observed. */
export interface DiscoveredResource {
  /** The CloudFormation resource type, for example `AWS::Lambda::Function`, or a pseudo type. */
  readonly resource_type: string;
  /** The physical id CloudFormation records: a name, a URL, a UUID or an ARN, by type. */
  readonly identifier: string;
  /** The surface that observed it. */
  readonly surface: LeakAuditSurface;
  readonly tags: TagObservation;
  /** The creation time, when the service reports one. */
  readonly created_at?: UtcMillis;
  /** The stack whose resource listing names this resource (the BR-RUA-050 stack boundary). */
  readonly managed_by_stack_id?: string;
}

/** The answer of one surface query: every resource it observed, or why the query failed. */
export type SurfaceQueryResult =
  | { readonly ok: true; readonly resources: readonly DiscoveredResource[] }
  | { readonly ok: false; readonly reason: StructuredReason };

/** A native describe of one resource the tag index listed (design §9.14 stale tag index). */
export type PresenceCheck =
  | { readonly kind: 'present' }
  | { readonly kind: 'absent' }
  | { readonly kind: 'failed'; readonly reason: StructuredReason };

/**
 * The discovery surfaces of one execution. The adapter is bound to the execution's discovery
 * targets when it is built, so a query names only the surface.
 */
export interface DiscoverySurfaces {
  /** Lists what one surface still observes; a failed query is a result, never a throw. */
  query(surface: LeakAuditSurface): Promise<SurfaceQueryResult>;
  /**
   * Describes a resource the tag index listed through its native API: the tag index can lag
   * behind a deletion, so a listed resource that the native API reports absent is stale.
   */
  confirmPresence(resource: DiscoveredResource): Promise<PresenceCheck>;
}
