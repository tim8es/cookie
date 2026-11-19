import type { RealServiceDraft } from "./services-api";

interface RealServiceFormValues {
  serviceName: string;
  serviceDuration: number | undefined;
  servicePrice: number | undefined;
  serviceBuffer: number | undefined;
}

export function emptyRealServiceForm(): RealServiceFormValues {
  return {
    serviceName: "",
    serviceDuration: undefined,
    servicePrice: undefined,
    serviceBuffer: undefined,
  };
}

export function realServiceDraftFromForm(
  form: RealServiceFormValues,
): RealServiceDraft | null {
  const displayName = form.serviceName.trim().normalize("NFC");
  const { serviceDuration, servicePrice, serviceBuffer } = form;
  if (
    !displayName ||
    [...displayName].length > 200 ||
    typeof serviceDuration !== "number" ||
    !Number.isInteger(serviceDuration) ||
    serviceDuration < 1 ||
    serviceDuration > 1440 ||
    typeof servicePrice !== "number" ||
    !Number.isFinite(servicePrice) ||
    servicePrice !== Number(servicePrice.toFixed(2)) ||
    servicePrice < 0 ||
    servicePrice > 9_999_999_999.99 ||
    typeof serviceBuffer !== "number" ||
    !Number.isInteger(serviceBuffer) ||
    serviceBuffer < 0 ||
    serviceBuffer > 1440
  ) {
    return null;
  }
  return {
    displayName,
    durationMinutes: serviceDuration,
    basePriceKopecks: Math.round(servicePrice * 100),
    postServiceBufferMinutes: serviceBuffer,
  };
}
