// Called only by the isolated real-owner browser smoke with a live API/DB.
import assert from "node:assert/strict";
import { evaluate, poll, requireDom, checkWidth } from "./browser-smoke.mjs";

export async function verifyOwnerBookingDetail(
  cdp,
  responses,
  { bookingId, duration, buffer, priceKopecks, status, tenantId, viewport },
) {
  const scope = ".owner-booking-detail[data-booking-id=" + JSON.stringify(bookingId) + "]";
  const root = "document.querySelector(" + JSON.stringify(scope) + ")";
  const path = "/v1/organizations/" + tenantId + "/owner-calendar/" + bookingId;
  const click = async (expanded) => {
    const expression = "(()=>{const b=" + root + "?.querySelector('button[aria-expanded=" +
      JSON.stringify(String(expanded)) + "]');if(!b||b.disabled)return false;b.click();return true;})()";
    assert.equal(await evaluate(cdp, expression), true, "Missing enabled detail toggle");
  };
  const load = async () => {
    // Read from the real HTTP response and rendered DOM, not the list projection.
    await requireDom(cdp, "detail toggle enabled", root + "?.querySelector('button[aria-expanded=false]')?.disabled===false");
    const offset = responses.length;
    await click(false);
    await poll("fresh owner booking detail HTTP 200", () =>
      responses.slice(offset).some((response) => response.path === path && response.status === 200));
    const fields = {
      "Номер записи": bookingId,
      "Статус": status,
      "Длительность": duration + " мин",
      "Буфер после услуги": buffer + " мин",
      "Стоимость записи": new Intl.NumberFormat("ru-RU", {
        style: "currency", currency: "RUB",
      }).format(Number(priceKopecks) / 100),
    };
    await requireDom(cdp, "verified snapshot detail", "(()=>{const dl=" + root +
      "?.querySelector('dl');if(!dl)return false;const fields=" + JSON.stringify(fields) +
      ";return Object.entries(fields).every(([key,value])=>[...dl.querySelectorAll('dt')].some(dt=>dt.textContent===key&&dt.nextElementSibling?.textContent===value));})()");
  };
  await load();
  for (const [width, height] of [[320, 568], [375, 812], [1280, 800]]) {
    await viewport(cdp, width, height);
    await checkWidth(cdp, "real owner booking detail " + width + "px");
  }
  await click(true);
  await requireDom(cdp, "closed detail clears snapshot", "!(" + root + "?.querySelector('dl'))");
  await load();
  await click(true);
  await requireDom(cdp, "reopened detail clears snapshot on close", "!(" + root + "?.querySelector('dl'))");
  console.log("PASS real owner booking detail: exact persisted snapshot, fresh GET on reopen, no overflow at 320/375/1280.");
}
