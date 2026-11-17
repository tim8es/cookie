/** Tenant-scoped Staff operations; caller supplies the authorized transaction. */
export {
  StaffInputError,
  StaffReferenceNotFound,
  StaffReplayConflict,
  createTenantDraftStaff,
  listTenantStaff,
  validateStaffDraft,
} from "./draft-staff.js";
