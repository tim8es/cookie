/** Tenant-scoped Staff capabilities; caller supplies an authorized transaction. */
export {
  StaffCapacityReached,
  StaffInputError,
  StaffReferenceNotFound,
  StaffReplayConflict,
  createTenantDraftStaff,
  listTenantStaff,
  readTenantStaffCreateReceipt,
  validateStaffDraft,
} from "./draft-staff.js";

/** Explicit staging-only publication capability. */
export {
  publishStaffForStaging,
  StagingStaffPublicationConflict,
  type StagingStaffPublicationInput,
  type StagingStaffPublicationReceipt,
} from "./staging-publication.js";
