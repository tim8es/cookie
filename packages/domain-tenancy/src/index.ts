/** Tenant-scoped Location capabilities; caller owns authorization and transaction. */
export {
  LocationCapacityExceeded,
  LocationInputError,
  LocationReplayConflict,
  createTenantLocation,
  listTenantLocations,
  validateCreateLocation,
} from "./locations.js";
