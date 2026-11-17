/** Tenant-scoped Location operations; caller supplies the authorized transaction. */
export {
  LocationCapacityExceeded,
  LocationInputError,
  LocationReplayConflict,
  createTenantLocation,
  listTenantLocations,
  validateCreateLocation,
} from "./locations.js";
