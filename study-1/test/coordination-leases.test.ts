import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { STALE_BOUNDARY_MS } from "../src/coordination/identity.ts";
import { classifyLeaseForDestroy } from "../src/coordination/leases.ts";
import type { LeaseItem } from "../src/coordination/types.ts";

const NOW = new Date("2026-08-30T21:00:00.000Z");
const STALE = new Date(NOW.getTime() - STALE_BOUNDARY_MS).toISOString();
const FRESH = new Date(NOW.getTime() - STALE_BOUNDARY_MS + 1).toISOString();

function released(overrides: LeaseItem = {}): LeaseItem {
  return {
    lease_key: "study-1/123456789012/us-east-1",
    schema_version: 1,
    lease_status: "released",
    heartbeat: STALE,
    ...overrides,
  };
}

describe("destroy lease classification", () => {
  it("allows a released stale lease and an empty-looking released item", () => {
    assert.equal(classifyLeaseForDestroy(released(), NOW), "allow");
    assert.equal(classifyLeaseForDestroy(released({ schema_version: "1" }), NOW), "allow");
    assert.equal(classifyLeaseForDestroy(released({ heartbeat: null }), NOW), "allow");
    assert.equal(classifyLeaseForDestroy(released({ heartbeat: undefined }), NOW), "allow");
    assert.equal(
      classifyLeaseForDestroy(
        released({ owner_id: "probe-1", owner_kind: "TRANSPORT_PROBE" }),
        NOW,
      ),
      "allow",
    );
  });

  it("refuses active, non-stale, recovery-required, and unverifiable items", () => {
    assert.equal(
      classifyLeaseForDestroy(
        released({
          lease_status: undefined,
          owner_kind: "TRANSPORT_PROBE",
          owner_id: "probe-1",
        }),
        NOW,
      ),
      "active",
    );
    assert.equal(
      classifyLeaseForDestroy(released({ lease_status: undefined, owner_id: "probe-1" }), NOW),
      "active",
    );
    assert.equal(
      classifyLeaseForDestroy(
        released({ lease_status: undefined, owner_kind: "TRANSPORT_PROBE" }),
        NOW,
      ),
      "active",
    );
    assert.equal(classifyLeaseForDestroy(released({ heartbeat: FRESH }), NOW), "non_stale");
    assert.equal(
      classifyLeaseForDestroy(
        released({ heartbeat: new Date(NOW.getTime() + 1).toISOString() }),
        NOW,
      ),
      "non_stale",
    );
    assert.equal(
      classifyLeaseForDestroy(released({ lease_status: "recovery_required" }), NOW),
      "recovery_required",
    );
    assert.equal(
      classifyLeaseForDestroy(released({ lease_status: "unverified" }), NOW),
      "unverified",
    );
    assert.equal(
      classifyLeaseForDestroy(
        released({
          lease_status: "held",
          owner_kind: "TRANSPORT_PROBE",
          owner_id: "probe-1",
        }),
        NOW,
      ),
      "unverified",
    );
    assert.equal(
      classifyLeaseForDestroy(
        { lease_key: "study-1/123456789012/us-east-1", schema_version: 1 },
        NOW,
      ),
      "unverified",
    );
  });

  it("fails closed on malformed lease values", () => {
    assert.equal(classifyLeaseForDestroy(null as unknown as LeaseItem, NOW), "unverified");
    assert.equal(classifyLeaseForDestroy([] as unknown as LeaseItem, NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ lease_key: "" }), NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ lease_key: "   " }), NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ schema_version: "01" }), NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ lease_status: "" }), NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ heartbeat: "not-a-time" }), NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ heartbeat: "" }), NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ heartbeat: "2020" }), NOW), "unverified");
    assert.equal(
      classifyLeaseForDestroy(released({ heartbeat: "2020-01-01T00:00:00Z" }), NOW),
      "unverified",
    );
    assert.equal(classifyLeaseForDestroy(released({ owner_id: 42 }), NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ owner_kind: "" }), NOW), "unverified");
    assert.equal(classifyLeaseForDestroy(released({ owner_id: "   " }), NOW), "unverified");
  });
});
