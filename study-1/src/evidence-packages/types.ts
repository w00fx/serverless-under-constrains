export type ArtifactClassification = "primary" | "derived";

export type PackageStore = Map<string, Uint8Array>;

export type IndexEntry = {
  artifact_path: string;
  artifact_sha256: string;
  byte_count: number;
};

export type EvidenceIndexEntry = IndexEntry & {
  classification: ArtifactClassification;
};

export type EvidenceIndexRecord = {
  schema_version: 1;
  record_type: "evidence_index";
  entries: EvidenceIndexEntry[];
};

export type PackageIndexRecord = {
  schema_version: 1;
  record_type: "package_index";
  entries: IndexEntry[];
};

export type PrefixCheckpoint = {
  schema_version: 1;
  record_type: "coordination_prefix_checkpoint";
  path: string;
  prefix_byte_count: number;
  prefix_digest: string;
  last_included_event_id: string;
  last_included_sequence: number;
  checkpoint_time: string;
};

export type PackageVerification = {
  schema_version: 1;
  record_type: "package_verification";
  package_eligibility: "eligible" | "ineligible";
  package_ineligibility_reasons: string[];
  original_package_index_sha256: string;
  selected_amendment_head_sha256: null;
  evaluated_at: string;
};
