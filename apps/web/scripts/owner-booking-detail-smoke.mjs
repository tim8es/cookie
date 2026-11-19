// Called only by the isolated real-owner browser smoke with a live API/DB.
import assert from "node:assert/strict";
import { evaluate, poll, requireDom, checkWidth } from "./browser-smoke.mjs";

export async function verifyOwnerBookingDetail(
  cdp,
  responses,
  { bookingId, duration, buffer, priceKopecks, status, tenantId, viewport, testLatePeriod = false },
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
  if (testLatePeriod) {
    const dateInput = "document.querySelector('.owner-calendar input[type=date]')";
    const initialDate = await evaluate(cdp, dateInput + "?.value");
    const navigate = async (label) => {
      const button = "document.querySelector('.owner-calendar button[aria-label=" + JSON.stringify(label) + "]')";
      await requireDom(cdp, "calendar navigation available", button + "?.disabled===false");
      await evaluate(cdp, button + ".click()");
    };
    // Delay the genuine response AFTER reading its body. Even if the old
    // component aborts the request, release that exact response later.
    await evaluate(cdp, "(()=>{const send=window.fetch;window.__detailDelay={ready:false,released:false,restore:()=>{window.fetch=send;}};window.fetch=async function(input,init){const reply=await send.call(window,input,init);if(String(input).split('?')[0]!==" + JSON.stringify(path) + ")return reply;if(reply.status!==200)return reply;const body=await reply.text();const held=window.__detailDelay;held.ready=true;await new Promise(done=>{held.release=done;});held.released=true;return new Response(body,{status:200,headers:{'content-type':'application/json'}});};})()");
    try {
      await click(false);
      await requireDom(cdp, "real detail response retained for delay", "window.__detailDelay?.ready && !!window.__detailDelay.release");
      await navigate("Следующий период");
      await requireDom(cdp, "old period detail unmounted", "!(" + root + ") && " + dateInput + "?.value!==" + JSON.stringify(initialDate));
      await evaluate(cdp, "window.__detailDelay.release()");
      await requireDom(cdp, "late response released", "window.__detailDelay?.released===true");
      await navigate("Предыдущий период");
      await requireDom(cdp, "return to original period", dateInput + "?.value===" + JSON.stringify(initialDate) + " && " + root + "?.querySelector('button[aria-expanded=false]')?.disabled===false");
      assert.equal(await evaluate(cdp, "Boolean(" + root + "?.querySelector('dl'))"), false, "Late response must not restore stale detail");
    } finally {
      await evaluate(cdp, "(()=>{const held=window.__detailDelay;held?.release?.();held?.restore();delete window.__detailDelay;})()");
    }
    await load();
    await click(true);
    console.log("PASS owner detail late response discarded after calendar period change.");
  }
  console.log("PASS real owner booking detail: exact persisted snapshot, fresh GET on reopen, no overflow at 320/375/1280.");
}
